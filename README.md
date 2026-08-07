# ☕ Lean Coffee Board

A simple, real-time collaborative board for **Lean Coffee** style meetings – agenda-less, time-boxed discussions where participants suggest topics, vote, and discuss in priority order. Inspired by the now-offline *Agile Coffee* tool.

Four-column Kanban: **To Discuss → Discussing → Discussed → Actions**. Drag cards horizontally between columns and vertically to reorder. Share a link, no accounts required.

![Agile Coffee Board](./examples/agile-coffee.webp)

---

## Features

- **Real-time sync** – everyone on the same URL sees cards move, votes update, and the timer tick together.
- **Drag-and-drop** – move cards between columns (horizontal) and reorder within a column (vertical).
- **Unique meeting URLs** – each board gets an 8-character hash URL, e.g. `#/a1b2c3d4`.
- **Voting** – 3 votes per person (Lean Coffee standard) to prioritise the To Discuss column. One click to sort by votes.
- **Synced discussion timer** – start, pause, reset; pick from 2–15 minute lengths. Every client computes remaining time from server timestamps, so it stays in sync without a ticking server.
- **Random identity** – each browser gets a friendly name + colour (e.g. "Curious Otter"), so cards are attributable without accounts.
- **Export** – download the board as JSON, or print a clean summary (decisions and action items highlighted).
- **No build step** – plain HTML/CSS/JS served as-is.

## How it works

```
Browser (GitHub Pages)              Supabase (free tier)
┌─────────────────────┐            ┌──────────────────────┐
│ index.html          │            │ Postgres             │
│ css/style.css       │◀──────────▶│  ├ boards            │
│ js/*.js (modular)   │  Realtime  │  └ cards             │
│ supabase-js (CDN)   │  channels  │ RLS (anon read/write)│
└─────────────────────┘            │ Realtime enabled     │
                                   └──────────────────────┘
```

- The frontend is hosted on **GitHub Pages** and uses **hash-based routing**, so no SPA redirect tricks are needed.
- **Supabase** provides the Postgres database, Row Level Security, and Realtime channels. The frontend talks to it directly via `supabase-js`.
- The Supabase **anon key** is intentionally public (committed to the repo) – access is governed by RLS, not key secrecy. The board slug acts as a capability URL: anyone with the link can edit.
- **Keep-alive:** on the free tier, Supabase pauses projects after **1 week of API inactivity**. The [`.github/workflows/keep-alive.yml`](.github/workflows/keep-alive.yml) workflow pings the REST API every 5 days (and on manual dispatch) so the project never pauses. It does a read-only `boards` query and never mutates data. If you fork, update the `SUPABASE_URL` and `SUPABASE_ANON_KEY` in the workflow to match your own project (they're committed on purpose – the anon key is safe to expose).

---

## Setup

### 1. Create a Supabase project

1. Sign up at [supabase.com](https://supabase.com) (free tier).
2. Create a new project. Note the **Project URL** and **anon public key** from *Project Settings → API*.
3. Open the **SQL Editor** and paste the contents of [`supabase/schema.sql`](supabase/schema.sql). Run it. This creates the `boards` and `cards` tables, enables RLS with public read/write policies, and adds both tables to the Realtime publication.

### 2. Configure the app

Edit [`js/config.js`](js/config.js) and replace the placeholders:

```js
export const SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
```

### 3. Push to GitHub and enable Pages

1. Push the repo to your own GitHub, e.g. `https://github.com/<your-user>/lean-coffee-board`.
2. In the repo: **Settings → Pages → Source = "Deploy from a branch"**, branch `main`, folder `(root)`. Save.
3. Your board will be live at `https://<your-user>.github.io/lean-coffee-board/`. Each push to `main` auto-deploys. The app uses hash-based routing and relative asset paths, so it also deploys unchanged under any static host or custom domain – no site-specific config needed.

### 4. Run locally

```bash
git clone https://github.com/<your-user>/lean-coffee-board.git ~/repo/lean-coffee-board
cd ~/repo/lean-coffee-board
python3 -m http.server 8000
# open http://localhost:8000
```

---

## Running a Lean Coffee meeting

1. Open the app and click **Start a new board**.
2. Copy the URL (it contains the `#/slug`) and share it with participants.
3. Everyone adds topics to the **To Discuss** column.
4. Each person spends their 3 votes (▲) on the topics they want to prioritise. Click **Sort by votes** to reorder.
5. Drag the top topic to **Discussing** and start the timer.
6. When the timer ends, the group decides: continue (restart timer) or done (drag to **Discussed**). Capture decisions and next steps in the **Actions** column.
7. Repeat until time runs out.
8. Use **Print** to capture a summary, or **JSON** to export the raw board.

---

## Project structure

```
lean-coffee-board/
├── index.html                  # App shell
├── css/style.css               # Board, cards, columns, responsive
├── js/
│   ├── config.js               # Supabase URL + anon key (edit this)
│   ├── supabase.js             # Client + realtime subscriptions
│   ├── app.js                  # Hash router, landing page
│   ├── board.js                # State, CRUD, rendering
│   ├── dnd.js                  # Drag-and-drop (horizontal + vertical)
│   ├── timer.js                # Synced discussion timer
│   ├── voting.js               # 3-votes-per-person + sort by votes
│   ├── identity.js             # Random name/colour, per browser
│   └── export.js               # JSON + print export
├── supabase/schema.sql         # Tables, RLS, realtime (run once)
├── .nojekyll                   # Disable Jekyll processing on Pages
└── examples/                   # Sample board screenshot + demo HTML source
```

---

## Security model & tradeoffs

This is a **no-account** tool, matching the philosophy of the original Agile Coffee. The tradeoffs are inherent:

- **The board URL is the only secret.** Anyone with the link can read and edit the board. The 8-character slug gives ~4 billion combinations – enough that unguessable URLs won't be found by chance, but treat board links as sensitive as the meeting itself.
- **Votes are best-effort.** The 3-vote limit is enforced per-browser via `localStorage`, not globally. A determined user could clear storage to vote again. True enforcement requires accounts, which this project deliberately avoids.
- **RLS is fully open** (public read/write on both tables). This is necessary for the no-account model but means any Supabase client pointing at your project URL can read/write any board. The slug is the access control.

If you need stronger access control, fork the project and add Supabase Auth.

## License

MIT – see [LICENSE](LICENSE).
