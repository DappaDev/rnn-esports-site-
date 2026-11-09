/**
 * RNN E-Sports · Madden Companion App export receiver
 *
 * A Cloudflare Worker with a D1 database (binding name: DB).
 * Secret setting: EXPORT_KEY (any long random string).
 *
 * In the Madden Companion App, the commissioner enters this export URL:
 *   https://<your-worker>.workers.dev/<EXPORT_KEY>
 * The app then POSTs JSON to paths under it, such as:
 *   /<EXPORT_KEY>/<platform>/<leagueId>/leagueteams
 *   /<EXPORT_KEY>/<platform>/<leagueId>/standings
 *   /<EXPORT_KEY>/<platform>/<leagueId>/week/<reg|pre>/<n>/<schedules|teamstats|passing|rushing|receiving|defense|kicking|punting>
 *   /<EXPORT_KEY>/<platform>/<leagueId>/team/<teamId>/roster
 *   /<EXPORT_KEY>/<platform>/<leagueId>/freeagents/roster
 *
 * The website reads:
 *   GET /api/league   -> teams, standings, games and stat leaders (public, cached ~60s)
 *   GET /api/health   -> ok + last export time
 *   GET /<EXPORT_KEY>/debug -> what was received and the field names in each export type
 */

const MAX_BODY = 25 * 1024 * 1024; // 25 MB
const STAT_TYPES = ["passing", "rushing", "receiving", "defense", "kicking", "punting"];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS teams (team_id INTEGER PRIMARY KEY, abbr TEXT, city TEXT, nick TEXT, display TEXT, user_name TEXT, div_name TEXT, updated TEXT)`,
  `CREATE TABLE IF NOT EXISTS standings (team_id INTEGER PRIMARY KEY, wins INTEGER, losses INTEGER, ties INTEGER, pts_for INTEGER, pts_against INTEGER, win_pct REAL, rank INTEGER, seed INTEGER, div_name TEXT, conf_name TEXT, updated TEXT)`,
  `CREATE TABLE IF NOT EXISTS games (season INTEGER, stage INTEGER, week INTEGER, away_id INTEGER, home_id INTEGER, away_score INTEGER, home_score INTEGER, status INTEGER, schedule_id INTEGER, updated TEXT, PRIMARY KEY (season, stage, week, away_id, home_id))`,
  `CREATE TABLE IF NOT EXISTS pstats (season INTEGER, stage INTEGER, week INTEGER, type TEXT, roster_id INTEGER, team_id INTEGER, name TEXT, data TEXT, updated TEXT, PRIMARY KEY (season, stage, week, type, roster_id))`,
  `CREATE TABLE IF NOT EXISTS exports (kind TEXT PRIMARY KEY, path TEXT, items INTEGER, fields TEXT, received TEXT)`,
];

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  schemaReady = true;
}

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const int = (v) => (v === undefined || v === null || v === "" || isNaN(+v) ? null : Math.trunc(+v));
const num = (v) => (v === undefined || v === null || v === "" || isNaN(+v) ? null : +v);
const now = () => new Date().toISOString();

async function readBody(request) {
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.byteLength > MAX_BODY) throw new Error("Export is larger than 25 MB");
  let bytes = buf;
  // Some app versions send gzip without saying so; detect by magic bytes.
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const text = new TextDecoder().decode(bytes).trim();
  return text ? JSON.parse(text) : {};
}

// Find the first array in the body whose key ends with "InfoList" (or the expected key).
function listFrom(body, preferred) {
  if (preferred && Array.isArray(body[preferred])) return body[preferred];
  for (const [k, v] of Object.entries(body || {})) if (Array.isArray(v) && /InfoList$/.test(k)) return v;
  return [];
}

async function logExport(db, kind, path, items) {
  const fields = items.length ? Object.keys(items[0]).slice(0, 120).join(",") : "";
  await db
    .prepare(`INSERT INTO exports (kind, path, items, fields, received) VALUES (?1, ?2, ?3, ?4, ?5)
              ON CONFLICT(kind) DO UPDATE SET path=?2, items=?3, fields=?4, received=?5`)
    .bind(kind, path, items.length, fields, now())
    .run();
}

async function runBatches(db, stmts) {
  for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
}

async function handleExport(db, segs, body, path) {
  // segs: [platform, leagueId, ...rest]
  const rest = segs.slice(2);
  const t = now();

  if (rest[0] === "leagueteams") {
    const items = listFrom(body, "leagueTeamInfoList");
    await runBatches(db, items.map((x) =>
      db.prepare(`INSERT INTO teams VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
        ON CONFLICT(team_id) DO UPDATE SET abbr=?2, city=?3, nick=?4, display=?5, user_name=?6, div_name=?7, updated=?8`)
        .bind(int(x.teamId), x.abbrName ?? null, x.cityName ?? null, x.nickName ?? null, x.displayName ?? null,
              x.userName ?? null, x.divName ?? null, t)));
    await logExport(db, "leagueteams", path, items);
    return items.length;
  }

  if (rest[0] === "standings") {
    const items = listFrom(body, "teamStandingInfoList");
    await runBatches(db, items.map((x) =>
      db.prepare(`INSERT INTO standings VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
        ON CONFLICT(team_id) DO UPDATE SET wins=?2, losses=?3, ties=?4, pts_for=?5, pts_against=?6, win_pct=?7, rank=?8, seed=?9, div_name=?10, conf_name=?11, updated=?12`)
        .bind(int(x.teamId), int(x.totalWins), int(x.totalLosses), int(x.totalTies), int(x.ptsFor), int(x.ptsAgainst),
              num(x.winPct), int(x.rank), int(x.seed), x.divisionName ?? x.divName ?? null, x.conferenceName ?? null, t)));
    await logExport(db, "standings", path, items);
    return items.length;
  }

  if (rest[0] === "week" && rest.length >= 4) {
    const weekType = String(rest[1]).toLowerCase();
    const urlStage = weekType.startsWith("pre") ? 0 : 1;
    const urlWeek = int(rest[2]);
    const dataType = String(rest[3]).toLowerCase();

    if (dataType === "schedules") {
      const items = listFrom(body, "gameScheduleInfoList");
      await runBatches(db, items.map((x) => {
        const stage = int(x.stageIndex) ?? urlStage;
        const week = urlWeek ?? (int(x.weekIndex) ?? 0) + 1;
        return db.prepare(`INSERT INTO games VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
          ON CONFLICT(season, stage, week, away_id, home_id) DO UPDATE SET away_score=?6, home_score=?7, status=?8, schedule_id=?9, updated=?10`)
          .bind(int(x.seasonIndex) ?? 0, stage, week, int(x.awayTeamId), int(x.homeTeamId),
                int(x.awayScore), int(x.homeScore), int(x.status), int(x.scheduleId), t);
      }));
      await logExport(db, "schedules", path, items);
      return items.length;
    }

    if (STAT_TYPES.includes(dataType)) {
      const key = dataType === "defense" ? "playerDefensiveStatInfoList"
        : `player${dataType[0].toUpperCase()}${dataType.slice(1)}StatInfoList`;
      const items = listFrom(body, key);
      await runBatches(db, items.map((x) =>
        db.prepare(`INSERT INTO pstats VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
          ON CONFLICT(season, stage, week, type, roster_id) DO UPDATE SET team_id=?6, name=?7, data=?8, updated=?9`)
          .bind(int(x.seasonIndex) ?? 0, int(x.stageIndex) ?? urlStage, urlWeek ?? (int(x.weekIndex) ?? 0) + 1,
                dataType, int(x.rosterId), int(x.teamId), x.fullName ?? null, JSON.stringify(x), t)));
      await logExport(db, dataType, path, items);
      return items.length;
    }

    // teamstats and anything new: note it, keep nothing else.
    const items = listFrom(body);
    await logExport(db, dataType, path, items);
    return items.length;
  }

  if (rest.includes("roster")) {
    // Rosters are large and not shown on the site yet; record that they arrived.
    const items = listFrom(body, "rosterInfoList");
    await logExport(db, rest[0] === "freeagents" ? "freeagents" : "roster", path, items);
    return items.length;
  }

  const items = listFrom(body);
  await logExport(db, rest.join("/") || "unknown", path, items);
  return items.length;
}

// Season-total leaders, regular season only, current (latest) season.
const LEADERS = [
  { id: "passYds", label: "Passing yards", type: "passing", field: "passYds" },
  { id: "passTDs", label: "Passing TDs", type: "passing", field: "passTDs" },
  { id: "rushYds", label: "Rushing yards", type: "rushing", field: "rushYds" },
  { id: "recYds", label: "Receiving yards", type: "receiving", field: "recYds" },
  { id: "defSacks", label: "Sacks", type: "defense", field: "defSacks" },
  { id: "defInts", label: "Interceptions", type: "defense", field: "defInts" },
];

async function buildLeague(db) {
  const seasonRow = await db.prepare(`SELECT MAX(season) AS s FROM games`).first();
  const season = seasonRow?.s ?? 0;
  const [teams, standings, games, meta] = await Promise.all([
    db.prepare(`SELECT team_id AS id, abbr, city, nick, display, user_name AS user, div_name AS div FROM teams`).all(),
    db.prepare(`SELECT team_id AS id, wins AS w, losses AS l, ties AS t, pts_for AS pf, pts_against AS pa, rank, seed, div_name AS div, conf_name AS conf FROM standings`).all(),
    db.prepare(`SELECT stage, week, away_id AS a, home_id AS h, away_score AS as_, home_score AS hs, status FROM games WHERE season = ?1 ORDER BY stage, week`).bind(season).all(),
    db.prepare(`SELECT MAX(received) AS last FROM exports`).first(),
  ]);
  const leaders = {};
  for (const L of LEADERS) {
    const r = await db.prepare(
      `SELECT name, team_id AS team, SUM(COALESCE(json_extract(data, '$.' || ?1), 0)) AS v
       FROM pstats WHERE season = ?2 AND stage = 1 AND type = ?3
       GROUP BY roster_id HAVING v > 0 ORDER BY v DESC LIMIT 5`).bind(L.field, season, L.type).all();
    leaders[L.id] = { label: L.label, rows: r.results.map((x) => ({ name: x.name, team: x.team, v: Math.round(x.v * 10) / 10 })) };
  }
  return {
    updated: meta?.last ?? null,
    season,
    teams: teams.results,
    standings: standings.results,
    games: games.results.map((g) => ({ stage: g.stage, week: g.week, a: g.a, h: g.h, as: g.as_, hs: g.hs, status: g.status })),
    leaders,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const segs = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (!env.DB) return json({ error: "The D1 database is not connected. Add a D1 binding named DB." }, 500, CORS);
    await ensureSchema(env.DB);

    if (request.method === "GET" && segs[0] === "api") {
      if (segs[1] === "health") {
        const m = await env.DB.prepare(`SELECT MAX(received) AS last FROM exports`).first();
        return json({ ok: true, lastExport: m?.last ?? null }, 200, CORS);
      }
      if (segs[1] === "league") {
        const cache = caches.default;
        const cacheKey = new Request(url.origin + "/api/league", { method: "GET" });
        const hit = await cache.match(cacheKey);
        if (hit) return hit;
        const res = json(await buildLeague(env.DB), 200, { ...CORS, "cache-control": "public, max-age=60" });
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      }
      return json({ error: "Not found" }, 404, CORS);
    }

    const key = env.EXPORT_KEY;
    if (!key || key.length < 12) return json({ error: "EXPORT_KEY is not set (use 12+ characters)." }, 500);

    if (segs[0] === key && segs[1] === "debug" && request.method === "GET") {
      const rows = await env.DB.prepare(`SELECT kind, path, items, fields, received FROM exports ORDER BY received DESC`).all();
      return json({ exports: rows.results });
    }

    if (request.method === "POST" && segs[0] === key && segs.length >= 3) {
      try {
        const body = await readBody(request);
        const count = await handleExport(env.DB, segs.slice(1), body, "/" + segs.slice(1).join("/"));
        ctx.waitUntil(caches.default.delete(new Request(url.origin + "/api/league")));
        return json({ success: true, items: count });
      } catch (e) {
        // Answer 200 so the app moves on to the next export; the error shows in the Worker logs.
        console.error("Export failed", url.pathname.replace(key, "***"), e && e.message);
        return json({ success: false, error: String(e && e.message) });
      }
    }

    if (request.method === "GET" && segs.length === 0) {
      return new Response("RNN E-Sports league data receiver is running.", { headers: { "content-type": "text/plain" } });
    }
    return json({ error: "Not found" }, 404);
  },
};
