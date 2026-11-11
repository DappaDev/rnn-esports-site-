# RNN E-Sports

The website for the RNN E-Sports Madden 27 league: live broadcasts, the coach roster, the season schedule, and league sign-ups.

## Pages

The site is a single page (`index.html`) with four views:

| View | Link | What it shows |
|---|---|---|
| Home | `index.html` | On Air broadcast panel, fan poll, and the coach roster |
| Schedule | `index.html#schedule` | All 18 weeks and 272 games of the 2026–27 season, dates and kickoffs TBD |
| Scores & Stats | `index.html#league` | Standings, final scores and stat leaders from Madden Companion App exports |
| Locker Room | `index.html#locker` | Members only: announcements, message board and game scheduling, Play Tecmo, with Discord sign-in |
| Join the League | `index.html#join` | Draft board of open teams and the coach sign-up form |
| Coach card | `index.html#coach-<name>` | A coach's full broadcast profile card |

## Folders

- `assets/` – RNN E-Sports crest, favicon and app icons
- `coaches/` – coach broadcast profile cards
- `logos/` – team logos, one per team abbreviation (e.g. `KC.png`)
- `data/schedule-2026-27.txt` – the season schedule as plain text (`W1 AWAY@HOME`)
- `tecmo/` – Tecmo Super Bowl player for the Locker Room (the ROM itself is not in this repo; see below)
- `receiver/` – the Cloudflare Worker: Madden export receiver and Locker Room backend, with setup guides

## Updating

- **Coaches:** edit the `COACHES` list near the bottom of `index.html` and add the card image to `coaches/`.
- **Schedule:** game matchups live in the `SCHED` list in `index.html`. Every date and kickoff shows as TBD.

## League data (scores, standings, stats)

The commissioner exports the franchise from the Madden 27 Companion App to the receiver in `receiver/`. The site reads it through `API_BASE` in `index.html`. Setup steps are in `receiver/README.md`.

## Live features

The coach sign-up form and the fan poll save to the claude.ai artifact database. They work on the claude.ai version of the site. On any other host, such as GitHub Pages, the rest of the site works normally and those two sections show a sign-in note instead. A public version needs its own form and vote backend.

## Schedule source

2026–27 NFL regular-season matchups via [Pro Football Reference](https://www.pro-football-reference.com/years/2026/games.htm), checked against the [NFL's schedule announcement](https://edge-operations.nfl.com/updates/the-game/2026-nfl-schedule-announced/).

## Tecmo Super Bowl (Locker Room → Play Tecmo)

Approved members can play the league's Tecmo Super Bowl build in the browser on a phone, a tablet or a computer. It supports touch controls, a keyboard and Bluetooth/USB controllers.

- The player is in `tecmo/`. It uses [jsnes](https://github.com/bfirsh/jsnes) (Apache-2.0, license in `tecmo/LICENSE-jsnes.txt`).
- **The ROM is never put in this repo** (it's public). A commissioner uploads it in **Locker Room → Commissioner → Tecmo Super Bowl ROM**. It's stored on the league server, and only signed-in, approved members can download it.
- Season saves stay in each member's browser. Uploading a new build starts saved seasons fresh.
