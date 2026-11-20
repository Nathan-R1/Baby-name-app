const PEER_PREFIX = "bnam-";
const PEER_OPTIONS = Object.assign({ debug: 0 }, window.BABY_NAMES_PEER_OPTIONS || {});
const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const CODE_LENGTH = 6;
const MAX_NAME_LENGTH = 30;
const MAX_RECONNECT_ATTEMPTS = 30;
const SESSION_VERSION = 1;
const SESSION_TOKEN_KEY = "bn:token";

const $ = (id) => document.getElementById(id);

const screenEls = {
  landing: $("screen-landing"),
  "host-setup": $("screen-host-setup"),
  join: $("screen-join"),
  waiting: $("screen-waiting"),
  game: $("screen-game"),
  results: $("screen-results"),
};

const ui = {
  btnHost: $("btn-host"),
  btnJoin: $("btn-join"),
  resumeCard: $("resume-card"),
  resumeCode: $("resume-code"),
  btnResume: $("btn-resume"),
  hostBack: $("host-back"),
  hostForm: $("host-form"),
  hostName: $("host-name"),
  hostGender: $("host-gender"),
  hostCount: $("host-count"),
  hostError: $("host-error"),
  joinBack: $("join-back"),
  joinForm: $("join-form"),
  joinCode: $("join-code"),
  joinName: $("join-name"),
  joinError: $("join-error"),
  joinStatus: $("join-status"),
  joinSubmit: $("join-submit"),
  waitingLeave: $("waiting-leave"),
  waitingCode: $("waiting-code"),
  qr: $("qr"),
  copyLink: $("copy-link"),
  waitingStatus: $("waiting-status"),
  waitingYou: $("waiting-you"),
  waitingPartnerRow: $("waiting-partner-row"),
  waitingPartner: $("waiting-partner"),
  gameLeave: $("game-leave"),
  progressText: $("progress-text"),
  progressFill: $("progress-fill"),
  gameRole: $("game-role"),
  gameBanner: $("game-banner"),
  card: $("card"),
  cardName: $("card-name"),
  hintNo: $("hint-no"),
  hintYes: $("hint-yes"),
  gameOverlay: $("game-overlay"),
  overlayTitle: $("overlay-title"),
  overlayMessage: $("overlay-message"),
  overlaySpinner: $("overlay-spinner"),
  btnNo: $("btn-no"),
  btnFinish: $("btn-finish"),
  btnYes: $("btn-yes"),
  gameStatus: $("game-status"),
  resultsIcon: $("results-icon"),
  resultsTitle: $("results-title"),
  resultsSubtitle: $("results-subtitle"),
  resultsList: $("results-list"),
  resultsHome: $("results-home"),
  toast: $("toast"),
};

let names = [];
// Name IDs are indexes into `names`, built by concatenating these files in this
// order. Both players load the same files, so IDs match on each side.
const NAME_FILES = [
  ["boy", "boy-names.txt"],
  ["girl", "girl-names.txt"],
  ["both", "both-names.txt"],
];
// IDs for each file, e.g. namePools.boy = [0, 1, ...].
let namePools = { boy: [], girl: [], both: [] };
let currentScreen = "landing";
let ignoreHashChange = false;
let toastTimer = null;
let busy = false;
let drag = null;

function createState() {
  return {
    role: null,
    code: null,
    displayName: "",
    partnerName: "",
    token: getSessionToken(),
    peer: null,
    conn: null,
    connected: false,
    peerOpen: false,
    everConnected: false,
    partnerConnectedOnce: false,
    allowReconnect: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    waitingError: "",
    deck: [],
    liked: new Set(),
    index: 0,
    localDone: false,
    remoteDone: false,
    remoteLiked: new Set(),
    results: null,
  };
}

let state = createState();

function getSessionToken() {
  try {
    let token = sessionStorage.getItem(SESSION_TOKEN_KEY);
    if (!token) {
      token = randomToken();
      sessionStorage.setItem(SESSION_TOKEN_KEY, token);
    }
    return token;
  } catch {
    return randomToken();
  }
}

function randomToken() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function randomCode() {
  let code = "";
  if (window.crypto && typeof window.crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(CODE_LENGTH);
    window.crypto.getRandomValues(bytes);
    for (let i = 0; i < CODE_LENGTH; i += 1) {
      code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return code;
  }
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

function cleanName(value, fallback) {
  const cleaned = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return cleaned || fallback;
}

function normalizeCode(raw) {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value) return null;

  const embedded = value.match(/(?:#join=|join=)([a-z0-9]{4,12})/i);
  if (embedded) return embedded[1].toLowerCase();

  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const fromHash = url.hash.match(/join=([a-z0-9]{4,12})/i);
      if (fromHash) return fromHash[1].toLowerCase();
    } catch {
      return null;
    }
  }

  value = value.replace(/^#/, "").split(/[\s?#&/]/)[0].toLowerCase();
  return /^[a-z0-9]{4,12}$/.test(value) ? value : null;
}

function joinUrl(code) {
  return `${location.origin}${location.pathname}${location.search}#join=${code}`;
}

function sessionKey(code, role) {
  return `bn:${code}:${role}`;
}

function activeKey(role) {
  return `bn:active:${role}`;
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

function removeStorage(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

function readJson(key) {
  const raw = readStorage(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isValidDeck(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > names.length) return false;
  const seen = new Set();
  for (const id of value) {
    if (!Number.isInteger(id) || id < 0 || id >= names.length || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

function normalizeIdList(value, deckSet, max) {
  if (!Array.isArray(value) || value.length > max) return null;
  const out = [];
  const seen = new Set();
  for (const id of value) {
    if (!Number.isInteger(id) || !deckSet.has(id) || seen.has(id)) return null;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function persist() {
  if (!state.role || !state.code) return;
  const data = {
    version: SESSION_VERSION,
    role: state.role,
    code: state.code,
    displayName: state.displayName,
    partnerName: state.partnerName,
    partnerConnectedOnce: state.partnerConnectedOnce,
    deck: state.deck.slice(),
    liked: [...state.liked],
    index: state.index,
    localDone: state.localDone,
    results: Array.isArray(state.results) ? state.results.slice() : null,
    updatedAt: Date.now(),
  };
  if (state.role === "host") {
    data.remoteDone = state.remoteDone;
    data.remoteLiked = [...state.remoteLiked];
  }
  writeStorage(sessionKey(state.code, state.role), JSON.stringify(data));
  writeStorage(activeKey(state.role), state.code);
}

function loadSession(code, role) {
  if (!code) return null;
  const raw = readJson(sessionKey(code, role));
  if (!raw || raw.version !== SESSION_VERSION || raw.role !== role || raw.code !== code) {
    return null;
  }
  if (!isValidDeck(raw.deck)) return null;

  const deck = raw.deck.slice();
  const deckSet = new Set(deck);
  const liked = normalizeIdList(raw.liked, deckSet, deck.length);
  if (liked === null) return null;

  let index = Number.isInteger(raw.index) ? raw.index : 0;
  index = Math.max(0, Math.min(index, deck.length));

  let results = null;
  if (raw.results !== null && raw.results !== undefined) {
    results = normalizeIdList(raw.results, deckSet, deck.length);
    if (results === null) return null;
  }

  const remoteLiked = raw.remoteLiked
    ? normalizeIdList(raw.remoteLiked, deckSet, deck.length)
    : [];
  if (remoteLiked === null) return null;

  return {
    version: SESSION_VERSION,
    role,
    code,
    displayName: cleanName(raw.displayName, role === "host" ? "Host" : "Partner"),
    partnerName: cleanName(raw.partnerName, role === "host" ? "Partner" : "Host"),
    partnerConnectedOnce: raw.partnerConnectedOnce === true,
    deck,
    liked,
    index,
    localDone: raw.localDone === true || index >= deck.length,
    results,
    remoteDone: raw.remoteDone === true,
    remoteLiked,
  };
}

function findActiveSession(role) {
  const code = readStorage(activeKey(role));
  if (!code) return null;
  const session = loadSession(code, role);
  if (!session) {
    removeStorage(activeKey(role));
    return null;
  }
  return session;
}

function resetState() {
  clearReconnectTimer();
  destroyPeer();
  state = createState();
}

function destroyPeer() {
  const peer = state.peer;
  state.peer = null;
  state.conn = null;
  state.connected = false;
  state.peerOpen = false;
  if (peer) {
    try {
      peer.destroy();
    } catch {}
  }
}

function clearReconnectTimer() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

function setHash(hash) {
  const target = hash && hash !== "#" ? (hash.startsWith("#") ? hash : `#${hash}`) : "";
  if (location.hash === target) return;
  ignoreHashChange = true;
  location.hash = target;
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

async function copyWithToast(text, successMessage) {
  const copied = await copyText(text);
  toast(copied ? successMessage : "Copy failed. Select the text and copy it manually.");
}

function showJoinError(message) {
  ui.joinError.textContent = message;
  ui.joinError.hidden = false;
}

function hideJoinError() {
  ui.joinError.hidden = true;
  ui.joinError.textContent = "";
}

function setJoinStatus(message) {
  ui.joinStatus.textContent = message || "";
}

function showHostError(message) {
  ui.hostError.textContent = message;
  ui.hostError.hidden = false;
}

function hideHostError() {
  ui.hostError.hidden = true;
  ui.hostError.textContent = "";
}

function updateWaitingStatus() {
  if (currentScreen !== "waiting") return;
  if (state.waitingError) {
    ui.waitingStatus.textContent = state.waitingError;
    return;
  }
  if (state.connected) {
    ui.waitingStatus.textContent = "Partner connected. Starting…";
  } else if (state.peerOpen) {
    ui.waitingStatus.textContent = "Waiting for your partner to join…";
  } else {
    ui.waitingStatus.textContent = "Starting lobby…";
  }
}

function updateWaitingPlayers() {
  if (currentScreen !== "waiting") return;
  ui.waitingYou.textContent = `You (${state.displayName})`;
  const dot = ui.waitingPartnerRow.querySelector(".dot");
  if (state.connected) {
    ui.waitingPartner.textContent = `${state.partnerName} connected`;
    ui.waitingPartnerRow.classList.remove("muted");
    if (dot) dot.classList.add("on");
  } else {
    ui.waitingPartner.textContent = "Partner not connected";
    ui.waitingPartnerRow.classList.add("muted");
    if (dot) dot.classList.remove("on");
  }
}

function renderQr(text) {
  ui.qr.replaceChildren();
  try {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const svgText = qr.createSvgTag({
      cellSize: 6,
      margin: 2,
      scalable: true,
      alt: "Lobby invite QR code",
    });
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const svg = document.importNode(doc.documentElement, true);
    ui.qr.appendChild(svg);
  } catch {
    ui.qr.textContent = "QR code unavailable";
  }
}

function renderWaiting() {
  showScreen("waiting");
  ui.waitingCode.textContent = state.code.toUpperCase();
  renderQr(joinUrl(state.code));
  updateWaitingPlayers();
  updateWaitingStatus();
}

function showLanding() {
  showScreen("landing");
  const active = findActiveSession("host") || findActiveSession("joiner");
  if (active) {
    ui.resumeCard.hidden = false;
    ui.resumeCode.textContent = active.code.toUpperCase();
    ui.resumeCard.dataset.role = active.role;
    ui.resumeCard.dataset.code = active.code;
  } else {
    ui.resumeCard.hidden = true;
    delete ui.resumeCard.dataset.role;
    delete ui.resumeCard.dataset.code;
  }
}

function showHostSetup() {
  showScreen("host-setup");
  hideHostError();
  ui.hostName.focus();
}

function showJoinSetup(code, displayName) {
  showScreen("join");
  ui.joinCode.value = code ? code.toUpperCase() : "";
  if (displayName !== undefined) ui.joinName.value = displayName;
  hideJoinError();
  setJoinStatus("");
  ui.joinSubmit.disabled = false;
  if (!code) ui.joinCode.focus();
}

function showGame() {
  showScreen("game");
  renderGame();
}

function updateProgressUi() {
  const total = state.deck.length;
  const shown = Math.min(state.index, total);
  ui.progressText.textContent = `${shown} of ${total}`;
  ui.progressFill.style.width = total ? `${(shown / total) * 100}%` : "0%";
}

function updateCardFace() {
  if (state.index < state.deck.length) {
    const id = state.deck[state.index];
    ui.cardName.textContent = names[id] || "Unknown";
  } else {
    ui.cardName.textContent = state.localDone ? "All done" : "…";
  }
}

function setBanner(message) {
  if (message) {
    ui.gameBanner.textContent = message;
    ui.gameBanner.hidden = false;
  } else {
    ui.gameBanner.hidden = true;
    ui.gameBanner.textContent = "";
  }
}

function setOverlay(title, message, spinner) {
  ui.gameOverlay.hidden = false;
  ui.overlayTitle.textContent = title;
  ui.overlayMessage.textContent = message;
  ui.overlaySpinner.hidden = !spinner;
}

function hideOverlay() {
  ui.gameOverlay.hidden = true;
}

function updateGameButtons() {
  const canSwipe =
    !busy &&
    !state.localDone &&
    state.index < state.deck.length &&
    (state.role === "host" || state.connected);
  ui.btnYes.disabled = !canSwipe;
  ui.btnNo.disabled = !canSwipe;
  ui.btnFinish.disabled =
    busy ||
    state.localDone ||
    state.index >= state.deck.length ||
    (state.role === "joiner" && !state.connected);
}

function updateGameUI() {
  if (currentScreen !== "game") return;
  updateGameButtons();
  ui.gameRole.textContent = state.role === "host" ? "Host" : "Joined";

  if (state.role === "joiner" && !state.connected && !state.localDone) {
    setBanner("");
    setOverlay("Reconnecting…", "Trying to reconnect to your partner. Your progress is saved.", true);
    ui.gameStatus.textContent = "Reconnecting…";
    return;
  }

  if (state.localDone) {
    if (!state.connected) {
      setOverlay(
        state.role === "host" ? "Partner disconnected" : "Reconnecting…",
        state.role === "host"
          ? "Waiting for your partner to reconnect. Your progress is saved."
          : "Trying to reconnect to your partner. Your progress is saved.",
        true
      );
      ui.gameStatus.textContent = "Waiting for your partner to reconnect.";
    } else {
      setOverlay("You are done", "Waiting for your partner to finish.", true);
      ui.gameStatus.textContent = "Waiting for your partner to finish.";
    }
    setBanner("");
    return;
  }

  if (state.role === "host" && !state.connected) {
    hideOverlay();
    setBanner("Partner disconnected — waiting for them to reconnect.");
    ui.gameStatus.textContent = "You can keep swiping. Your progress is saved.";
    return;
  }

  if (state.role === "host" && state.remoteDone) {
    hideOverlay();
    setBanner("Your partner finished. Keep swiping — matches are shown at the end.");
    ui.gameStatus.textContent = "Partner is waiting for you.";
    return;
  }

  hideOverlay();
  setBanner("");
  ui.gameStatus.textContent =
    state.role === "host"
      ? "Your partner is swiping on their phone."
      : "Swipe right for names you love.";
}

function renderGame() {
  updateProgressUi();
  updateCardFace();
  updateGameUI();
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

function recordSwipe(liked) {
  const id = state.deck[state.index];
  if (Number.isInteger(id)) {
    if (liked) state.liked.add(id);
    state.index += 1;
  }
  persist();
  updateProgressUi();
  if (state.index >= state.deck.length) {
    finishLocal();
  }
}

function commitSwipe(direction) {
  if (busy || state.localDone || state.index >= state.deck.length) return;
  if (state.role === "joiner" && !state.connected) return;
  if (currentScreen !== "game") return;

  drag = null;
  busy = true;
  updateGameButtons();
  ui.card.classList.remove("dragging");
  ui.card.style.transition = "transform 220ms ease, opacity 220ms ease";
  ui.card.style.transform = `translate(${direction * 135}%, 0) rotate(${direction * 16}deg)`;
  ui.card.style.opacity = "0";

  setTimeout(() => {
    recordSwipe(direction === 1);
    ui.card.style.transition = "none";
    ui.card.style.transform = "";
    ui.card.style.opacity = "";
    updateHints(0);
    busy = false;
    if (currentScreen === "game" && !state.results) {
      renderGame();
      requestAnimationFrame(() => {
        ui.card.style.transition = "";
        updateGameButtons();
      });
    }
  }, 210);
}

function onPointerDown(event) {
  if (busy || state.localDone || state.index >= state.deck.length) return;
  if (state.role === "joiner" && !state.connected) return;
  if (currentScreen !== "game") return;
  if (event.pointerType === "mouse" && event.button !== 0) return;

  drag = {
    id: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    dx: 0,
  };
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
  if (dx >= threshold) {
    commitSwipe(1);
  } else if (dx <= -threshold) {
    commitSwipe(-1);
  } else {
    snapBack();
  }
}

function onPointerCancel(event) {
  if (!drag || event.pointerId !== drag.id) return;
  drag = null;
  ui.card.classList.remove("dragging");
  snapBack();
}

function finishLocal() {
  if (state.localDone) return;
  state.localDone = true;
  persist();
  if (state.role === "joiner") {
    sendDone();
    updateGameUI();
  } else if (state.remoteDone) {
    finalizeHost();
  } else {
    updateGameUI();
  }
}

function sendToPeer(payload) {
  const conn = state.conn;
  if (!conn || !conn.open) return false;
  try {
    conn.send(payload);
    return true;
  } catch {
    return false;
  }
}

function sendInit() {
  sendToPeer({
    type: "init",
    deck: state.deck.slice(),
    total: state.deck.length,
    hostName: state.displayName,
  });
}

function sendResults() {
  if (!Array.isArray(state.results)) return false;
  return sendToPeer({ type: "results", matches: state.results.slice() });
}

function sendHello() {
  if (state.role !== "joiner") return;
  sendToPeer({ type: "hello", name: state.displayName });
}

function sendDone() {
  if (state.role !== "joiner" || !state.localDone) return;
  sendToPeer({
    type: "done",
    liked: [...state.liked],
    name: state.displayName,
  });
}

function parseMessage(raw) {
  let value = raw;
  if (typeof value === "string") {
    if (value.length > 100000) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.type !== "string" || value.type.length > 32) return null;
  return value;
}

function handleHostMessage(raw) {
  const message = parseMessage(raw);
  if (!message) return;
  if (message.type === "hello") {
    if (typeof message.name !== "string") return;
    state.partnerName = cleanName(message.name, state.partnerName || "Partner");
    persist();
    updateWaitingPlayers();
    return;
  }
  if (message.type !== "done" || state.results) return;

  const deckSet = new Set(state.deck);
  const liked = normalizeIdList(message.liked, deckSet, state.deck.length);
  if (!liked) return;

  state.remoteDone = true;
  state.remoteLiked = new Set(liked);
  if (typeof message.name === "string") {
    state.partnerName = cleanName(message.name, state.partnerName);
  }
  persist();
  updateWaitingPlayers();

  if (state.localDone) {
    finalizeHost();
  } else {
    updateGameUI();
  }
}

function finalizeHost() {
  if (state.role !== "host" || state.results) return;
  if (!state.localDone || !state.remoteDone) return;

  state.results = state.deck.filter(
    (id) => state.liked.has(id) && state.remoteLiked.has(id)
  );
  persist();
  sendResults();
  showResults();
}

function handleJoinerMessage(raw) {
  const message = parseMessage(raw);
  if (!message) return;
  if (message.type === "init") {
    handleInit(message);
  } else if (message.type === "results") {
    handleResults(message);
  } else if (message.type === "error") {
    handleHostError(message);
  } else if (message.type === "replaced") {
    handleReplaced(message);
  }
}

function handleInit(message) {
  if (state.role !== "joiner") return;
  if (!isValidDeck(message.deck)) {
    state.allowReconnect = false;
    clearReconnectTimer();
    destroyPeer();
    failJoin("The host sent an invalid deck. Please try joining again.");
    return;
  }

  const deck = message.deck.slice();
  const sameDeck =
    state.deck.length === deck.length && state.deck.every((id, i) => id === deck[i]);

  if (!sameDeck) {
    state.deck = deck;
    state.liked = new Set();
    state.index = 0;
    state.localDone = false;
    state.results = null;
  } else {
    state.deck = deck;
  }

  state.partnerName = cleanName(message.hostName, "Host");
  state.connected = true;
  state.everConnected = true;
  state.reconnectAttempts = 0;
  clearReconnectTimer();
  state.allowReconnect = true;

  if (state.results) {
    persist();
    setHash(`#join=${state.code}`);
    showResults();
    return;
  }

  persist();
  setHash(`#join=${state.code}`);
  hideJoinError();
  setJoinStatus("");
  showGame();

  if (state.localDone) {
    sendDone();
    updateGameUI();
  }
}

function handleResults(message) {
  if (state.role !== "joiner" || !state.deck.length) return;
  const deckSet = new Set(state.deck);
  const matches = normalizeIdList(message.matches, deckSet, state.deck.length);
  if (!matches) return;

  state.results = matches;
  state.localDone = true;
  state.allowReconnect = false;
  clearReconnectTimer();
  persist();
  showResults();
}

function handleHostError(message) {
  if (state.results) return;
  const text = cleanName(message.message, "The host could not accept the connection.");
  state.allowReconnect = false;
  clearReconnectTimer();
  destroyPeer();
  failJoin(text);
}

function handleReplaced(message) {
  if (state.results) return;
  state.allowReconnect = false;
  clearReconnectTimer();
  destroyPeer();
  const text = cleanName(
    message.message,
    "This lobby was reopened in another tab or device."
  );
  if (currentScreen === "game") {
    setOverlay("Lobby reconnected elsewhere", text, false);
    ui.gameStatus.textContent = "Disconnected.";
    updateGameButtons();
  } else {
    failJoin(text);
  }
}

function showResults() {
  showScreen("results");
  const matches = Array.isArray(state.results) ? state.results : [];
  ui.resultsList.replaceChildren();

  if (matches.length) {
    ui.resultsIcon.classList.remove("empty");
    ui.resultsTitle.textContent =
      matches.length === 1 ? "It's a match!" : `${matches.length} matches!`;
    ui.resultsSubtitle.textContent = "Names you both swiped yes on.";
    for (const id of matches) {
      const item = document.createElement("li");
      item.className = "match";
      item.textContent = names[id] || "Unknown";
      ui.resultsList.appendChild(item);
    }
  } else {
    ui.resultsIcon.classList.add("empty");
    ui.resultsTitle.textContent = "No matches yet";
    ui.resultsSubtitle.textContent =
      "You did not both say yes to any names this time. Try again with a new deck.";
  }
}

function showReconnectUi(message) {
  if (currentScreen === "game") {
    setOverlay(
      "Reconnecting…",
      message || "Trying to reconnect to your partner. Your progress is saved.",
      true
    );
    ui.gameStatus.textContent = "Reconnecting…";
    updateGameButtons();
  } else if (currentScreen === "join") {
    setJoinStatus(message || "Reconnecting to the lobby…");
    ui.joinSubmit.disabled = true;
  }
}

function scheduleJoinerReconnect(message) {
  if (!state.allowReconnect || state.results) return;
  if (state.reconnectTimer) return;

  if (!state.everConnected) {
    failJoin("Could not connect to the lobby. Please try again.");
    return;
  }

  state.reconnectAttempts += 1;
  if (state.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    state.allowReconnect = false;
    if (currentScreen === "game") {
      setOverlay(
        "Connection lost",
        "Could not reconnect. Ask the host to reopen the lobby, then reload this page.",
        false
      );
      ui.gameStatus.textContent = "Disconnected.";
      updateGameButtons();
    } else {
      failJoin("Could not reconnect to the lobby. Ask the host to reopen it, then try again.");
    }
    return;
  }

  const delay = Math.min(1200 + state.reconnectAttempts * 300, 3000);
  showReconnectUi(message);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connectJoinerPeer();
  }, delay);
}

function handleJoinerDisconnect() {
  if (state.results || !state.allowReconnect) return;
  if (!state.everConnected) {
    failJoin("Lost connection while joining. Please try again.");
    return;
  }
  showReconnectUi();
  scheduleJoinerReconnect();
}

function handleJoinerUnavailable() {
  if (state.everConnected) {
    scheduleJoinerReconnect("Lobby temporarily unavailable. Reconnecting…");
  } else {
    failJoin(
      "Could not find that lobby. Check the code and make sure the host is still on the lobby screen."
    );
  }
}

function connectJoinerPeer() {
  if (state.role !== "joiner" || !state.code || state.results) return;

  if (state.peer) {
    const oldPeer = state.peer;
    state.peer = null;
    try {
      oldPeer.destroy();
    } catch {}
  }

  let peer;
  try {
    peer = new Peer(PEER_OPTIONS);
  } catch {
    scheduleJoinerReconnect("Could not start the connection. Retrying…");
    return;
  }

  state.peer = peer;
  state.connected = false;
  state.peerOpen = false;

  peer.on("open", () => {
    if (state.peer !== peer) return;
    state.peerOpen = true;
    // No metadata: anything in it is relayed through the signaling server.
    // Identifying info goes over the encrypted data channel instead (sendHello).
    const conn = peer.connect(`${PEER_PREFIX}${state.code}`, {
      reliable: true,
    });
    state.conn = conn;

    const onOpen = () => {
      if (state.conn !== conn) return;
      state.connected = true;
      state.everConnected = true;
      state.reconnectAttempts = 0;
      clearReconnectTimer();
      hideJoinError();
      if (currentScreen === "join") {
        setJoinStatus("Connected. Waiting for the host…");
      } else if (currentScreen === "game") {
        setOverlay("Connected", "Syncing your deck…", true);
      }
      sendHello();
      if (state.localDone) sendDone();
      updateGameUI();
    };

    conn.on("open", onOpen);
    conn.on("data", (data) => {
      if (state.conn === conn) handleJoinerMessage(data);
    });
    conn.on("close", () => {
      if (state.conn !== conn) return;
      state.conn = null;
      state.connected = false;
      handleJoinerDisconnect();
    });
    conn.on("error", () => {
      if (state.conn !== conn) return;
      state.conn = null;
      state.connected = false;
      handleJoinerDisconnect();
    });

    if (conn.open) onOpen();
  });

  peer.on("error", (error) => {
    if (state.peer !== peer) return;
    if (error && error.type === "peer-unavailable") {
      state.connected = false;
      handleJoinerUnavailable();
      return;
    }
    if (
      error &&
      (error.type === "network" ||
        error.type === "server-error" ||
        error.type === "socket-error" ||
        error.type === "socket-closed")
    ) {
      state.connected = false;
      handleJoinerDisconnect();
      return;
    }
    if (!state.everConnected) {
      failJoin(`Could not connect (${error && error.type ? error.type : "unknown error"}).`);
    } else {
      scheduleJoinerReconnect();
    }
  });

  peer.on("disconnected", () => {
    if (state.peer !== peer) return;
    state.peerOpen = false;
    setTimeout(() => {
      if (state.peer === peer && !peer.destroyed) {
        try {
          peer.reconnect();
        } catch {}
      }
    }, 1000);
  });
}

function beginJoinerConnection() {
  if (state.role !== "joiner" || !state.code) return;
  if (state.results) {
    showResults();
    return;
  }
  state.allowReconnect = true;
  clearReconnectTimer();
  connectJoinerPeer();
}

function failJoin(message) {
  state.allowReconnect = false;
  clearReconnectTimer();
  destroyPeer();
  persist();
  ui.joinSubmit.disabled = false;
  setJoinStatus("");
  showJoinSetup(state.code, state.displayName);
  showJoinError(message);
}

function startHostPeer({ resuming = false, attempt = 0 } = {}) {
  if (!state.code || state.role !== "host") return;

  if (state.peer) {
    const oldPeer = state.peer;
    state.peer = null;
    try {
      oldPeer.destroy();
    } catch {}
  }

  let peer;
  try {
    peer = new Peer(`${PEER_PREFIX}${state.code}`, PEER_OPTIONS);
  } catch {
    state.waitingError = "Could not start the lobby. Check your connection and try again.";
    updateWaitingStatus();
    return;
  }

  state.peer = peer;
  state.peerOpen = false;
  let settled = false;

  peer.on("open", () => {
    if (state.peer !== peer) return;
    settled = true;
    state.peerOpen = true;
    state.waitingError = "";
    updateWaitingStatus();
    updateWaitingPlayers();
  });

  peer.on("connection", (conn) => {
    if (state.peer !== peer) {
      try {
        conn.close();
      } catch {}
      return;
    }
    handleIncomingConnection(conn);
  });

  peer.on("error", (error) => {
    if (state.peer !== peer) return;

    if (error && error.type === "unavailable-id") {
      state.peerOpen = false;

      if (resuming) {
        if (attempt < 10) {
          const failedPeer = state.peer;
          state.peer = null;
          try {
            failedPeer.destroy();
          } catch {}
          state.waitingError = "Reopening your lobby…";
          updateWaitingStatus();
          setTimeout(() => {
            if (state.role === "host" && !state.peer) {
              startHostPeer({ resuming: true, attempt: attempt + 1 });
            }
          }, 1200);
        } else {
          state.waitingError = "Could not reopen the lobby. Try again in a moment.";
          updateWaitingStatus();
        }
        return;
      }

      if (attempt < 10) {
        const oldCode = state.code;
        const failedPeer = state.peer;
        state.peer = null;
        try {
          failedPeer.destroy();
        } catch {}
        removeStorage(sessionKey(oldCode, "host"));
        state.code = randomCode();
        persist();
        renderWaiting();
        startHostPeer({ resuming: false, attempt: attempt + 1 });
      } else {
        state.waitingError = "Could not create a lobby code. Please try again.";
        updateWaitingStatus();
      }
      return;
    }

    if (
      error &&
      (error.type === "network" ||
        error.type === "server-error" ||
        error.type === "socket-error" ||
        error.type === "socket-closed")
    ) {
      state.waitingError = "Connecting to the signaling service…";
      updateWaitingStatus();
      return;
    }

    if (!settled) {
      state.waitingError = `Could not start the lobby (${error && error.type ? error.type : "unknown error"}).`;
      updateWaitingStatus();
    } else {
      toast("Connection issue. Your lobby is still saved.");
    }
  });

  peer.on("disconnected", () => {
    if (state.peer !== peer) return;
    state.peerOpen = false;
    updateWaitingStatus();
    updateWaitingPlayers();
    setTimeout(() => {
      if (state.peer === peer && !peer.destroyed) {
        try {
          peer.reconnect();
        } catch {}
      }
    }, 1200);
  });

  peer.on("close", () => {
    if (state.peer !== peer) return;
    state.peerOpen = false;
    updateWaitingStatus();
    updateWaitingPlayers();
  });
}

function handleIncomingConnection(conn) {
  if (state.role !== "host") {
    try {
      conn.close();
    } catch {}
    return;
  }

  const previous = state.conn;
  if (previous && previous !== conn) {
    if (previous.open) {
      try {
        previous.send({
          type: "replaced",
          message: "This lobby was reopened in another tab or device.",
        });
      } catch {}
    }
    setTimeout(() => {
      try {
        previous.close();
      } catch {}
    }, 0);
  }

  state.conn = conn;
  state.connected = false;
  state.waitingError = "";

  // The partner's name arrives later in a "hello" message over the data channel.
  state.partnerName = cleanName(state.partnerName, "Partner");

  if (!state.results) {
    state.remoteDone = false;
    state.remoteLiked = new Set();
  }

  let opened = false;
  const onOpen = () => {
    if (opened || state.conn !== conn) return;
    opened = true;
    state.connected = true;
    state.partnerConnectedOnce = true;
    state.waitingError = "";
    persist();
    sendInit();
    if (state.results) {
      sendResults();
      showResults();
      return;
    }
    showGame();
  };

  conn.on("open", onOpen);
  conn.on("data", (data) => {
    if (state.conn === conn) handleHostMessage(data);
  });
  conn.on("close", () => {
    if (state.conn !== conn) return;
    state.conn = null;
    state.connected = false;
    if (!state.results) {
      state.remoteDone = false;
      state.remoteLiked = new Set();
      persist();
    }
    updateWaitingPlayers();
    updateWaitingStatus();
    if (currentScreen === "game") updateGameUI();
  });
  conn.on("error", () => {
    if (state.conn !== conn) return;
    state.conn = null;
    state.connected = false;
    updateWaitingPlayers();
    if (currentScreen === "game") updateGameUI();
  });

  if (conn.open) onOpen();
}

function restoreHost(saved) {
  resetState();
  state.role = "host";
  state.code = saved.code;
  state.displayName = saved.displayName;
  state.partnerName = saved.partnerName;
  state.partnerConnectedOnce = saved.partnerConnectedOnce;
  state.deck = saved.deck;
  state.liked = new Set(saved.liked);
  state.index = saved.index;
  state.localDone = saved.localDone;
  state.remoteDone = saved.results ? saved.remoteDone : false;
  state.remoteLiked = saved.results ? new Set(saved.remoteLiked) : new Set();
  state.results = saved.results;
  state.allowReconnect = true;
}

function restoreJoiner(saved) {
  resetState();
  state.role = "joiner";
  state.code = saved.code;
  state.displayName = saved.displayName;
  state.partnerName = saved.partnerName;
  state.deck = saved.deck;
  state.liked = new Set(saved.liked);
  state.index = saved.index;
  state.localDone = saved.localDone;
  state.results = saved.results;
  state.everConnected = saved.deck.length > 0;
  state.allowReconnect = !saved.results;
}

function poolFor(gender) {
  if (gender === "boy") return namePools.boy.concat(namePools.both);
  if (gender === "girl") return namePools.girl.concat(namePools.both);
  return Array.from({ length: names.length }, (_, index) => index);
}

function buildDeck(count, gender) {
  const ids = poolFor(gender);
  const total = Math.max(
    1,
    Math.min(Number.isInteger(count) ? count : ids.length, ids.length)
  );
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, total);
}

function populateCountOptions() {
  const available = poolFor(ui.hostGender.value).length;
  const values = [10, 20, 30, 50, 75, 100, 150, 200, 300].filter(
    (value) => value < available
  );
  values.push(available);
  const previous = Number(ui.hostCount.value);
  ui.hostCount.replaceChildren();

  for (const value of values) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = value === available ? `All ${available}` : String(value);
    ui.hostCount.appendChild(option);
  }

  if (values.includes(previous)) {
    ui.hostCount.value = String(previous);
  } else if (previous > available) {
    ui.hostCount.value = String(available);
  } else {
    ui.hostCount.value = String(values.includes(30) ? 30 : values[0]);
  }
}

function startNewHostLobby(displayName, count, gender) {
  const oldHost = findActiveSession("host");
  if (oldHost) {
    removeStorage(sessionKey(oldHost.code, "host"));
    if (readStorage(activeKey("host")) === oldHost.code) {
      removeStorage(activeKey("host"));
    }
  }

  resetState();
  state.role = "host";
  state.displayName = cleanName(displayName, "Host");
  state.code = randomCode();
  state.partnerName = "Partner";
  state.deck = buildDeck(count, gender);
  state.allowReconnect = true;
  persist();

  setHash("#lobby");
  renderWaiting();
  startHostPeer({ resuming: false, attempt: 0 });
}

function resumeSession(role, code) {
  const saved = loadSession(code, role);
  if (!saved) {
    toast("That lobby is no longer saved.");
    setHash("#");
    showLanding();
    return;
  }

  if (role === "host") {
    restoreHost(saved);
    setHash("#lobby");
    renderWaiting();
    if (state.results) {
      showResults();
    } else if (state.partnerConnectedOnce) {
      showGame();
    }
    startHostPeer({ resuming: true, attempt: 0 });
    return;
  }

  restoreJoiner(saved);
  setHash(`#join=${saved.code}`);
  if (state.results) {
    showResults();
    return;
  }
  showJoinSetup(saved.code, saved.displayName);
  setJoinStatus("Connecting to lobby…");
  ui.joinSubmit.disabled = true;
  beginJoinerConnection();
}

function resumeHostFromStorage() {
  const saved = findActiveSession("host");
  if (!saved) {
    setHash("#");
    showLanding();
    return;
  }
  resumeSession("host", saved.code);
}

function startJoin(code, displayName) {
  const saved = loadSession(code, "joiner");
  if (saved) {
    restoreJoiner(saved);
    state.displayName = cleanName(displayName, saved.displayName);
  } else {
    resetState();
    state.role = "joiner";
    state.code = code;
    state.displayName = cleanName(displayName, "Partner");
    state.allowReconnect = true;
  }

  persist();

  if (state.results) {
    setHash(`#join=${code}`);
    showResults();
    return;
  }

  setHash(`#join=${code}`);
  ui.joinCode.value = code.toUpperCase();
  ui.joinName.value = state.displayName;
  showScreen("join");
  hideJoinError();
  setJoinStatus("Connecting to lobby…");
  ui.joinSubmit.disabled = true;
  beginJoinerConnection();
}

function leaveLobby() {
  if (!state.role) {
    setHash("#");
    showLanding();
    return;
  }

  const role = state.role;
  const code = state.code;
  if (role && code) {
    removeStorage(sessionKey(code, role));
    if (readStorage(activeKey(role)) === code) {
      removeStorage(activeKey(role));
    }
  }
  state.allowReconnect = false;
  resetState();
  setHash("#");
  showLanding();
}

function goHome() {
  if (!state.role) {
    setHash("#");
    showLanding();
    return;
  }
  if (!window.confirm("Leave this lobby? Your progress will be removed.")) return;
  leaveLobby();
}

function backToLanding() {
  if (!state.role) {
    setHash("#");
    showLanding();
    return;
  }
  if (state.deck.length || state.localDone) {
    if (!window.confirm("Leave this lobby? Your progress will be removed.")) return;
  }
  leaveLobby();
}

function goHomeFromResults() {
  leaveLobby();
}

function suspendActive() {
  if (!state.role) return;
  persist();
  state.allowReconnect = false;
  resetState();
}

function routeFromHash() {
  const hash = location.hash.replace(/^#/, "");

  if (hash === "host") {
    if (state.role === "host" && state.peer) {
      if (state.results) showResults();
      else if (state.partnerConnectedOnce) showGame();
      else renderWaiting();
    } else {
      if (state.role) suspendActive();
      showHostSetup();
    }
    return;
  }

  if (hash === "lobby") {
    if (state.role === "host" && state.code) {
      if (state.results) showResults();
      else if (state.partnerConnectedOnce) showGame();
      else renderWaiting();
    } else {
      if (state.role) suspendActive();
      resumeHostFromStorage();
    }
    return;
  }

  if (hash === "join" || hash.startsWith("join=")) {
    const code = hash.startsWith("join=") ? normalizeCode(hash.slice(5)) : null;

    if (
      state.role === "joiner" &&
      state.code &&
      state.peer &&
      (!code || code === state.code)
    ) {
      if (state.results) showResults();
      else if (state.deck.length) showGame();
      else showJoinSetup(state.code, state.displayName);
      return;
    }

    if (state.role) suspendActive();

    const saved = code ? loadSession(code, "joiner") : null;
    if (saved && saved.results) {
      restoreJoiner(saved);
      showResults();
      return;
    }

    showJoinSetup(code);
    if (saved && saved.deck.length) {
      restoreJoiner(saved);
      ui.joinName.value = saved.displayName;
      setJoinStatus("Connecting to lobby…");
      ui.joinSubmit.disabled = true;
      beginJoinerConnection();
    }
    return;
  }

  if (state.role) suspendActive();
  showLanding();
}

async function loadNameFile(file) {
  const response = await fetch(file, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`${file} returned ${response.status}`);
  }
  const text = await response.text();
  return text
    .replace(/^\uFEFF/, "")
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
  if (!all.length) {
    throw new Error("the name lists are empty");
  }
  return { all, pools };
}

function bindEvents() {
  window.addEventListener("hashchange", () => {
    if (ignoreHashChange) {
      ignoreHashChange = false;
      return;
    }
    routeFromHash();
  });

  ui.btnHost.addEventListener("click", () => {
    setHash("#host");
    showHostSetup();
  });

  ui.btnJoin.addEventListener("click", () => {
    setHash("#join");
    showJoinSetup("");
  });

  ui.hostBack.addEventListener("click", backToLanding);
  ui.joinBack.addEventListener("click", backToLanding);

  ui.hostGender.addEventListener("change", () => {
    if (names.length) populateCountOptions();
  });

  ui.hostForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!names.length) {
      showHostError("Names are still loading. Please wait a moment.");
      return;
    }
    hideHostError();
    const count = Number.parseInt(ui.hostCount.value, 10);
    startNewHostLobby(ui.hostName.value, count, ui.hostGender.value);
  });

  ui.joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!names.length) {
      showJoinError("Names are still loading. Please wait a moment.");
      return;
    }
    const code = normalizeCode(ui.joinCode.value);
    if (!code) {
      showJoinError("Enter a valid lobby code or invite link.");
      return;
    }
    hideJoinError();
    startJoin(code, ui.joinName.value);
  });

  ui.btnResume.addEventListener("click", () => {
    const role = ui.resumeCard.dataset.role;
    const code = ui.resumeCard.dataset.code;
    if (!role || !code) {
      showLanding();
      return;
    }
    resumeSession(role, code);
  });

  ui.waitingCode.addEventListener("click", () => {
    if (state.code) copyWithToast(state.code.toUpperCase(), "Lobby code copied.");
  });

  ui.copyLink.addEventListener("click", () => {
    if (state.code) copyWithToast(joinUrl(state.code), "Invite link copied.");
  });

  ui.waitingLeave.addEventListener("click", goHome);
  ui.gameLeave.addEventListener("click", goHome);
  ui.resultsHome.addEventListener("click", goHomeFromResults);

  ui.btnNo.addEventListener("click", () => commitSwipe(-1));
  ui.btnYes.addEventListener("click", () => commitSwipe(1));
  ui.btnFinish.addEventListener("click", () => {
    if (state.localDone) return;
    if (window.confirm("Finish with the names you have liked so far?")) {
      finishLocal();
      updateGameUI();
    }
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
}

async function init() {
  bindEvents();
  try {
    const loaded = await loadNames();
    names = loaded.all;
    namePools = loaded.pools;
    populateCountOptions();
    routeFromHash();
  } catch (error) {
    ui.btnHost.disabled = true;
    ui.btnJoin.disabled = true;
    const hint = document.querySelector("#screen-landing .hint");
    if (hint) {
      hint.textContent = "Could not load the name lists. Check the deployment and reload.";
      hint.style.color = "var(--no)";
    }
    toast(`Could not load names (${error.message}).`, 8000);
  }
}

init();
