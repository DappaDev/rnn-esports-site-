# RNN League Data Receiver

This receives the **Madden 27 Companion App franchise export** and feeds the site's **Scores & Stats** page and the final scores on the **Schedule** page.

It runs free on Cloudflare: one Worker (`worker.js`) and one D1 database. Players never share PSN or EA logins. The commissioner taps **Export** in the Companion App, and the league data comes here.

## One-time setup (no terminal needed, about 15 minutes)

### 1. Make a Cloudflare account
Sign up for free at **dash.cloudflare.com/sign-up**.

### 2. Create the database
1. In the left menu, open **Storage & Databases → D1 SQL Database**.
2. Click **Create database**, name it `rnn-league`, and click **Create**.

### 3. Create the Worker
1. In the left menu, open **Compute (Workers) → Workers & Pages**.
2. Click **Create → Create Worker** (use the "Hello World" starter), name it `rnn-receiver`, and click **Deploy**.
3. Click **Edit code**, delete everything in the editor, and paste in the whole contents of `worker.js` from this folder.
4. Click **Deploy**.

### 4. Connect the database
1. Open the Worker's **Settings → Bindings → Add → D1 database**.
2. Set **Variable name** to `DB` (capital letters) and **D1 database** to `rnn-league`.
3. Click **Deploy** (or **Save**).

### 5. Add the secret export key
1. Open **Settings → Variables and Secrets → Add**.
2. Set **Type** to **Secret**, **Name** to `EXPORT_KEY`, and **Value** to a long random password of letters and numbers (at least 12 characters). Keep it private: anyone with it could send fake data.
3. Click **Deploy**.

### 6. Check it's running
Copy the Worker's address, which looks like `https://rnn-receiver.<your-name>.workers.dev`. Open it in a browser. It should say *"RNN E-Sports league data receiver is running."*

### 7. Turn on the export in Madden
In the **Madden NFL 27 Companion App**, open your franchise → **Export** and enter:

```
https://rnn-receiver.<your-name>.workers.dev/<YOUR-EXPORT-KEY>
```

Then export **League info**, **Weekly stats** (all weeks you want) and, optionally, **Rosters**. Re-export after each week is played. Exporting a week again updates its scores. It never creates duplicates.

### 8. Point the website at it
In `index.html`, find this line and put the Worker address inside the quotes:

```js
const API_BASE='';
```

For example, `const API_BASE='https://rnn-receiver.yourname.workers.dev';`. Commit and push, or ask Claude to do it.

## Addresses

| Address | What it's for |
|---|---|
| `/<EXPORT_KEY>` | Where the Companion App sends exports |
| `/api/league` | Public data the website reads: teams, standings, games and stat leaders. Cached for 60 seconds. |
| `/api/health` | Quick check that shows the last export time |
| `/<EXPORT_KEY>/debug` | Private: lists each export received, its item count and field names |

## Notes
- If an export fails in the app (EA's servers are sometimes busy), just try again.
- Leaders count **regular-season** stats for the **current season** only.
- Rosters are accepted and logged but not shown on the site yet.
- Free Cloudflare limits (100,000 requests a day on Workers, plus D1's free tier) are far more than a 32-team league needs.
