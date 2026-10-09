# Foldstrike

1v1 multiplayer browser game.
Paper is split by a vertical fold line (horizontal on mobile).
Each player owns one half, places stickmen on own half as a game prep.
Then once the game starts, shoots dots on own half that mirror across the fold onto the opponent half.

## Rules
- Placement: each player places N=5 stickman tokens on own half. Tokens cannot cross fold line. Drag-and-drop tokens, not freehand drawing.
- Battle: simultaneous rounds. Each round (~10s timer) each player places 1 dot anywhere on own half. Dots stay hidden until both
  players lock or timer expires (commit-reveal, prevents copying).
- Reveal: animate fold, mirror shot `(x, y)` -> `(x, H - y)` onto opponent half. Circle hit test vs stickman hit radius.
- Scoring: hit = +1 point, hit stickman is removed. Miss leaves a mark.
- End: first to wipe opponent side wins.
- Rooms: create/join via short code (`/r/AB12CD`). Lobby -> placement -> battle -> game over -> rematch. Anonymous play, no accounts.

## Styling & Code Conventions

- Use Tailwind (latest, `@tailwindcss/browser@4` via CDN) for styling. Prefer Tailwind utility classes over a dedicated `style.css` wherever possible.
- Use JSDoc comments for JavaScript files/functions in `public/`.

## Tooling Constraints

- Do NOT install browser-automation tools (Playwright, Puppeteer, etc.) to test rendering. There is no headless browser available and none should be added.
- Verify client rendering by reading the canvas code carefully and reasoning about coordinates rather than screenshotting.

## Architecture

```
┌────────────┐   static   ┌─────────────────────┐
│            │<──────────>│                     │
│  Player A  │  WS /ws *  │    Go server :8080  │
│            │<──────────>│                     │
└────────────┘            │  ┌──────────────┐   │
┌────────────┐   static   │  │ live rooms   │   │
│            │<──────────>│  │ in-memory    │   │
│  Player B  │  WS /ws *  │  │ timers+conns │   │
│            │<──────────>│  └──────┬───────┘   │
└────────────┘            │         │ persists  │
                          │  ┌──────V───────┐   │
                          │  │ internal     │   │
                          │  │ store        │   │
                          │  │ rooms, shots │   │
                          │  └──────────────┘   │
                          └─────────────────────┘
```
