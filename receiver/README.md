# RNN League Data Receiver + Locker Room

This receives the **Madden 27 Companion App franchise export** and feeds the site's **Scores & Stats** page and the final scores on the **Schedule** page.

It runs free on Cloudflare: one Worker (`worker.js`) and one D1 database. Players never share PSN, Xbox or EA logins. The commissioner taps **Export** in the Companion App, and the league data comes here.

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

## Locker Room (members area) setup, about 10 minutes

The Locker Room uses **Sign in with Discord**. Only coaches you approve get in.

### A. Create the Discord app
1. Go to **discord.com/developers/applications** and sign in with your Discord account.
2. Click **New Application**, name it `RNN E-Sports`, accept the terms and click **Create**.
3. In the left menu, open **OAuth2**.
4. Copy the **Client ID**.
5. Under **Client Secret**, click **Reset Secret**, then copy the secret. Keep it private.
6. Under **Redirects**, click **Add Redirect** and paste:
   ```
   https://rnn-receiver.dtorregano.workers.dev/auth/discord/callback
   ```
   Then click **Save Changes**.

### B. Add four settings to the Worker
In Cloudflare, open **Workers & Pages → rnn-receiver → Settings → Variables and Secrets** and add:

| Type | Name | Value |
|---|---|---|
| Text | `DISCORD_CLIENT_ID` | the Client ID from step A4 |
| **Secret** | `DISCORD_CLIENT_SECRET` | the Client Secret from step A5 |
| Text | `SITE_URL` | `https://dappadev.github.io/rnn-esports-site-/` |
| Text | `COMMISSIONERS` | your Discord username (add more, separated by commas) |

Click **Deploy**.

### B2. Connect your league's Discord server (recommended)
This lets your Discord server decide who gets in: anyone in the server with the **@Coach** role gets straight into the Locker Room, and **@Commissioner** makes someone a site commissioner. It also posts to your channels automatically.

1. **Turn on Developer Mode** in Discord: **User Settings → Advanced → Developer Mode**. This adds "Copy ID" to right-click menus.
2. **Server ID:** right-click your server's icon → **Copy Server ID**.
3. **Roles:** in **Server Settings → Roles**, create **Coach** and **Commissioner** roles if you don't have them. Right-click each one → **Copy Role ID**. Give the Coach role to every league coach.
4. **Invite link:** right-click the server → **Invite People** → **Edit invite link** → set it to **Never** expire → copy the link.
5. **Channel webhooks:** for each channel below, open **Edit Channel (gear) → Integrations → Webhooks → New Webhook → Copy Webhook URL**.
   - your announcements channel (for site announcements)
   - a schedule channel (for confirmed game times)
   - a private commissioners channel (for new Locker Room sign-ins)

**RNN values** (already set up; these aren't secret). The RNN E-Sports Discord app exists, and its redirect is saved:

| Name | Value |
|---|---|
| `DISCORD_CLIENT_ID` | `1569494857737572463` (RNN E-Sports app) |
| `DISCORD_GUILD_ID` | `1337105795229155330` |
| `DISCORD_COACH_ROLE_ID` | `1569491428697051136` (Coach) |
| `DISCORD_COMMISH_ROLE_ID` | `1569491480547164201` (Commissioner) |

Then add these to the Worker (**Settings → Variables and Secrets**):

| Type | Name | Value |
|---|---|---|
| Text | `DISCORD_GUILD_ID` | Server ID |
| Text | `DISCORD_COACH_ROLE_ID` | Coach role ID |
| Text | `DISCORD_COMMISH_ROLE_ID` | Commissioner role ID |
| Text | `DISCORD_INVITE_URL` | the invite link |
| **Secret** | `WEBHOOK_ANNOUNCEMENTS` | announcements channel webhook |
| **Secret** | `WEBHOOK_SCHEDULE` | schedule channel webhook |
| **Secret** | `WEBHOOK_SIGNUPS` | commissioners channel webhook |

Each one is optional. Leave out the role IDs to let anyone in the server in, or leave out a webhook to skip that channel. Keep the webhook URLs private: anyone with one can post to that channel.

**How it behaves:**
- Discord roles are checked each time someone signs in. Sign-ins last 14 days, so role changes take effect at the next sign-in. To cut someone off right away, remove them in **Commissioner** tools on the site.
- What you do on the site wins. If you approve someone there, they stay in even without the role. If you remove them, they stay out even with it.
- Discord posts never ping anyone (@everyone and @here are disabled).

### C. Update the Worker code
Open **rnn-receiver → Edit code**, replace everything with the new `worker.js` from this folder, and click **Deploy**. The database tables create themselves on first use.

### D. Try it
1. On the league site, open **Locker Room** and click **Sign in with Discord**. Commissioners get straight in.
2. With the Discord server connected, coaches with the Coach role get straight in and appear under **Commissioner → Needs a team**. Pick their team there. Anyone else waits under **Waiting for approval**.
3. Or pre-approve coaches by Discord username, and they get straight in the first time they sign in.

### What members can do
- **Announcements:** read the commissioner's posts. Only commissioners can post, pin and delete.
- **Message Board:** start threads and reply. Members can delete their own posts, and commissioners can delete any.
- **My Games:** propose a date and time for each of their team's games. The opponent confirms or declines, and confirmed times replace "TBD" on the public schedule.
- **Members:** a directory of approved coaches.

Removing a member signs them out everywhere right away.

## Fan Zone (home page), about 5 minutes

The home page has a countdown, a Twitch player with the Discord chat beside it, **Matchup of the Week** voting, the **Highlight Wall** and the **Trash Talk** board. They're all run from **Locker Room → Commissioner**. No new Worker settings are needed.

### Twitch and the countdown
In **Commissioner → On Air**, enter your Twitch channel name, the title of the next broadcast and its start time, then click **Save**.
- The home page counts down to that time and flips to **LIVE** with the Twitch player when it starts. It stays live for 4 hours or until you click **End broadcast**.
- Click **Go live now** to switch it on early.
- If no broadcast is set, the countdown uses the next confirmed game time.

### Live Discord chat beside the video (WidgetBot, free)
1. Create a channel in your server for the broadcast chat, for example **#live-chat**.
2. Go to **add.widgetbot.io**, sign in with Discord and add the WidgetBot bot to the RNN server.
3. In Discord, right-click **#live-chat** and choose **Copy Channel ID**. Developer Mode must be on.
4. Paste the ID into **Commissioner → On Air → Discord chat channel ID** and click **Save**.

Viewers can read the chat right away. To type, they sign in with their Discord account inside the chat box, and their messages land in **#live-chat**. Discord's own moderation (roles, slow mode, bans) applies.

### Matchup of the Week
Pick two teams in **Commissioner → Matchup of the Week**, then click **Start new vote**. Fans vote without an account, with one vote per browser and a cap per connection. **Close voting** freezes the final results.

### Highlight Wall
Coaches paste YouTube, Twitch clip or video, or TikTok links in **Locker Room → Highlights**. You approve or reject them in **Commissioner → Highlights to review**. Clips you add yourself go straight up.

### Trash Talk
Anyone can read it. Coaches and fans post after signing in with Discord. Fans don't land in your approval queue. Posts are limited to 280 characters, one every 15 seconds, with five emoji reactions. Commissioners can **Delete** any post or **Block** a person. Blocked people can be restored in **Commissioner → Members**.

## Existing coaches claim their profile

When an approved coach (for example, someone with the @Coach role) signs in to the Locker Room without a team, they see the 15 coach cards and tap theirs twice to confirm. Cards already claimed, or whose team is already assigned, are greyed out.
- Nothing changes until a commissioner confirms. Claims show under **Commissioner → Coach profiles to confirm**, and a post goes to the commissioners' Discord channel.
- **Confirm** sets their team, so their games show in **My Games**. **Decline** lets them pick again.
- Coaches can cancel a waiting claim, but can't change a confirmed one. Commissioners can still change anyone's team in **Members**.

## Join the League sign-ups

The **Join the League** page lets people claim one of the open teams. They sign in with Discord when they send the form, and what they typed is kept while they sign in.
- Everyone sees which teams are **open**, **requested** or **coached**. Contact details are only shown to commissioners.
- New sign-ups post to your commissioners' Discord channel (`WEBHOOK_SIGNUPS`) without the applicant's contact details.
- Applicants don't show up under **Locker Room → Waiting for approval**. Commissioners review them on the **Join page** under **Sign-Up Requests**, and **Commissioner** shows how many are waiting.
  - **Approve** makes them a Locker Room coach with that team.
  - **Decline** frees the team, and the applicant sees that it wasn't approved.
  - **Remove** deletes the sign-up.
- Applicants can change or withdraw their request until it's approved.
- An approved coach also needs a coach card on the home page. Send the card to Claude to add it.

## Tecmo Super Bowl ROM

**Play Tecmo** in the Locker Room needs the updated `worker.js`. Paste it in and deploy it as in step C. No new settings are needed; the ROM is stored in the same D1 database.

1. Open **Locker Room → Commissioner → Tecmo Super Bowl ROM**, choose the league `.nes` file and click **Upload ROM**. The limit is 1 MB, and a Tecmo ROM is about 384 KB.
2. Approved members can now open **Play Tecmo → Play now**. Signed-out, pending and removed members can't download it.
3. To ship a new build, upload it again. It replaces the old one.

## Addresses

| Address | What it's for |
|---|---|
| `/<EXPORT_KEY>` | Where the Companion App sends exports |
| `/api/league` | Public data the website reads: teams, standings, games and stat leaders. Cached for 60 seconds. |
| `/api/health` | Quick check that shows the last export time |
| `/<EXPORT_KEY>/debug` | Private: lists each export received, its item count and field names |
| `/auth/discord/login` | Starts Discord sign-in for the Locker Room |
| `/api/game-times/public` | Public: confirmed game times shown on the schedule |
| `/api/live` | Public to the league site: countdown, stream, chat channel, Matchup of the Week and approved highlights |
| `/api/signups/board` | Join page: which teams are requested or filled. No contact details |
| `/api/talk` | Trash Talk: anyone can read it, and signed-in people can post and react |
| `/api/tecmo/info`, `/api/tecmo/rom` | Tecmo Super Bowl ROM: approved members download it, commissioners upload or remove it |
| `/api/...` (other) | Locker Room data. Signed-in, approved members only, and only from the league site |

## Notes
- If an export fails in the app (EA's servers are sometimes busy), just try again.
- Leaders count **regular-season** stats for the **current season** only.
- Rosters are accepted and logged but not shown on the site yet.
- Free Cloudflare limits (100,000 requests a day on Workers, plus D1's free tier) are far more than a 32-team league needs.
