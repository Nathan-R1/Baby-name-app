// Baby Names: link-based play, no server.
//
// 1. One player creates a game and shares an invite link. The link holds the
//    rules (which names, how many) and a random seed, so both phones build the
//    exact same deck in the same order.
// 2. Both players swipe on their own phones, at the same time or not.
// 3. Whoever finishes first sends a "picks" link (rules + their yes/no answers
//    packed as one bit per name). Opening it on the other phone, after
//    finishing, compares the picks and shows the matches.
// 4. Optionally, a "results" link (rules + matches only) can be sent back.
//
// Everything lives after the "#" in links, so it is never sent to the web
// server. Progress is saved in localStorage. Links are untrusted input and are
// validated before use; names are rendered with textContent only.

const NAME_FILES = [
  ["boy", "boy-names.txt"],
  ["girl", "girl-names.txt"],
  ["both", "both-names.txt"],
];
const LINK_VERSION = "1";
const MAX_NAME_LENGTH = 30;
const SEED_LENGTH = 10;
const ID_LENGTH = 8;
const SEED_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const STORAGE_PREFIX = "bn2:";
const GENDER_LABELS = { a: "names", b: "boy names", g: "girl names" };
const TOKEN_RE = /^1\.([0-9a-z]{4,10})\.([abg])\.([1-9][0-9]{0,3})\.([0-9a-z]{8,16})$/;
const ID_RE = /^[0-9a-z]{6,16}$/;
const BITS_RE = /^[A-Za-z0-9_-]{1,2000}$/;

const $ = (id) => document.getElementById(id);

const screenEls = {
  landing: $("screen-landing"),
  setup: $("screen-setup"),
  invite: $("screen-invite"),
  intro: $("screen-intro"),
  game: $("screen-game"),
  done: $("screen-done"),
  results: $("screen-results"),
};

const ui = {
  btnNew: $("btn-new"),
  resumeCard: $("resume-card"),
  resumeText: $("resume-text"),
  btnResume: $("btn-resume"),
  landingPaste: $("landing-paste"),
  landingPasteInput: $("landing-paste-input"),
  landingHint: $("landing-hint"),
  setupBack: $("setup-back"),
  setupForm: $("setup-form"),
  setupName: $("setup-name"),
  setupGender: $("setup-gender"),
  setupCount: $("setup-count"),
  inviteBack: $("invite-back"),
  inviteSummary: $("invite-summary"),
  inviteQr: $("invite-qr"),
  inviteShare: $("invite-share"),
  inviteStart: $("invite-start"),
  introBack: $("intro-back"),
  introForm: $("intro-form"),
  introSummary: $("intro-summary"),
  introNote: $("intro-note"),
  introName: $("intro-name"),
  gameBack: $("game-back"),
  progressText: $("progress-text"),
  progressFill: $("progress-fill"),
  gameBanner: $("game-banner"),
  card: $("card"),
  cardName: $("card-name"),
  hintNo: $("hint-no"),
  hintYes: $("hint-yes"),
  btnNo: $("btn-no"),
  btnFinish: $("btn-finish"),
  btnYes: $("btn-yes"),
  doneBack: $("done-back"),
  doneSummary: $("done-summary"),
  doneQr: $("done-qr"),
  doneShare: $("done-share"),
  donePaste: $("done-paste"),
  donePasteInput: $("done-paste-input"),
  resultsBack: $("results-back"),
  resultsIcon: $("results-icon"),
  resultsTitle: $("results-title"),
  resultsSubtitle: $("results-subtitle"),
  resultsList: $("results-list"),
  resultsShare: $("results-share"),
  resultsNew: $("results-new"),
  resultsHint: $("results-hint"),
  toast: $("toast"),
};

// Name IDs are indexes into `names`, built by concatenating NAME_FILES in
// order. `listFingerprint` changes whenever the lists change, so links made
// with a different list are rejected instead of showing the wrong names.
let names = [];
let namePools = { boy: [], girl: [], both: [] };
let listFingerprint = "";

let game = null; // the game currently on screen (see newGameRecord)
let currentScreen = "landing";
let toastTimer = null;
let busy = false;
let drag = null;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function randomString(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += SEED_ALPHABET[byte % SEED_ALPHABET.length];
  return out;
}

function cleanName(value, fallback) {
  const cleaned = String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return cleaned || fallback;
}

// FNV-1a, 32-bit.
function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Small seeded PRNG (mulberry32) so both phones shuffle identically.
function seededRandom(seedText) {
  let a = hash32(`deck:${seedText}`);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pack a list of booleans into base64url (one bit each).
function encodeBits(flags) {
  const bytes = new Uint8Array(Math.ceil(flags.length / 8));
  flags.forEach((on, i) => {
    if (on) bytes[i >> 3] |= 1 << (i & 7);
  });
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Unpack base64url into exactly `count` booleans. Returns null if malformed.
function decodeBits(text, count) {
  if (typeof text !== "string" || !BITS_RE.test(text)) return null;
  let binary;
  try {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/");
    binary = atob(padded + "===".slice((padded.length + 3) % 4));
  } catch {
    return null;
  }
  if (binary.length !== Math.ceil(count / 8)) return null;
  const flags = [];
  for (let i = 0; i < count; i += 1) {
    flags.push(((binary.charCodeAt(i >> 3) >> (i & 7)) & 1) === 1);
  }
  return flags;
}

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    toast("Could not save progress. Storage may be full or disabled.");
  }
}

function setRoute(hash) {
  // replaceState: no hashchange event, and the back button won't re-open links.
  const url = `${location.pathname}${location.search}${hash}`;
  history.replaceState(null, "", url);
}

function baseUrl() {
  return `${location.origin}${location.pathname}${location.search}`;
}

function showScreen(name) {
  Object.entries(screenEls).forEach(([key, el]) => {
    el.classList.toggle("active", key === name);
  });
  currentScreen = name;
  window.scrollTo(0, 0);
}

function toast(message, duration = 3400) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    ui.toast.hidden = true;
  }, duration);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

// Use the phone's share sheet when there is one, otherwise copy the link.
async function shareLink(url, text) {
  if (navigator.share) {
    try {
      await navigator.share({ title: "Baby Names", text, url });
      return;
    } catch (error) {
      if (error && error.name === "AbortError") return;
    }
  }
  const copied = await copyText(url);
  toast(copied ? "Link copied. Paste it to your partner." : "Copy failed. Long-press the QR code instead.");
}

function renderQr(container, text) {
  container.replaceChildren();
  try {
    const qr = qrcode(0, "L");
    qr.addData(text);
    qr.make();
    const svgText = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true, alt: "QR code" });
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    container.appendChild(document.importNode(doc.documentElement, true));
  } catch {
    container.textContent = "QR code unavailable";
  }
}

// ---------------------------------------------------------------------------
// Names and decks
// ---------------------------------------------------------------------------

async function loadNameFile(file) {
  const response = await fetch(file, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${file} returned ${response.status}`);
  const text = await response.text();
  return text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function loadNames() {
  const lists = await Promise.all(NAME_FILES.map(([, file]) => loadNameFile(file)));
  const all = [];
  const pools = {};
  NAME_FILES.forEach(([key], index) => {
    pools[key] = lists[index].map((_, offset) => all.length + offset);
    all.push(...lists[index]);
  });
  if (!all.length) throw new Error("the name lists are empty");
  const fingerprint = hash32(
    NAME_FILES.map(([key], index) => `${key}:${lists[index].join("\n")}`).join("\n\n")
  )
    .toString(36)
    .padStart(7, "0");
  return { all, pools, fingerprint };
}

function poolFor(gender) {
  if (gender === "b") return namePools.boy.concat(namePools.both);
  if (gender === "g") return namePools.girl.concat(namePools.both);
  return Array.from({ length: names.length }, (_, index) => index);
}

function buildDeck(gender, count, seed) {
  const ids = poolFor(gender);
  const random = seededRandom(seed);
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, count);
}

function populateCountOptions() {
  const available = poolFor(ui.setupGender.value).length;
  const values = [10, 20, 30, 50, 75, 100, 150, 200, 300].filter((v) => v < available);
  values.push(available);
  const previous = Number(ui.setupCount.value);
  ui.setupCount.replaceChildren();
  for (const value of values) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = value === available ? `All ${available}` : String(value);
    ui.setupCount.appendChild(option);
  }
  if (values.includes(previous)) ui.setupCount.value = String(previous);
  else if (previous > available) ui.setupCount.value = String(available);
  else ui.setupCount.value = String(values.includes(30) ? 30 : values[0]);
}

function describeRules(rules) {
  return `${rules.count} ${GENDER_LABELS[rules.gender]}`;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function makeToken(rules) {
  return [LINK_VERSION, listFingerprint, rules.gender, rules.count, rules.seed].join(".");
}

// Returns { rules } or { error } for a game token from a link.
function parseToken(token) {
  const match = typeof token === "string" ? token.match(TOKEN_RE) : null;
  if (!match) return { error: "That link isn't a valid Baby Names link." };
  const [, fingerprint, gender, countText, seed] = match;
  if (fingerprint !== listFingerprint) {
    return {
      error:
        "That link was made with a different list of names. Make sure you both have the latest version of the page, then start a new game.",
    };
  }
  const count = Number(countText);
  if (count < 1 || count > poolFor(gender).length) {
    return { error: "That link asks for more names than this list has." };
  }
  return { rules: { gender, count, seed } };
}

function linkFor(params) {
  const query = new URLSearchParams();
  query.set("g", makeToken(game.rules));
  Object.entries(params).forEach(([key, value]) => query.set(key, value));
  query.set("n", game.myName);
  query.set("f", game.me);
  return `${baseUrl()}#${query.toString()}`;
}

function inviteLink() {
  return linkFor({});
}

function picksLink() {
  return linkFor({ p: encodeBits(game.deck.map((_, i) => game.liked.has(i))) });
}

function resultsLink() {
  const matches = new Set(game.results);
  return linkFor({ m: encodeBits(game.deck.map((_, i) => matches.has(i))) });
}

// Accepts a full link, or just the part after "#". Returns URLSearchParams or null.
function paramsFromText(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  const hashIndex = value.indexOf("#");
  const fragment = hashIndex >= 0 ? value.slice(hashIndex + 1) : value;
  if (fragment.length > 4000) return null;
  const params = new URLSearchParams(fragment);
  return params.has("g") ? params : null;
}

// ---------------------------------------------------------------------------
// Saved games
// ---------------------------------------------------------------------------

function storageKey(seed) {
  return `${STORAGE_PREFIX}game:${seed}`;
}

function newGameRecord(rules) {
  return {
    rules,
    deck: buildDeck(rules.gender, rules.count, rules.seed),
    me: randomString(ID_LENGTH), // tells our own links apart from the partner's
    creator: false, // true on the phone that created the game
    myName: "",
    started: false,
    index: 0,
    liked: new Set(),
    done: false,
    partnerName: "",
    partnerId: "",
    partnerPicks: null, // array of booleans, or null
    results: null, // array of deck positions, or null
    resultsFromPartner: false,
  };
}

function saveGame() {
  if (!game) return;
  const data = {
    v: 1,
    token: makeToken(game.rules),
    me: game.me,
    creator: game.creator,
    myName: game.myName,
    started: game.started,
    index: game.index,
    liked: [...game.liked],
    done: game.done,
    partnerName: game.partnerName,
    partnerId: game.partnerId,
    partnerPicks: game.partnerPicks ? encodeBits(game.partnerPicks) : null,
    results: game.results,
    resultsFromPartner: game.resultsFromPartner,
  };
  writeStorage(storageKey(game.rules.seed), JSON.stringify(data));
  writeStorage(`${STORAGE_PREFIX}active`, game.rules.seed);
}

function loadGame(seed) {
  let raw;
  try {
    raw = JSON.parse(readStorage(storageKey(seed)) || "null");
  } catch {
    return null;
  }
  if (!raw || raw.v !== 1) return null;
  const parsed = parseToken(raw.token);
  if (!parsed.rules || parsed.rules.seed !== seed) return null;
  const record = newGameRecord(parsed.rules);
  const count = record.deck.length;
  const isPosition = (i) => Number.isInteger(i) && i >= 0 && i < count;

  if (typeof raw.me === "string" && ID_RE.test(raw.me)) record.me = raw.me;
  record.creator = raw.creator === true;
  record.myName = cleanName(raw.myName, "");
  record.started = raw.started === true;
  record.index = Number.isInteger(raw.index) ? Math.max(0, Math.min(raw.index, count)) : 0;
  record.liked = new Set(Array.isArray(raw.liked) ? raw.liked.filter(isPosition) : []);
  record.done = raw.done === true || record.index >= count;
  record.partnerName = cleanName(raw.partnerName, "");
  record.partnerId = typeof raw.partnerId === "string" && ID_RE.test(raw.partnerId) ? raw.partnerId : "";
  record.partnerPicks = raw.partnerPicks ? decodeBits(raw.partnerPicks, count) : null;
  record.results = Array.isArray(raw.results) ? raw.results.filter(isPosition) : null;
  record.resultsFromPartner = raw.resultsFromPartner === true;
  return record;
}

function activeGame() {
  const seed = readStorage(`${STORAGE_PREFIX}active`);
  return seed ? loadGame(seed) : null;
}

// ---------------------------------------------------------------------------
// Opening links
// ---------------------------------------------------------------------------

function openFromParams(params) {
  const parsed = parseToken(params.get("g"));
  if (!parsed.rules) {
    showLanding(parsed.error);
    return;
  }
  const { rules } = parsed;
  const senderId = params.get("f") || "";
  const senderName = cleanName(params.get("n"), "");

  game = loadGame(rules.seed) || newGameRecord(rules);
  const count = game.deck.length;

  if (senderId && senderId === game.me) {
    // Our own link, opened on our own phone.
    saveGame();
    toast("That's your own link. Send it to your partner instead.", 5000);
    resumeGame();
    return;
  }

  if (senderId && ID_RE.test(senderId)) game.partnerId = senderId;
  if (senderName) game.partnerName = senderName;

  if (params.has("m")) {
    const flags = decodeBits(params.get("m"), count);
    if (!flags) {
      showLanding("That results link looks damaged. Ask your partner to send it again.");
      return;
    }
    let matches = flags.flatMap((on, i) => (on ? [i] : []));
    // If we have our own picks here, only keep names we actually said yes to.
    if (game.started) matches = matches.filter((i) => game.liked.has(i));
    game.results = matches;
    game.resultsFromPartner = true;
    game.done = true;
    saveGame();
    showResults();
    return;
  }

  if (params.has("p")) {
    const flags = decodeBits(params.get("p"), count);
    if (!flags) {
      showLanding("That picks link looks damaged. Ask your partner to send it again.");
      return;
    }
    game.partnerPicks = flags;
    if (!game.resultsFromPartner) game.results = null;
    saveGame();
    if (game.done) {
      computeResults();
      showResults();
    } else {
      resumeGame();
    }
    return;
  }

  // Plain invite.
  saveGame();
  resumeGame();
}

function resumeGame() {
  if (!game) {
    showLanding();
    return;
  }
  if (game.results) showResults();
  else if (game.done) showDone();
  else if (game.started) showGame();
  else if (game.creator) showInvite();
  else showIntro();
}

function routeFromHash() {
  const fragment = location.hash.replace(/^#/, "");
  if (!fragment) {
    showLanding();
    return;
  }
  const params = new URLSearchParams(fragment);
  if (params.has("g")) {
    // Swap the long link for a short one, so reloading resumes from storage.
    const parsed = parseToken(params.get("g"));
    if (parsed.rules) setRoute(`#game=${parsed.rules.seed}`);
    openFromParams(params);
    return;
  }
  const seed = params.get("game");
  if (seed && /^[0-9a-z]{8,16}$/.test(seed)) {
    game = loadGame(seed);
    if (game) {
      resumeGame();
      return;
    }
  }
  setRoute("");
  showLanding();
}

function openPastedLink(text) {
  const params = paramsFromText(text);
  if (!params) {
    toast("That doesn't look like a Baby Names link.");
    return;
  }
  const parsed = parseToken(params.get("g"));
  if (parsed.rules) setRoute(`#game=${parsed.rules.seed}`);
  openFromParams(params);
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function showLanding(error) {
  showScreen("landing");
  setRoute("");
  ui.landingPasteInput.value = "";
  const active = activeGame();
  if (active) {
    ui.resumeCard.hidden = false;
    ui.resumeText.textContent = active.results
      ? "Matches ready"
      : active.done
        ? "Waiting for your partner's link"
        : `${describeRules(active.rules)} · ${active.index} swiped`;
  } else {
    ui.resumeCard.hidden = true;
  }
  if (error) {
    ui.landingHint.textContent = error;
    ui.landingHint.style.color = "var(--no)";
  } else {
    ui.landingHint.textContent = "No account needed. Everything stays on your phones.";
    ui.landingHint.style.color = "";
  }
}

function showSetup() {
  showScreen("setup");
  populateCountOptions();
  ui.setupName.focus();
}

function showInvite() {
  showScreen("invite");
  setRoute(`#game=${game.rules.seed}`);
  ui.inviteSummary.textContent = `${describeRules(game.rules)}. Send this link to your partner so you both get the same names.`;
  renderQr(ui.inviteQr, inviteLink());
}

function showIntro() {
  showScreen("intro");
  setRoute(`#game=${game.rules.seed}`);
  const who = game.partnerName || "Your partner";
  ui.introSummary.textContent = `${who} invited you to swipe through ${describeRules(game.rules)}.`;
  if (game.partnerPicks) {
    ui.introNote.textContent = `${who} has already finished. Your matches will show as soon as you're done.`;
    ui.introNote.hidden = false;
  } else {
    ui.introNote.hidden = true;
  }
  if (!ui.introName.value) ui.introName.value = game.myName;
}

function showGame() {
  showScreen("game");
  setRoute(`#game=${game.rules.seed}`);
  renderGame();
}

function showDone() {
  showScreen("done");
  setRoute(`#game=${game.rules.seed}`);
  const who = game.partnerName || "your partner";
  ui.doneSummary.textContent = `You said yes to ${game.liked.size} of ${game.deck.length}. Send your picks to ${who} so they can see your matches when they finish.`;
  ui.donePasteInput.value = "";
  renderQr(ui.doneQr, picksLink());
}

function computeResults() {
  if (!game.partnerPicks) return;
  game.results = game.deck
    .map((_, i) => i)
    .filter((i) => game.liked.has(i) && game.partnerPicks[i]);
  game.resultsFromPartner = false;
  saveGame();
}

function showResults() {
  showScreen("results");
  setRoute(`#game=${game.rules.seed}`);
  const matches = game.results || [];
  const who = game.partnerName || "your partner";
  ui.resultsList.replaceChildren();

  if (matches.length) {
    ui.resultsIcon.classList.remove("empty");
    ui.resultsTitle.textContent = matches.length === 1 ? "It's a match!" : `${matches.length} matches!`;
    ui.resultsSubtitle.textContent = `Names you and ${who} both said yes to.`;
    for (const i of matches) {
      const item = document.createElement("li");
      item.className = "match";
      item.textContent = names[game.deck[i]] || "Unknown";
      ui.resultsList.appendChild(item);
    }
  } else {
    ui.resultsIcon.classList.add("empty");
    ui.resultsTitle.textContent = "No matches yet";
    ui.resultsSubtitle.textContent = `You and ${who} didn't both say yes to any names this time. Try a new game.`;
  }

  // Results we worked out ourselves can be sent back; ones we received can't.
  const canSend = !game.resultsFromPartner;
  ui.resultsShare.hidden = !canSend;
  ui.resultsHint.hidden = !canSend;
}

// ---------------------------------------------------------------------------
// Swiping
// ---------------------------------------------------------------------------

function renderGame() {
  const total = game.deck.length;
  const shown = Math.min(game.index, total);
  ui.progressText.textContent = `${shown} of ${total}`;
  ui.progressFill.style.width = total ? `${(shown / total) * 100}%` : "0%";
  ui.cardName.textContent =
    game.index < total ? names[game.deck[game.index]] || "Unknown" : "All done";

  if (game.partnerPicks) {
    ui.gameBanner.textContent = `${game.partnerName || "Your partner"} has finished. Your matches will show when you're done.`;
    ui.gameBanner.hidden = false;
  } else {
    ui.gameBanner.hidden = true;
  }
  updateGameButtons();
}

function canSwipe() {
  return currentScreen === "game" && !busy && game && !game.done && game.index < game.deck.length;
}

function updateGameButtons() {
  const enabled = canSwipe();
  ui.btnYes.disabled = !enabled;
  ui.btnNo.disabled = !enabled;
  ui.btnFinish.disabled = !enabled;
}

function finishGame() {
  if (game.done) return;
  game.done = true;
  saveGame();
  if (game.partnerPicks) {
    computeResults();
    showResults();
  } else {
    showDone();
  }
}

function recordSwipe(liked) {
  if (liked) game.liked.add(game.index);
  game.index += 1;
  saveGame();
  if (game.index >= game.deck.length) finishGame();
}

function updateHints(dx) {
  const strength = Math.min(1, Math.abs(dx) / 120);
  ui.hintNo.style.opacity = dx < 0 ? String(strength) : "0";
  ui.hintYes.style.opacity = dx > 0 ? String(strength) : "0";
}

function snapBack() {
  ui.card.style.transition = "transform 180ms ease, opacity 180ms ease";
  ui.card.style.transform = "";
  ui.card.style.opacity = "";
  updateHints(0);
  setTimeout(() => {
    if (!drag) ui.card.style.transition = "";
  }, 190);
}

function commitSwipe(direction) {
  if (!canSwipe()) return;
  drag = null;
  busy = true;
  updateGameButtons();
  ui.card.classList.remove("dragging");
  ui.card.style.transition = "transform 220ms ease, opacity 220ms ease";
  ui.card.style.transform = `translate(${direction * 135}%, 0) rotate(${direction * 16}deg)`;
  ui.card.style.opacity = "0";

  setTimeout(() => {
    ui.card.style.transition = "none";
    ui.card.style.transform = "";
    ui.card.style.opacity = "";
    updateHints(0);
    busy = false;
    recordSwipe(direction === 1);
    if (currentScreen === "game") {
      renderGame();
      requestAnimationFrame(() => {
        ui.card.style.transition = "";
      });
    }
  }, 210);
}

function onPointerDown(event) {
  if (!canSwipe()) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, dx: 0 };
  ui.card.classList.add("dragging");
  ui.card.style.transition = "none";
  try {
    ui.card.setPointerCapture(event.pointerId);
  } catch {}
}

function onPointerMove(event) {
  if (!drag || event.pointerId !== drag.id) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  drag.dx = dx;
  const rotation = Math.max(-18, Math.min(18, dx / 14));
  ui.card.style.transform = `translate(${dx}px, ${dy * 0.18}px) rotate(${rotation}deg)`;
  updateHints(dx);
  event.preventDefault();
}

function onPointerUp(event) {
  if (!drag || event.pointerId !== drag.id) return;
  const dx = drag.dx;
  drag = null;
  ui.card.classList.remove("dragging");
  try {
    ui.card.releasePointerCapture(event.pointerId);
  } catch {}
  const threshold = Math.max(56, Math.min(120, ui.card.clientWidth * 0.28));
  if (dx >= threshold) commitSwipe(1);
  else if (dx <= -threshold) commitSwipe(-1);
  else snapBack();
}

function onPointerCancel(event) {
  if (!drag || event.pointerId !== drag.id) return;
  drag = null;
  ui.card.classList.remove("dragging");
  snapBack();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function bindEvents() {
  window.addEventListener("hashchange", routeFromHash);

  ui.btnNew.addEventListener("click", showSetup);
  ui.btnResume.addEventListener("click", () => {
    game = activeGame();
    resumeGame();
  });
  ui.landingPaste.addEventListener("submit", (event) => {
    event.preventDefault();
    openPastedLink(ui.landingPasteInput.value);
  });

  ui.setupBack.addEventListener("click", () => showLanding());
  ui.setupGender.addEventListener("change", populateCountOptions);
  ui.setupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const gender = ["a", "b", "g"].includes(ui.setupGender.value) ? ui.setupGender.value : "a";
    const available = poolFor(gender).length;
    const count = Math.max(1, Math.min(Number.parseInt(ui.setupCount.value, 10) || 30, available));
    game = newGameRecord({ gender, count, seed: randomString(SEED_LENGTH) });
    game.myName = cleanName(ui.setupName.value, "Your partner");
    game.creator = true;
    saveGame();
    showInvite();
  });

  ui.inviteBack.addEventListener("click", () => showLanding());
  ui.inviteShare.addEventListener("click", () => {
    shareLink(inviteLink(), `Let's pick baby names! ${describeRules(game.rules)}:`);
  });
  ui.inviteStart.addEventListener("click", () => {
    game.started = true;
    saveGame();
    showGame();
  });

  ui.introBack.addEventListener("click", () => showLanding());
  ui.introForm.addEventListener("submit", (event) => {
    event.preventDefault();
    game.myName = cleanName(ui.introName.value, "Your partner");
    game.started = true;
    saveGame();
    showGame();
  });

  ui.gameBack.addEventListener("click", () => showLanding());
  ui.btnNo.addEventListener("click", () => commitSwipe(-1));
  ui.btnYes.addEventListener("click", () => commitSwipe(1));
  ui.btnFinish.addEventListener("click", () => {
    if (!canSwipe()) return;
    if (window.confirm("Finish with the names you've said yes to so far?")) finishGame();
  });

  ui.card.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove, { passive: false });
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);
  window.addEventListener("keydown", (event) => {
    if (currentScreen !== "game" || busy) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      commitSwipe(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      commitSwipe(1);
    }
  });

  ui.doneBack.addEventListener("click", () => showLanding());
  ui.doneShare.addEventListener("click", () => {
    shareLink(picksLink(), "I've finished swiping baby names! Open this to see our matches:");
  });
  ui.donePaste.addEventListener("submit", (event) => {
    event.preventDefault();
    openPastedLink(ui.donePasteInput.value);
  });

  ui.resultsBack.addEventListener("click", () => showLanding());
  ui.resultsShare.addEventListener("click", () => {
    shareLink(resultsLink(), "Here are our baby name matches:");
  });
  ui.resultsNew.addEventListener("click", showSetup);
}

async function init() {
  bindEvents();
  ui.btnNew.disabled = true;
  try {
    const loaded = await loadNames();
    names = loaded.all;
    namePools = loaded.pools;
    listFingerprint = loaded.fingerprint;
  } catch (error) {
    ui.landingHint.textContent = "Could not load the name lists. Check the deployment and reload.";
    ui.landingHint.style.color = "var(--no)";
    toast(`Could not load names (${error.message}).`, 8000);
    return;
  }
  ui.btnNew.disabled = false;
  routeFromHash();
}

init();
