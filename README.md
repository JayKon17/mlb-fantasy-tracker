# ⚾ MLB Fantasy Tracker

Standalone live MLB stat tracker for your fantasy roster.  
No browser extension needed — runs as a local Node.js server, opens your browser automatically.

## Setup (one time)

1. Unzip / place the `mlb-tracker` folder anywhere
2. Open a terminal in that folder and run:
   ```
   npm install
   ```

## Running

**Windows:** Double-click `start.bat`  
**Mac / Linux:** `chmod +x start.sh && ./start.sh`  
**Any OS:** `npm start` or `node server.js`

Your browser opens automatically at `http://localhost:3847`.

## Usage

1. Type a player's name (First Last) in the "Add Player" box
2. Select **Hitter** or **Pitcher** — important for correct stat tracking
3. Click **+ Add to Roster** (or press Enter)
4. The tracker finds their game within 1–2 poll cycles (~30s) and begins tracking

### Reading the UI

| Element | Meaning |
|---------|---------|
| ⚡ At Bat / ⚡ Pitching | Player is currently in a live at-bat |
| Green `H` badge | Hitter |
| Blue `P` badge | Pitcher |
| Stats strip (top right) | Running totals for today |
| Event feed | Every plate appearance, newest first |
| Toast (top right pop-up) | Real-time notification for each event |

### Player name tips

- Use the **full MLB name** (e.g. "Luis Robert Jr.", "Ha-Seong Kim")
- Common nicknames won't match — use the official spelling
- If a player shows "Waiting for game…" for more than 2–3 cycles, double-check the name spelling

## How it works

- **All MLB API calls happen in Node.js** — nothing runs in your browser, so no freezing
- **Game discovery**: On startup (and when you add a player), the server fetches the boxscore for each of today's games to map player names to MLB IDs
- **Active polling**: Every 30 seconds, the server fetches play-by-play only for games with your tracked players
- **SSE push**: Completed events and live at-bat status are pushed to your browser via Server-Sent Events — the browser does zero polling
- **Pitcher tracking**: Pitchers are matched by their MLB player ID in completed play-by-play entries — no guessing from live play state

## Data files

- `data/roster.json` — your roster, auto-saved; persists across restarts
- No database, no cloud — everything is local

## Ports

Default: `3847`. To change, edit the `PORT` constant at the top of `server.js`.
