# RNN E-Sports

The website for the RNN E-Sports Madden 27 league: live broadcasts, the coach roster, the season schedule, and league sign-ups.

## Pages

The site is a single page (`index.html`) with four views:

| View | Link | What it shows |
|---|---|---|
| Home | `index.html` | On Air broadcast panel, fan poll, and the coach roster |
| Schedule | `index.html#schedule` | All 18 weeks and 272 games of the 2026–27 season, dates and kickoffs TBD |
| Scores & Stats | `index.html#league` | Standings, final scores and stat leaders from Madden Companion App exports |
| Join the League | `index.html#join` | Draft board of open teams and the coach sign-up form |
| Coach card | `index.html#coach-<name>` | A coach's full broadcast profile card |

## Folders

- `assets/` – RNN E-Sports crest, favicon and app icons
- `coaches/` – coach broadcast profile cards
- `logos/` – team logos, one per team abbreviation (e.g. `KC.png`)
- `data/schedule-2026-27.txt` – the season schedule as plain text (`W1 AWAY@HOME`)
- `receiver/` – the Madden export receiver (Cloudflare Worker) with its setup guide

## Updating

- **Coaches:** edit the `COACHES` list near the bottom of `index.html` and add the card image to `coaches/`.
- **Schedule:** game matchups live in the `SCHED` list in `index.html`. Every date and kickoff shows as TBD.

## League data (scores, standings, stats)

The commissioner exports the franchise from the Madden 27 Companion App to the receiver in `receiver/`. The site reads it through `API_BASE` in `index.html`. Setup steps are in `receiver/README.md`.

## Live features

The coach sign-up form and the fan poll save to the claude.ai artifact database. They work on the claude.ai version of the site. On any other host, such as GitHub Pages, the rest of the site works normally and those two sections show a sign-in note instead. A public version needs its own form and vote backend.

## Schedule source

2026–27 NFL regular-season matchups via [Pro Football Reference](https://www.pro-football-reference.com/years/2026/games.htm), checked against the [NFL's schedule announcement](https://edge-operations.nfl.com/updates/the-game/2026-nfl-schedule-announced/).
