# Baby Names v2 — GitHub Pages Plan

## Goals

- Run the app as a **static site on GitHub Pages** (no Python server, no server-side storage).
- Support a **host** and a joinable **lobby** for **2 players** (the couple), typically on the **same WiFi**.
- Move all storage into the **browser** (`localStorage`) and transfer only **numeric name IDs** between peers.
- Treat every client as **untrusted**: remove all admin functionality; validate all inbound data.
- Swipe through a shared deck of names; each player swipes left/right; the host computes the mutual matches and sends the matched IDs back to both.

## Architecture

**Static site only.** No Python, no server storage. All state lives in `localStorage`; only numeric name IDs cross the network.

Suggested file layout:

- `index.html` — screens: landing (Host/Join), host setup, join, host waiting, swipe game, results
- `app.js` — state machine, PeerJS signaling, swipe logic, matching
- `styles.css`
- `names.txt` — unchanged, fetched at startup (`fetch('names.txt')`); array index = stable name ID
- `peerjs.min.js` — vendored locally (avoids a CDN dependency on Pages)
- `PLAN.md` — this document

Use **hash routing** (`#join=<code>`, `#host`) so links work under `username.github.io/<repo>/`, and use **relative asset paths**.

## Lobby + QR flow

1. **Host** picks "Number of Names" (`N`) and a display name → generates a short lobby code (e.g. 6 chars).
2. Host opens a PeerJS peer with ID `bnam-<code>` (on collision, regenerate the code).
3. The QR code encodes `${location.origin}${location.pathname}#join=<code>`.
4. The same link/code is hidden behind a **Copy** button so it can be pasted.
5. **Join** accepts either a pasted code/link or auto-fills from `#join=`.
6. The joiner connects to `bnam-<code>`; the host accepts the single data connection (replace a stale connection on refresh).

## Data protocol

JSON messages over the WebRTC data channel, all validated by the receiver.

- Host → joiner on open: `{ type: 'init', deck: [id, ...], total: N }`
  - The host randomly samples `N` names from `names.txt` and sends **IDs only**, so both players see the identical deck in the identical order.
- Joiner → host: `{ type: 'done', liked: [id, ...] }`
- The host also swipes locally. When **both** players are done, the host computes the **intersection** of liked IDs and sends `{ type: 'results', matches: [id, ...] }`.
- The host is authoritative for the deck and results. The joiner never sees the other player's picks — only the final matches.
- Validate every message: integer IDs within `[0, names.length)`, IDs must belong to the deck, cap array/message length, and render remote data with `textContent` only (never `innerHTML`) to avoid XSS.

## Swipe + storage

- Card drag with **Pointer Events**: left = no, right = yes, snap back under a threshold.
- Keep **No / Yes buttons** as a fallback and add a **Finish early** button.
- Per-lobby `localStorage` key (e.g. `bn:<code>:<role>`) storing deck IDs, liked IDs, and current index so a refresh resumes mid-game.
- Both clients have the same bundled `names.txt`, so IDs resolve locally; only IDs are ever transmitted.
- The results screen shows matched names for both players, plus a "no matches yet" state.

## Matching semantics

- A match is a name **both players swiped right on**.
- "Finish early" still counts whatever was liked so far.
- This replaces the old multi-user file matching and the admin "find matches" page entirely.

## Removals

- Delete `app.py` and the server-based `index.html` (replaced by the static client).
- Remove all admin functionality: clear users, add names, find matches.
- Remove all per-user server text files (`liked_names_*.txt`, `remaining_names_*.txt`).
- Only `names.txt` is carried forward from v1; the name list is fixed at deploy time (edit `names.txt` → redeploy).

## Risks / notes

- PeerJS public cloud handles signaling + STUN. Same WiFi should connect directly; on failure, show a retry/error (no TURN by default). Optional: add a free TURN fallback if WiFi + cellular mixing is ever needed.
- Clearing browser data or using private mode loses progress; it is tied to the same lobby code.
- The name list is fixed at deploy time; there is no admin UI.
- Untrusted clients: the host validates all inbound data; the joiner trusts the host for results because the host owns the lobby.

## Build order

1. Bundle assets, remove server code, set up hash routing + names loading.
2. Host/Join screens, PeerJS wiring, QR + copy.
3. Deck selection and init/done/results protocol with validation.
4. Swipe gestures + `localStorage` resume.
5. Results screen, reconnect/error states, GitHub Pages deploy check.
