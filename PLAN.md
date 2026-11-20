# Baby Names v2 — GitHub Pages Plan

## Goals

- Run as a **static site on GitHub Pages**: no server, no database, no accounts.
- Two players (the couple) swipe the **same deck of names** on their own phones,
  on any network, at the same time or not.
- Only **links** are exchanged, through whatever messaging app the couple already uses.
- Treat every link as **untrusted input**: validate everything, render names with `textContent` only.

## Files

- `index.html` — screens: landing, new game, invite, intro (invited), swipe, done, results
- `app.js` — routing, deck building, link encoding, swiping, matching
- `styles.css`
- `boy-names.txt`, `girl-names.txt`, `both-names.txt` — loaded at startup and joined in that order;
  a name's ID is its position in the combined list
- `qrcode.js` — vendored, for QR codes of links
- `serve.py` — local dev server (not used in production)

## Flow

1. **Create**: a player picks names (all / boy / girl; boy and girl include unisex) and how many.
   The app makes a random seed.
2. **Invite**: the invite link holds the rules + seed. Both phones build the identical deck
   with a seeded shuffle, so no name IDs are ever sent.
3. **Swipe**: both players swipe independently. Progress is saved in `localStorage`.
4. **Compare**: whoever finishes first sends a **picks link** (rules + their answers, one bit per
   name). The other player opens it; once they've finished too, the matches are shown.
5. **Results back (optional)**: a **results link** holds only the matches, not the other picks.

Every link also works as an invite, so opening a picks link before playing starts the game.

## Link format

Everything is in the fragment (after `#`), so it never reaches the web server.

```
#g=1.<listFingerprint>.<a|b|g>.<count>.<seed>&p=<bits>&m=<bits>&n=<name>&f=<senderId>
```

- `g` — version, a fingerprint of the name lists, gender, count, seed
- `p` — sender's picks; `m` — matches only (base64url bitsets over deck positions)
- `n` — sender's display name; `f` — sender's per-game ID (detects opening your own link)

The **list fingerprint** means a link made with a different version of the name files is
rejected with a clear message instead of showing the wrong names.

## Trade-offs

- Not live: a link has to be sent at the end.
- A picks link contains all of the sender's "yes" answers. The app only shows matches,
  but someone determined could decode the rest. Results links contain only the matches.
- Progress is per browser. A link opened in a different browser (e.g. a messaging app's
  in-app browser) won't see saved progress; the paste boxes let you open it in the right one.
- Changing the name files invalidates links for games in progress.
