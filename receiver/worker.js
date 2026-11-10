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
 *
 * The members area (Discord sign-in) is further down: see MEMBERS AREA.
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
  await db.batch([...SCHEMA, ...MEMBER_SCHEMA, ...FAN_SCHEMA].map((s) => db.prepare(s)));
  const colsOf = {};
  for (const a of MEMBER_ALTERS) {
    const table = a.split("ALTER TABLE ")[1].split(" ")[0], col = a.split("ADD COLUMN ")[1].split(" ")[0];
    colsOf[table] ??= (await db.prepare(`PRAGMA table_info(${table})`).all()).results.map((c) => c.name);
    if (!colsOf[table].includes(col)) await db.prepare(a).run();
  }
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

/* =====================================================================
 * MEMBERS AREA (the Locker Room)
 * Discord sign-in, approved members only.
 *
 * Settings on the Worker:
 *   DISCORD_CLIENT_ID      (variable)  from the Discord Developer Portal
 *   DISCORD_CLIENT_SECRET  (secret)    from the Discord Developer Portal
 *   SITE_URL               (variable)  e.g. https://dappadev.github.io/rnn-esports-site-/
 *   COMMISSIONERS          (variable)  Discord usernames with full control, comma-separated
 * Optional, to tie access to the league's Discord server:
 *   DISCORD_GUILD_ID         (variable)  the RNN server's ID: only server members get in
 *   DISCORD_COACH_ROLE_ID    (variable)  if set, members also need this role (e.g. @Coach)
 *   DISCORD_COMMISH_ROLE_ID  (variable)  members with this role are site commissioners
 *   DISCORD_INVITE_URL       (variable)  invite link shown on the site
 *   WEBHOOK_ANNOUNCEMENTS    (secret)    channel webhook: site announcements are posted here
 *   WEBHOOK_SCHEDULE         (secret)    channel webhook: confirmed game times are posted here
 *   WEBHOOK_SIGNUPS          (secret)    channel webhook: new Locker Room sign-ins are posted here
 * ===================================================================== */

const MEMBER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, username TEXT, display TEXT, avatar TEXT, status TEXT, role TEXT, teams TEXT, created TEXT, last_login TEXT)`,
  `CREATE TABLE IF NOT EXISTS invites (username TEXT PRIMARY KEY, added_by TEXT, created TEXT)`,
  `CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, created INTEGER)`,
  `CREATE TABLE IF NOT EXISTS login_codes (code TEXT PRIMARY KEY, member_id TEXT, created INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, member_id TEXT, created INTEGER, expires INTEGER)`,
  `CREATE TABLE IF NOT EXISTS announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, pinned INTEGER, author_id TEXT, created TEXT)`,
  `CREATE TABLE IF NOT EXISTS threads (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, author_id TEXT, created TEXT, last_activity TEXT, reply_count INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS replies (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER, body TEXT, author_id TEXT, created TEXT)`,
  `CREATE TABLE IF NOT EXISTS game_times (game_key TEXT PRIMARY KEY, status TEXT, starts_at TEXT, note TEXT, proposed_by TEXT, proposer_team TEXT, confirmed_by TEXT, updated TEXT)`,
];

const FAN_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS motw_votes (matchup TEXT, voter TEXT, ip TEXT, side TEXT, at TEXT, PRIMARY KEY (matchup, voter))`,
  `CREATE TABLE IF NOT EXISTS talk (id INTEGER PRIMARY KEY AUTOINCREMENT, author_id TEXT, target TEXT, body TEXT, created TEXT)`,
  `CREATE TABLE IF NOT EXISTS talk_reacts (post_id INTEGER, member_id TEXT, emoji TEXT, PRIMARY KEY (post_id, member_id, emoji))`,
  `CREATE TABLE IF NOT EXISTS highlights (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT, vid TEXT, title TEXT, submitted_by TEXT, status TEXT, created TEXT, reviewed_by TEXT)`,
];

const MEMBER_ALTERS = [
  `ALTER TABLE members ADD COLUMN override TEXT`,   // 'approved' / 'removed' set by a commissioner on the site
  `ALTER TABLE members ADD COLUMN role_site INTEGER`, // 1 when a commissioner set the role on the site
  `ALTER TABLE members ADD COLUMN gate TEXT`,       // why Discord didn't let them in: not_in_server / no_role
  `ALTER TABLE members ADD COLUMN fan INTEGER`,     // 1 = signed in only to join the fan trash talk
  `ALTER TABLE oauth_states ADD COLUMN purpose TEXT`, // 'fan' when sign-in started from the trash-talk board
];
const SESSION_DAYS = 14;
const TEAM_NAMES = { ARI: "Cardinals", ATL: "Falcons", BAL: "Ravens", BUF: "Bills", CAR: "Panthers", CHI: "Bears", CIN: "Bengals", CLE: "Browns", DAL: "Cowboys", DEN: "Broncos", DET: "Lions", GB: "Packers", HOU: "Texans", IND: "Colts", JAX: "Jaguars", KC: "Chiefs", LV: "Raiders", LAC: "Chargers", LAR: "Rams", MIA: "Dolphins", MIN: "Vikings", NE: "Patriots", NO: "Saints", NYG: "Giants", NYJ: "Jets", PHI: "Eagles", PIT: "Steelers", SF: "49ers", SEA: "Seahawks", TB: "Buccaneers", TEN: "Titans", WAS: "Commanders" };

// Post to a Discord channel webhook. Mentions are disabled so nothing pings @everyone.
async function discordPost(url, embed) {
  if (!url || !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(url)) return;
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "RNN E-Sports", allowed_mentions: { parse: [] }, embeds: [embed] }) });
    if (!res.ok) console.error("Discord post failed", res.status);
  } catch (e) { console.error("Discord post failed", e && e.message); }
}
const siteLink = (env, hash) => env.SITE_URL ? env.SITE_URL.split("#")[0] + "#" + hash : undefined;
function postGameTime(env, ctx, key, iso) {
  const g = GAME_KEY.exec(key); if (!g) return;
  const unix = Math.floor(new Date(iso).getTime() / 1000);
  ctx.waitUntil(discordPost(env.WEBHOOK_SCHEDULE, {
    title: `Week ${g[1]}: ${TEAM_NAMES[g[2]] || g[2]} @ ${TEAM_NAMES[g[3]] || g[3]}`,
    description: `Game time confirmed: <t:${unix}:F> (<t:${unix}:R>)`, color: 0x8fc1e3, url: siteLink(env, "schedule"),
  }));
}
const TEAM_ABBRS = new Set("ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC LV LAC LAR MIA MIN NE NO NYG NYJ PHI PIT SF SEA TB TEN WAS".split(" "));
const GAME_KEY = /^W([1-9]|1[0-8])-([A-Z]{2,3})@([A-Z]{2,3})$/;

const randomToken = (bytes = 32) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const clean = (v, max) => String(v ?? "").replace(/\u0000/g, "").trim().slice(0, max);
const commissioners = (env) => String(env.COMMISSIONERS || "").toLowerCase().split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
const siteOrigin = (env) => { try { return new URL(env.SITE_URL).origin; } catch { return ""; } };

function corsFor(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = siteOrigin(env);
  // Members endpoints only answer the league site (and local previews while testing).
  const ok = origin && (origin === allowed || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  return ok ? {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    vary: "origin",
  } : { vary: "origin" };
}

const publicMember = (m) => m && ({
  id: m.id, username: m.username, display: m.display || m.username, avatar: m.avatar,
  status: m.status, role: m.role, teams: (m.teams || "").split(",").filter(Boolean), gate: m.gate || null, fan: !!m.fan,
});

async function currentMember(request, db) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || token.length < 32) return null;
  const s = await db.prepare(`SELECT member_id, expires FROM sessions WHERE token_hash = ?1`).bind(await sha256(token)).first();
  if (!s || s.expires < Date.now()) return null;
  return await db.prepare(`SELECT * FROM members WHERE id = ?1`).bind(s.member_id).first();
}

async function readJson(request) {
  const t = await request.text();
  if (t.length > 20000) throw new Error("too_large");
  return t ? JSON.parse(t) : {};
}

async function handleAuth(request, env, url, segs, ctx) {
  const db = env.DB;
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.SITE_URL)
    return json({ error: "Discord sign-in isn't set up yet. Add DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and SITE_URL to the Worker." }, 500);
  const redirectUri = url.origin + "/auth/discord/callback";

  if (segs[2] === "login") {
    const state = randomToken(16);
    await db.prepare(`DELETE FROM oauth_states WHERE created < ?1`).bind(Date.now() - 600000).run();
    await db.prepare(`INSERT INTO oauth_states (state, created, purpose) VALUES (?1, ?2, ?3)`).bind(state, Date.now(), url.searchParams.get("for") === "fan" ? "fan" : null).run();
    const q = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, redirect_uri: redirectUri, response_type: "code", scope: env.DISCORD_GUILD_ID ? "identify guilds.members.read" : "identify", state, prompt: "none" });
    return Response.redirect("https://discord.com/oauth2/authorize?" + q, 302);
  }

  if (segs[2] === "callback") {
    const back = (msg) => Response.redirect(env.SITE_URL.split("#")[0] + "#login-error=" + encodeURIComponent(msg), 302);
    const code = url.searchParams.get("code"), state = url.searchParams.get("state");
    if (url.searchParams.get("error")) return back("cancelled");
    if (!code || !state) return back("missing");
    const st = await db.prepare(`SELECT created, purpose FROM oauth_states WHERE state = ?1`).bind(state).first();
    await db.prepare(`DELETE FROM oauth_states WHERE state = ?1`).bind(state).run();
    if (!st || st.created < Date.now() - 600000) return back("expired");

    const tokRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    });
    if (!tokRes.ok) return back("discord");
    const tok = await tokRes.json();
    const meRes = await fetch("https://discord.com/api/users/@me", { headers: { authorization: `Bearer ${tok.access_token}` } });
    if (!meRes.ok) return back("discord");
    const du = await meRes.json();

    const id = String(du.id), username = String(du.username || "").toLowerCase();
    const display = du.global_name || du.username || "Coach";
    const avatar = du.avatar ? `https://cdn.discordapp.com/avatars/${id}/${du.avatar}.png?size=128` : null;
    const t = now();

    // Discord server check (when DISCORD_GUILD_ID is set)
    const guildMode = !!env.DISCORD_GUILD_ID;
    let inServer = false, roles = [], serverNick = null;
    if (guildMode) {
      const gm = await fetch(`https://discord.com/api/users/@me/guilds/${env.DISCORD_GUILD_ID}/member`, { headers: { authorization: `Bearer ${tok.access_token}` } });
      if (gm.ok) { const g = await gm.json(); inServer = true; roles = (g.roles || []).map(String); serverNick = g.nick || null; }
      else if (gm.status !== 404) return back("discord");
    }
    const coachRole = String(env.DISCORD_COACH_ROLE_ID || "").trim(), commishRole = String(env.DISCORD_COMMISH_ROLE_ID || "").trim();
    const hasCommishRole = inServer && !!commishRole && roles.includes(commishRole);
    const isCommish = commissioners(env).includes(username) || hasCommishRole;
    const passesDiscord = !guildMode || (inServer && (!coachRole || roles.includes(coachRole) || hasCommishRole));
    const gate = !guildMode || isCommish || passesDiscord ? null : (!inServer ? "not_in_server" : "no_role");

    const invited = await db.prepare(`SELECT username FROM invites WHERE username = ?1`).bind(username).first();
    const existing = await db.prepare(`SELECT * FROM members WHERE id = ?1`).bind(id).first();
    const override = existing?.override || (invited ? "approved" : null);
    let status;
    if (isCommish) status = "approved";
    else if (override === "removed") status = "removed";
    else if (override === "approved") status = "approved";
    else if (guildMode) status = passesDiscord ? "approved" : "pending";
    else status = existing?.status === "approved" ? "approved" : "pending";
    let role = existing?.role || "member";
    if (isCommish) role = "admin";
    else if (role === "admin" && !existing?.role_site) role = "member"; // lost the Discord commissioner role
    const name = serverNick || display;
    // Fans who sign in just to talk trash don't land in the approval queue.
    // Signing in from the Locker Room later puts them in the queue.
    const fan = status !== "approved" && st.purpose === "fan" ? 1 : 0;

    if (existing) {
      await db.prepare(`UPDATE members SET username=?2, display=?3, avatar=?4, status=?5, role=?6, last_login=?7, gate=?8, override=?9, fan=?10 WHERE id=?1`)
        .bind(id, username, name, avatar, status, role, t, status === "approved" ? null : gate, override, fan).run();
    } else {
      await db.prepare(`INSERT INTO members (id, username, display, avatar, status, role, teams, created, last_login, override, role_site, gate, fan) VALUES (?1,?2,?3,?4,?5,?6,'',?7,?7,?8,0,?9,?10)`)
        .bind(id, username, name, avatar, status, role, t, override, status === "approved" ? null : gate, fan).run();
    }
    // Let the commissioners' channel know about new arrivals.
    const firstTime = !existing || (existing.status !== status && status !== "removed") || (!!existing.fan && !fan);
    if (firstTime && !isCommish && status !== "removed" && !fan) {
      const why = gate === "not_in_server" ? "They aren't in the RNN Discord server yet." : gate === "no_role" ? "They don't have the Coach role yet." : null;
      ctx.waitUntil(discordPost(env.WEBHOOK_SIGNUPS, status === "approved"
        ? { title: `${name} joined the Locker Room`, description: `@${username} is in. Assign their team in Commissioner tools.`, color: 0xe8ff1a, url: siteLink(env, "locker") }
        : { title: `${name} is waiting for approval`, description: `@${username} signed in to the Locker Room. ${why || "Approve them in Commissioner tools."}`, color: 0xa9b8c4, url: siteLink(env, "locker") }));
    }
    const loginCode = randomToken(24);
    await db.prepare(`DELETE FROM login_codes WHERE created < ?1`).bind(Date.now() - 120000).run();
    await db.prepare(`INSERT INTO login_codes VALUES (?1, ?2, ?3)`).bind(loginCode, id, Date.now()).run();
    return Response.redirect(env.SITE_URL.split("#")[0] + "#login=" + loginCode, 302);
  }
  return json({ error: "Not found" }, 404);
}

async function handleMembersApi(request, env, segs, cors, ctx) {
  const db = env.DB, M = request.method, t = now();
  const ok = (o, s = 200) => json(o, s, cors);
  const err = (msg, s = 400) => json({ error: msg }, s, cors);
  const route = segs.slice(1); // after "api"

  // Exchange the one-time login code for a session token.
  if (route[0] === "session" && M === "POST") {
    const { code } = await readJson(request);
    if (!code || typeof code !== "string") return err("Missing sign-in code.");
    const row = await db.prepare(`SELECT member_id, created FROM login_codes WHERE code = ?1`).bind(code).first();
    await db.prepare(`DELETE FROM login_codes WHERE code = ?1`).bind(code).run();
    if (!row || row.created < Date.now() - 120000) return err("That sign-in link expired. Please sign in again.", 401);
    const token = randomToken(32);
    await db.prepare(`INSERT INTO sessions VALUES (?1, ?2, ?3, ?4)`).bind(await sha256(token), row.member_id, Date.now(), Date.now() + SESSION_DAYS * 864e5).run();
    const m = await db.prepare(`SELECT * FROM members WHERE id = ?1`).bind(row.member_id).first();
    return ok({ token, member: publicMember(m) });
  }

  const me = await currentMember(request, db);

  // Fan zone: public reads, voting without an account, trash talk for anyone signed in.
  const fanRes = await handleFanApi(request, env, route, me, ok, err);
  if (fanRes) return fanRes;

  if (!me) return err("Please sign in.", 401);

  if (route[0] === "me" && M === "GET") return ok({ member: publicMember(me) });
  if (route[0] === "logout" && M === "POST") {
    const token = (request.headers.get("authorization") || "").slice(7).trim();
    await db.prepare(`DELETE FROM sessions WHERE token_hash = ?1`).bind(await sha256(token)).run();
    return ok({ success: true });
  }

  if (me.status !== "approved") return err(me.status === "removed" ? "Your access was removed by the commissioner." : "Your account is waiting for the commissioner's approval.", 403);
  const isAdmin = me.role === "admin";
  const myTeams = (me.teams || "").split(",").filter(Boolean);
  const authorMap = async (ids) => {
    const uniq = [...new Set(ids.filter(Boolean))];
    if (!uniq.length) return {};
    const rows = await db.prepare(`SELECT id, display, username, avatar, teams FROM members WHERE id IN (${uniq.map((_, i) => "?" + (i + 1)).join(",")})`).bind(...uniq).all();
    return Object.fromEntries(rows.results.map((r) => [r.id, { display: r.display || r.username, avatar: r.avatar, teams: (r.teams || "").split(",").filter(Boolean) }]));
  };

  // ---- Announcements ----
  if (route[0] === "announcements") {
    if (M === "GET") {
      const r = await db.prepare(`SELECT * FROM announcements ORDER BY pinned DESC, id DESC LIMIT 50`).all();
      const a = await authorMap(r.results.map((x) => x.author_id));
      return ok({ announcements: r.results.map((x) => ({ id: x.id, title: x.title, body: x.body, pinned: !!x.pinned, created: x.created, author: a[x.author_id] || null })) });
    }
    if (!isAdmin) return err("Only the commissioner can do that.", 403);
    if (M === "POST" && !route[1]) {
      const b = await readJson(request);
      const title = clean(b.title, 120), body = clean(b.body, 4000);
      if (!title || !body) return err("Add a title and a message.");
      const r = await db.prepare(`INSERT INTO announcements (title, body, pinned, author_id, created) VALUES (?1,?2,?3,?4,?5) RETURNING id`).bind(title, body, b.pinned ? 1 : 0, me.id, t).first();
      if (b.discord !== false) ctx.waitUntil(discordPost(env.WEBHOOK_ANNOUNCEMENTS, { title, description: body, color: 0xe8ff1a, url: siteLink(env, "locker"), footer: { text: `Posted by ${me.display || me.username} on the RNN site` } }));
      return ok({ id: r.id }, 201);
    }
    if (M === "DELETE" && route[1]) { await db.prepare(`DELETE FROM announcements WHERE id = ?1`).bind(+route[1]).run(); return ok({ success: true }); }
  }

  // ---- Message board ----
  if (route[0] === "threads") {
    if (M === "GET" && !route[1]) {
      const r = await db.prepare(`SELECT id, title, author_id, created, last_activity, reply_count FROM threads ORDER BY last_activity DESC LIMIT 100`).all();
      const a = await authorMap(r.results.map((x) => x.author_id));
      return ok({ threads: r.results.map((x) => ({ ...x, author: a[x.author_id] || null })) });
    }
    if (M === "POST" && !route[1]) {
      const b = await readJson(request);
      const title = clean(b.title, 120), body = clean(b.body, 4000);
      if (!title || !body) return err("Add a title and a message.");
      const r = await db.prepare(`INSERT INTO threads (title, body, author_id, created, last_activity, reply_count) VALUES (?1,?2,?3,?4,?4,0) RETURNING id`).bind(title, body, me.id, t).first();
      return ok({ id: r.id }, 201);
    }
    const tid = +route[1];
    if (route[1] && M === "GET") {
      const th = await db.prepare(`SELECT * FROM threads WHERE id = ?1`).bind(tid).first();
      if (!th) return err("That thread was removed.", 404);
      const rs = await db.prepare(`SELECT * FROM replies WHERE thread_id = ?1 ORDER BY id ASC LIMIT 500`).bind(tid).all();
      const a = await authorMap([th.author_id, ...rs.results.map((x) => x.author_id)]);
      return ok({
        thread: { id: th.id, title: th.title, body: th.body, created: th.created, author: a[th.author_id] || null, mine: th.author_id === me.id },
        replies: rs.results.map((x) => ({ id: x.id, body: x.body, created: x.created, author: a[x.author_id] || null, mine: x.author_id === me.id })),
      });
    }
    if (route[1] && route[2] === "replies" && M === "POST") {
      const th = await db.prepare(`SELECT id FROM threads WHERE id = ?1`).bind(tid).first();
      if (!th) return err("That thread was removed.", 404);
      const body = clean((await readJson(request)).body, 4000);
      if (!body) return err("Write a reply first.");
      await db.batch([
        db.prepare(`INSERT INTO replies (thread_id, body, author_id, created) VALUES (?1,?2,?3,?4)`).bind(tid, body, me.id, t),
        db.prepare(`UPDATE threads SET last_activity = ?2, reply_count = reply_count + 1 WHERE id = ?1`).bind(tid, t),
      ]);
      return ok({ success: true }, 201);
    }
    if (route[1] && M === "DELETE") {
      const th = await db.prepare(`SELECT author_id FROM threads WHERE id = ?1`).bind(tid).first();
      if (!th) return ok({ success: true });
      if (th.author_id !== me.id && !isAdmin) return err("You can only delete your own posts.", 403);
      await db.batch([db.prepare(`DELETE FROM replies WHERE thread_id = ?1`).bind(tid), db.prepare(`DELETE FROM threads WHERE id = ?1`).bind(tid)]);
      return ok({ success: true });
    }
  }
  if (route[0] === "replies" && route[1] && M === "DELETE") {
    const r = await db.prepare(`SELECT author_id, thread_id FROM replies WHERE id = ?1`).bind(+route[1]).first();
    if (!r) return ok({ success: true });
    if (r.author_id !== me.id && !isAdmin) return err("You can only delete your own posts.", 403);
    await db.batch([
      db.prepare(`DELETE FROM replies WHERE id = ?1`).bind(+route[1]),
      db.prepare(`UPDATE threads SET reply_count = MAX(reply_count - 1, 0) WHERE id = ?1`).bind(r.thread_id),
    ]);
    return ok({ success: true });
  }

  // ---- Members directory ----
  if (route[0] === "members" && M === "GET") {
    const r = await db.prepare(`SELECT * FROM members WHERE status = 'approved' ORDER BY display`).all();
    return ok({ members: r.results.map((m) => { const p = publicMember(m); delete p.status; return p; }) });
  }

  // ---- Game scheduling ----
  if (route[0] === "game-times") {
    if (M === "GET" && !route[1]) {
      const r = await db.prepare(`SELECT * FROM game_times`).all();
      const a = await authorMap(r.results.flatMap((x) => [x.proposed_by, x.confirmed_by]));
      return ok({ games: r.results.map((x) => ({ game: x.game_key, status: x.status, startsAt: x.starts_at, note: x.note, proposerTeam: x.proposer_team, proposedBy: a[x.proposed_by] || null, confirmedBy: a[x.confirmed_by] || null, updated: x.updated, mine: x.proposed_by === me.id })) });
    }
    const b = M === "POST" ? await readJson(request) : {};
    const key = String(b.game || "");
    const g = GAME_KEY.exec(key);
    if (!g || !TEAM_ABBRS.has(g[2]) || !TEAM_ABBRS.has(g[3])) return err("Unknown game.");
    const sides = [g[2], g[3]];
    const mySide = myTeams.find((x) => sides.includes(x));
    if (!mySide && !isAdmin) return err("Only the two coaches in this game can schedule it.", 403);
    const cur = await db.prepare(`SELECT * FROM game_times WHERE game_key = ?1`).bind(key).first();

    if (!route[1] && M === "POST") { // propose (or admin sets directly)
      const when = new Date(String(b.startsAt || ""));
      if (isNaN(when)) return err("Pick a date and time.");
      const note = clean(b.note, 200);
      const direct = isAdmin && b.confirm === true;
      await db.prepare(`INSERT INTO game_times VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
        ON CONFLICT(game_key) DO UPDATE SET status=?2, starts_at=?3, note=?4, proposed_by=?5, proposer_team=?6, confirmed_by=?7, updated=?8`)
        .bind(key, direct ? "confirmed" : "proposed", when.toISOString(), note, me.id, mySide || "", direct ? me.id : null, t).run();
      if (direct) postGameTime(env, ctx, key, when.toISOString());
      return ok({ success: true, status: direct ? "confirmed" : "proposed" }, 201);
    }
    if (route[1] === "confirm" && M === "POST") {
      if (!cur || cur.status !== "proposed") return err("There's no proposed time to confirm.");
      if (!isAdmin && (cur.proposed_by === me.id || mySide === cur.proposer_team)) return err("Your opponent has to confirm this time.", 403);
      await db.prepare(`UPDATE game_times SET status='confirmed', confirmed_by=?2, updated=?3 WHERE game_key=?1`).bind(key, me.id, t).run();
      postGameTime(env, ctx, key, cur.starts_at);
      return ok({ success: true });
    }
    if (route[1] === "decline" && M === "POST") {
      if (!cur) return ok({ success: true });
      await db.prepare(`DELETE FROM game_times WHERE game_key = ?1`).bind(key).run();
      return ok({ success: true });
    }
  }

  // ---- Commissioner tools ----
  if (route[0] === "admin") {
    if (!isAdmin) return err("Only the commissioner can do that.", 403);
    if (route[1] === "members" && M === "GET") {
      const r = await db.prepare(`SELECT * FROM members ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, display`).all();
      const inv = await db.prepare(`SELECT username, created FROM invites ORDER BY username`).all();
      return ok({ members: r.results.map((m) => ({ ...publicMember(m), lastLogin: m.last_login, created: m.created })), invites: inv.results });
    }
    if (route[1] === "members" && route[2] && M === "POST") {
      const b = await readJson(request);
      const m = await db.prepare(`SELECT * FROM members WHERE id = ?1`).bind(route[2]).first();
      if (!m) return err("Member not found.", 404);
      const status = ["pending", "approved", "removed"].includes(b.status) ? b.status : m.status;
      let role = ["member", "admin"].includes(b.role) ? b.role : m.role;
      if (m.id === me.id) role = "admin"; // you can't demote yourself by accident
      const teams = Array.isArray(b.teams) ? b.teams.map((x) => String(x).toUpperCase()).filter((x) => TEAM_ABBRS.has(x)).slice(0, 2).join(",") : m.teams;
      const newStatus = m.id === me.id ? "approved" : status;
      const override = newStatus === m.status ? m.override : newStatus === "pending" ? null : newStatus;
      const roleSite = ["member", "admin"].includes(b.role) && b.role !== m.role ? 1 : m.role_site;
      await db.prepare(`UPDATE members SET status=?2, role=?3, teams=?4, override=?5, role_site=?6, gate=CASE WHEN ?2='approved' THEN NULL ELSE gate END WHERE id=?1`).bind(m.id, newStatus, role, teams, override, roleSite || 0).run();
      if (status === "removed" && m.id !== me.id) await db.prepare(`DELETE FROM sessions WHERE member_id = ?1`).bind(m.id).run();
      return ok({ success: true });
    }
    if (route[1] === "invites" && M === "POST") {
      const u = clean((await readJson(request)).username, 40).toLowerCase().replace(/^@/, "");
      if (!/^[a-z0-9_.]{2,32}$/.test(u)) return err("Enter a Discord username (letters, numbers, _ and . only).");
      await db.prepare(`INSERT OR IGNORE INTO invites VALUES (?1,?2,?3)`).bind(u, me.id, t).run();
      await db.prepare(`UPDATE members SET status='approved', override='approved', gate=NULL WHERE username = ?1 AND status = 'pending'`).bind(u).run();
      return ok({ success: true }, 201);
    }
    if (route[1] === "invites" && route[2] && M === "DELETE") {
      await db.prepare(`DELETE FROM invites WHERE username = ?1`).bind(decodeURIComponent(route[2]).toLowerCase()).run();
      return ok({ success: true });
    }
  }
  return err("Not found", 404);
}

/* =====================================================================
 * FAN ZONE: On Air settings, Matchup of the Week, Highlight wall, Trash talk
 * ===================================================================== */
const REACTIONS = ["🔥", "😂", "💀", "🧢", "🐐"];
const LIVE_WINDOW_MS = 4 * 3600e3; // a scheduled broadcast counts as live for 4 hours

async function getSetting(db, key) {
  const r = await db.prepare(`SELECT value FROM settings WHERE key = ?1`).bind(key).first();
  try { return r ? JSON.parse(r.value) : null; } catch { return null; }
}
const putSetting = (db, key, val) => db.prepare(`INSERT INTO settings VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2`).bind(key, JSON.stringify(val)).run();

// Turn a pasted clip link into a platform + id. Only these shapes are accepted.
function parseClip(raw) {
  let u; try { u = new URL(String(raw || "").trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, ""), p = u.pathname.split("/").filter(Boolean);
  const yt = (id) => (/^[\w-]{11}$/.test(id || "") ? { platform: "youtube", vid: id } : null);
  if (host === "youtu.be") return yt(p[0]);
  if (host === "youtube.com") {
    if (p[0] === "watch") return yt(u.searchParams.get("v"));
    if (["shorts", "live", "embed"].includes(p[0])) return yt(p[1]);
    return null;
  }
  const slug = (s) => (/^[\w-]{4,100}$/.test(s || "") ? { platform: "twitchclip", vid: s } : null);
  if (host === "clips.twitch.tv") return slug(p[0]);
  if (host === "twitch.tv") {
    if (p[1] === "clip") return slug(p[2]);
    if (p[0] === "videos" && /^\d{5,15}$/.test(p[1] || "")) return { platform: "twitchvod", vid: p[1] };
    return null;
  }
  if (host === "tiktok.com" && p[1] === "video" && /^\d{10,25}$/.test(p[2] || "")) return { platform: "tiktok", vid: p[2] };
  return null;
}

async function liveState(db, env) {
  const b = (await getSetting(db, "broadcast")) || {};
  const at = b.at ? Date.parse(b.at) : NaN, t = Date.now();
  const live = !!b.live || (!isNaN(at) && t >= at && t < at + LIVE_WINDOW_MS && !b.ended);
  // Fall back to the next confirmed game for the countdown.
  const next = await db.prepare(`SELECT game_key, starts_at FROM game_times WHERE status = 'confirmed' AND starts_at > ?1 ORDER BY starts_at LIMIT 1`).bind(new Date(t - LIVE_WINDOW_MS).toISOString()).first();
  const m = await getSetting(db, "motw");
  let motw = null;
  if (m && m.a && m.b) {
    const r = await db.prepare(`SELECT side, COUNT(*) AS n FROM motw_votes WHERE matchup = ?1 GROUP BY side`).bind(m.id).all();
    const votes = { a: 0, b: 0 }; r.results.forEach((x) => { if (x.side in votes) votes[x.side] = x.n; });
    motw = { id: m.id, a: m.a, b: m.b, label: m.label || "", open: !!m.open, votes };
  }
  const h = await db.prepare(`SELECT h.id, h.platform, h.vid, h.title, h.created, m.display, m.username FROM highlights h LEFT JOIN members m ON m.id = h.submitted_by WHERE h.status = 'approved' ORDER BY h.id DESC LIMIT 24`).all();
  return {
    broadcast: {
      twitch: b.twitch || null, chatChannel: b.chatChannel || null, guild: env.DISCORD_GUILD_ID || null,
      title: b.title || null, at: isNaN(at) ? null : new Date(at).toISOString(), live,
    },
    nextGame: next ? { game: next.game_key, at: next.starts_at } : null,
    motw,
    highlights: h.results.map((x) => ({ id: x.id, platform: x.platform, vid: x.vid, title: x.title, created: x.created, by: x.display || x.username || null })),
  };
}

async function handleFanApi(request, env, route, me, ok, err) {
  const db = env.DB, M = request.method, t = now();
  const isAdmin = me && me.status === "approved" && me.role === "admin";

  if (route[0] === "live" && M === "GET") return ok(await liveState(db, env));

  // ---- Matchup of the Week: anyone can vote, one vote per browser ----
  if (route[0] === "motw" && route[1] === "vote" && M === "POST") {
    const b = await readJson(request);
    const m = await getSetting(db, "motw");
    if (!m || !m.open || b.matchup !== m.id) return err("Voting on this matchup is closed.", 409);
    if (!["a", "b"].includes(b.side)) return err("Pick a side.");
    const voter = String(b.voter || "");
    if (!/^[a-f0-9]{32}$/.test(voter)) return err("That vote couldn't be read.");
    const ip = await sha256((request.headers.get("cf-connecting-ip") || "") + "|" + m.id);
    const had = await db.prepare(`SELECT side FROM motw_votes WHERE matchup = ?1 AND voter = ?2`).bind(m.id, voter).first();
    if (!had) {
      const same = await db.prepare(`SELECT COUNT(*) AS n FROM motw_votes WHERE matchup = ?1 AND ip = ?2`).bind(m.id, ip).first();
      if (same.n >= 8) return err("Too many votes from this connection.", 429);
    }
    await db.prepare(`INSERT INTO motw_votes VALUES (?1,?2,?3,?4,?5) ON CONFLICT(matchup, voter) DO UPDATE SET side = ?4, at = ?5`).bind(m.id, voter, ip, b.side, t).run();
    const r = await db.prepare(`SELECT side, COUNT(*) AS n FROM motw_votes WHERE matchup = ?1 GROUP BY side`).bind(m.id).all();
    const votes = { a: 0, b: 0 }; r.results.forEach((x) => { if (x.side in votes) votes[x.side] = x.n; });
    return ok({ votes, changed: !!had && had.side !== b.side });
  }

  // ---- Trash talk ----
  if (route[0] === "talk") {
    if (M === "GET" && !route[1]) {
      const before = Math.trunc(+new URL(request.url).searchParams.get("before") || 0);
      const rows = (await db.prepare(`SELECT t.*, m.display, m.username, m.avatar, m.teams, m.role, m.status FROM talk t LEFT JOIN members m ON m.id = t.author_id ${before > 0 ? "WHERE t.id < ?1" : "WHERE ?1 = ?1"} ORDER BY t.id DESC LIMIT 30`).bind(before).all()).results;
      const ids = rows.map((r) => r.id);
      const reacts = ids.length ? (await db.prepare(`SELECT post_id, emoji, member_id FROM talk_reacts WHERE post_id IN (${ids.map((_, i) => "?" + (i + 1)).join(",")})`).bind(...ids).all()).results : [];
      return ok({
        me: me && me.status !== "removed" ? { id: me.id, display: me.display || me.username, avatar: me.avatar, admin: isAdmin } : null,
        reactions: REACTIONS,
        posts: rows.map((r) => {
          const mine = reacts.filter((x) => x.post_id === r.id);
          const counts = {}; mine.forEach((x) => { counts[x.emoji] = (counts[x.emoji] || 0) + 1; });
          return {
            id: r.id, body: r.body, target: r.target || null, created: r.created,
            author: { id: isAdmin ? r.author_id : undefined, display: r.display || r.username || "Someone", avatar: r.avatar, teams: (r.teams || "").split(",").filter(Boolean), coach: r.status === "approved", commish: r.role === "admin" && r.status === "approved" },
            reactions: counts, reacted: me ? mine.filter((x) => x.member_id === me.id).map((x) => x.emoji) : [],
            mine: !!me && r.author_id === me.id, canDelete: !!me && (r.author_id === me.id || isAdmin),
          };
        }),
        more: rows.length === 30,
      });
    }
    if (!me) return err("Sign in with Discord to join the trash talk.", 401);
    if (me.status === "removed") return err("You can't post here.", 403);
    if (M === "POST" && !route[1]) {
      const b = await readJson(request);
      const body = clean(b.body, 280).replace(/\n{3,}/g, "\n\n");
      if (!body) return err("Say something first.");
      const target = b.target ? String(b.target).toUpperCase() : "";
      if (target && !TEAM_ABBRS.has(target)) return err("Pick a team from the list.");
      const last = await db.prepare(`SELECT created FROM talk WHERE author_id = ?1 ORDER BY id DESC LIMIT 1`).bind(me.id).first();
      if (last && Date.now() - Date.parse(last.created) < 15000) return err("Easy. Wait a few seconds before posting again.", 429);
      const r = await db.prepare(`INSERT INTO talk (author_id, target, body, created) VALUES (?1,?2,?3,?4) RETURNING id`).bind(me.id, target || null, body, t).first();
      return ok({ id: r.id }, 201);
    }
    const id = Math.trunc(+route[1]);
    if (route[1] && route[2] === "react" && M === "POST") {
      const emoji = String((await readJson(request)).emoji || "");
      if (!REACTIONS.includes(emoji)) return err("Unknown reaction.");
      const post = await db.prepare(`SELECT id FROM talk WHERE id = ?1`).bind(id).first();
      if (!post) return err("That post was deleted.", 404);
      const had = await db.prepare(`SELECT 1 AS x FROM talk_reacts WHERE post_id = ?1 AND member_id = ?2 AND emoji = ?3`).bind(id, me.id, emoji).first();
      await db.prepare(had ? `DELETE FROM talk_reacts WHERE post_id = ?1 AND member_id = ?2 AND emoji = ?3` : `INSERT INTO talk_reacts VALUES (?1,?2,?3)`).bind(id, me.id, emoji).run();
      return ok({ reacted: !had });
    }
    if (route[1] && M === "DELETE") {
      const p = await db.prepare(`SELECT author_id FROM talk WHERE id = ?1`).bind(id).first();
      if (!p) return ok({ success: true });
      if (p.author_id !== me.id && !isAdmin) return err("You can only delete your own posts.", 403);
      await db.batch([db.prepare(`DELETE FROM talk_reacts WHERE post_id = ?1`).bind(id), db.prepare(`DELETE FROM talk WHERE id = ?1`).bind(id)]);
      return ok({ success: true });
    }
    return err("Not found", 404);
  }

  // ---- Highlights: coaches submit, the commissioner approves ----
  if (route[0] === "highlights" && M === "POST" && !route[1]) {
    if (!me) return err("Please sign in.", 401);
    if (me.status !== "approved") return err("Only league coaches can submit highlights.", 403);
    const b = await readJson(request);
    const clip = parseClip(b.url);
    if (!clip) return err("Paste a YouTube, Twitch or TikTok link to a single video or clip.");
    const title = clean(b.title, 80);
    const dup = await db.prepare(`SELECT status FROM highlights WHERE platform = ?1 AND vid = ?2 AND status != 'rejected'`).bind(clip.platform, clip.vid).first();
    if (dup) return err(dup.status === "approved" ? "That clip is already on the wall." : "That clip is already waiting for approval.", 409);
    if (!isAdmin) {
      const n = await db.prepare(`SELECT COUNT(*) AS n FROM highlights WHERE submitted_by = ?1 AND status = 'pending'`).bind(me.id).first();
      if (n.n >= 10) return err("You have 10 clips waiting already. Give the commissioner a minute.", 429);
    }
    const status = isAdmin ? "approved" : "pending";
    await db.prepare(`INSERT INTO highlights (platform, vid, title, submitted_by, status, created, reviewed_by) VALUES (?1,?2,?3,?4,?5,?6,?7)`).bind(clip.platform, clip.vid, title, me.id, status, t, isAdmin ? me.id : null).run();
    return ok({ status }, 201);
  }
  if (route[0] === "highlights" && route[1] === "mine" && M === "GET") {
    if (!me || me.status !== "approved") return err("Please sign in.", 401);
    const r = await db.prepare(`SELECT id, platform, vid, title, status, created FROM highlights WHERE submitted_by = ?1 ORDER BY id DESC LIMIT 20`).bind(me.id).all();
    return ok({ highlights: r.results });
  }

  // ---- Commissioner: broadcast, matchup, highlight review ----
  if (route[0] === "admin" && ["broadcast", "motw", "highlights"].includes(route[1])) {
    if (!isAdmin) return err("Only the commissioner can do that.", 403);
    if (route[1] === "broadcast" && M === "POST") {
      const b = await readJson(request), cur = (await getSetting(db, "broadcast")) || {};
      const twitch = b.twitch === undefined ? cur.twitch : clean(b.twitch, 40).replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "").replace(/\/.*$/, "").toLowerCase();
      if (twitch && !/^[a-z0-9_]{3,25}$/.test(twitch)) return err("That doesn't look like a Twitch channel name.");
      const chatChannel = b.chatChannel === undefined ? cur.chatChannel : clean(b.chatChannel, 30);
      if (chatChannel && !/^\d{17,20}$/.test(chatChannel)) return err("The chat channel ID is the long number from Copy Channel ID.");
      let at = b.at === undefined ? cur.at : b.at ? new Date(String(b.at)) : null;
      if (at instanceof Date) { if (isNaN(at)) return err("Pick a date and time."); at = at.toISOString(); }
      const next = { twitch: twitch || null, chatChannel: chatChannel || null, title: b.title === undefined ? cur.title || null : clean(b.title, 100) || null, at: at || null,
        live: b.end ? false : b.live === undefined ? !!cur.live : !!b.live,
        ended: b.end ? true : b.live ? false : at !== (cur.at || null) ? false : !!cur.ended };
      await putSetting(db, "broadcast", next);
      return ok({ success: true, broadcast: next });
    }
    if (route[1] === "motw" && M === "POST") {
      const b = await readJson(request), cur = await getSetting(db, "motw");
      if (b.a !== undefined || b.b !== undefined) {
        const a = String(b.a || "").toUpperCase(), bb = String(b.b || "").toUpperCase();
        if (!TEAM_ABBRS.has(a) || !TEAM_ABBRS.has(bb)) return err("Pick two teams.");
        if (a === bb) return err("Pick two different teams.");
        await putSetting(db, "motw", { id: "m" + Date.now(), a, b: bb, label: clean(b.label, 60), open: true });
        return ok({ success: true });
      }
      if (!cur) return err("Set a matchup first.");
      await putSetting(db, "motw", { ...cur, open: !!b.open });
      return ok({ success: true });
    }
    if (route[1] === "highlights" && M === "GET") {
      const r = await db.prepare(`SELECT h.*, m.display, m.username FROM highlights h LEFT JOIN members m ON m.id = h.submitted_by WHERE h.status IN ('pending','approved') ORDER BY CASE h.status WHEN 'pending' THEN 0 ELSE 1 END, h.id DESC LIMIT 60`).all();
      return ok({ highlights: r.results.map((x) => ({ id: x.id, platform: x.platform, vid: x.vid, title: x.title, status: x.status, created: x.created, by: x.display || x.username || null })) });
    }
    if (route[1] === "highlights" && route[2] && M === "POST") {
      const s = (await readJson(request)).status;
      if (!["approved", "rejected"].includes(s)) return err("Approve or reject.");
      await db.prepare(`UPDATE highlights SET status = ?2, reviewed_by = ?3 WHERE id = ?1`).bind(Math.trunc(+route[2]), s, me.id).run();
      return ok({ success: true });
    }
    if (route[1] === "highlights" && route[2] && M === "DELETE") {
      await db.prepare(`DELETE FROM highlights WHERE id = ?1`).bind(Math.trunc(+route[2])).run();
      return ok({ success: true });
    }
  }
  return null;
}

// Confirmed game times are public, so the schedule can show them.
async function publicGameTimes(db) {
  const r = await db.prepare(`SELECT game_key, starts_at FROM game_times WHERE status = 'confirmed'`).all();
  return Object.fromEntries(r.results.map((x) => [x.game_key, x.starts_at]));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const segs = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    const isPublicApi = segs[0] === "api" && (segs[1] === "health" || segs[1] === "league" || segs[1] === "config" || (segs[1] === "game-times" && segs[2] === "public"));
    const isMembersApi = segs[0] === "api" && !isPublicApi;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: isMembersApi ? corsFor(request, env) : CORS });
    if (!env.DB) return json({ error: "The D1 database is not connected. Add a D1 binding named DB." }, 500, CORS);
    await ensureSchema(env.DB);

    if (segs[0] === "auth" && segs[1] === "discord") return handleAuth(request, env, url, segs, ctx);

    if (isMembersApi) {
      const cors = corsFor(request, env);
      try { return await handleMembersApi(request, env, segs, cors, ctx); }
      catch (e) {
        if (e instanceof SyntaxError || (e && e.message === "too_large")) return json({ error: "That request couldn't be read." }, 400, cors);
        console.error("Members API error", e && e.message);
        return json({ error: "Something went wrong. Please try again." }, 500, cors);
      }
    }

    if (request.method === "GET" && segs[0] === "api") {
      if (segs[1] === "health") {
        const m = await env.DB.prepare(`SELECT MAX(received) AS last FROM exports`).first();
        return json({ ok: true, lastExport: m?.last ?? null, members: !!(env.DISCORD_CLIENT_ID && env.SITE_URL) }, 200, CORS);
      }
      if (segs[1] === "config") {
        const invite = /^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]+$/.test(env.DISCORD_INVITE_URL || "") ? env.DISCORD_INVITE_URL : null;
        return json({ discordInvite: invite, discordServerAccess: !!env.DISCORD_GUILD_ID, coachRoleRequired: !!env.DISCORD_COACH_ROLE_ID }, 200, { ...CORS, "cache-control": "public, max-age=300" });
      }
      if (segs[1] === "game-times") {
        return json({ games: await publicGameTimes(env.DB) }, 200, { ...CORS, "cache-control": "public, max-age=30" });
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
    }

    if (request.method === "GET" && segs.length === 0) {
      return new Response("RNN E-Sports league data receiver is running.", { headers: { "content-type": "text/plain" } });
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

    return json({ error: "Not found" }, 404);
  },
};
