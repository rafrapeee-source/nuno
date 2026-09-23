# NUNO — online UNO for up to 8 players

Real-time multiplayer UNO in the browser, following the official rules. Node.js + Express + Socket.IO; the server holds the game state and enforces the rules, so clients can't cheat or see other hands.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
npm test           # rules-engine tests + 300 simulated games
```

Open it in several browser windows (or a private window) to play against yourself, or add bots.

## Deploy to Render

1. Push this folder to a GitHub/GitLab repo.
2. In Render: **New → Blueprint**, pick the repo. `render.yaml` sets everything up (Node web service, `npm install`, `npm start`, health check on `/healthz`).
   Or create a **Web Service** by hand with build command `npm install` and start command `npm start`.
3. Share the URL. One player creates a table and shares the 4-letter code or invite link.

Rooms live in memory, so a redeploy or restart ends any games in progress. On Render's free plan the service sleeps after inactivity; the first visit after that takes a few seconds to wake it up.

## How it plays

- **Tables:** 2–8 seats (2–4 players use the classic layout; 5–8 switch to compact seats around the table, or a grid on phones). The host can fill empty seats with bots and remove players. After a game the host can start a rematch or go back to the lobby.
- **Winning:** no points — the first player to play all their cards wins the game.
- **Rules:** 108-card deck, 7-card deal, match color / number / symbol, draw one and optionally play it, Skip, Reverse (acts as Skip with 2 players), Draw Two, Wild, Wild Draw Four (can be played any time; there is no challenge), first-card rules, and reshuffling the discard pile when the deck runs out.
- **Stacking:** a +2 or +4 passes a running total to the next player, who can raise it with the same kind of card — +2 on +2 (any color), +4 on +4 — never mixed, or press **Take** / click the deck to draw the whole total and lose their turn. Holding a plus card never forces you to stack, and a player with nothing to stack takes the total automatically. (A +2 turned over as the very first card is still drawn straight away.)
- **Animations:** dealing, cards flying to the pile and into hands (flipping face-up for you), a scattered discard pile, Skip / Reverse / +2 / +4 / UNO! splashes, color-change ripples, a direction ring tinted with the current color, a color wheel for Wilds, and confetti when you win. Synthesized sound effects. Both can be switched off in-game (✨ and 🔊); animations stay on even if the OS asks for reduced motion.
- **Turn timer:** 10 seconds per move, shown as a bar on the active seat (plus a countdown on your own turn). The clock starts once the update's animations finish. On timeout you draw one card and play passes on; if a stack was waiting, you take it.
- **UNO!:** only available when you can play down to one card (two cards, your turn, one of them playable), or right after doing so. Until the next player starts their turn, anyone can press **Catch!** on your seat and you draw 2.
- **Disconnects:** refreshing or losing connection keeps your seat; you rejoin automatically. If you're disconnected when your turn clock runs out, a bot makes that move for you. Leaving mid-game hands your seat to a bot.
- Keyboard: `U` UNO, `D` draw, `P` keep & pass.

## Layout

```
server.js        Express + Socket.IO: rooms, seats, reconnection, bot scheduling
src/game.js      Rules engine (pure, no I/O)
src/bot.js       Computer player
public/          Client (HTML/CSS/JS, no build step)
test/            node:test suite
render.yaml      Render blueprint
```
