// js/app.js

// -----------------------------
// Config
// -----------------------------
const API_URL = (window.EGGHUNT_CONFIG && window.EGGHUNT_CONFIG.API_URL) || "";
const POLL_MS = (window.EGGHUNT_CONFIG && window.EGGHUNT_CONFIG.POLL_MS) || 3000;
const CENTER_LAT = (window.EGGHUNT_CONFIG && window.EGGHUNT_CONFIG.CENTER_LAT) || 39.9612;
const CENTER_LNG = (window.EGGHUNT_CONFIG && window.EGGHUNT_CONFIG.CENTER_LNG) || -82.9988;
// Fallback radii (meters) if backend doesn't return them yet
const DEFAULT_CLAIM_METERS = 25;

// -----------------------------
// State
// -----------------------------
let playerId = localStorage.getItem("eggHunt_playerId") || "";
let playerName = localStorage.getItem("eggHunt_playerName") || "";
let score = Number(localStorage.getItem("eggHunt_score") || "0");

// Team mode
let teamId = localStorage.getItem("eggHunt_teamId") || "";
let teamRole = localStorage.getItem("eggHunt_teamRole") || ""; // PRIMARY | VIEWER
let teamName = localStorage.getItem("eggHunt_teamName") || "";


let map, youMarker, accuracyCircle, primaryMarker;
let lastDevicePos = null;

// Range rings (claim + reveal)
let claimCircle = null;
let revealCircle = null;

// Keep last-known radii (meters) so we can draw even if an API response omits them
let lastClaimMeters = null;
let lastRevealMeters = null;






// Radar state
// Radar state
function radarPlayedKey_() {
  // per-team key so you don't accidentally suppress replay across different teams
  return "eggHunt_lastRadarIdPlayed_" + String(teamId || "");
}

let lastRadarIdPlayed = localStorage.getItem(radarPlayedKey_()) || "";
let radarAnimating = false;
let radarRequestInFlight = false;
let radarPrevView = null; // { center, zoom }
let radarQueuedId_ = "";
let radarActiveId_ = "";
let radarSeenIds_ = new Set();
let eggMarkers = new Map(); // eggId -> Leaflet marker
let lastPos = null;
let startupLoading_ = false;
const FIRST_SETUP_RELOAD_KEY_ = "eggHunt_firstSetupReloadDone";
let gameStartMs = null;
let gameEndMs = null;
let serverClockOffsetMs = 0;
let hasServerClockSync_ = false;
let gameClockIntervalId = null;
let messageFeed_ = [];
let activeMessageOverlayLayers_ = [];
let activeMessageOverlayMessageId_ = "";

// Egg type enums
const EGG_COLORS = ["RED", "BLUE", "YELLOW"];
const EGG_PATTERNS = ["SOLID", "DOT", "STRIPE", "CROWN"];

function eggFillColor_(color) {
  switch (String(color || "").toUpperCase()) {
    case "RED": return "#ef4444";
    case "YELLOW": return "#facc15";
    case "BLUE": return "#3b82f6";
    default: return "#ef4444";
  }
}

function eggSizeForZoom_(zoom, pattern) {
  const baseMap = { CROWN: 34, STRIPE: 30, DOT: 28, SOLID: 26 };
  const base = baseMap[String(pattern || "SOLID").toUpperCase()] || 26;

  const baseline = 16;
  const scale = Math.pow(1.18, zoom - baseline);
  const w = Math.round(base * scale);
  const h = Math.round(w * 1.28);

  return {
    w: Math.max(18, Math.min(90, w)),
    h: Math.max(24, Math.min(115, h))
  };
}

function hunterSizeForZoom_(zoom) {
  const z = (typeof zoom === "number") ? zoom : (map ? map.getZoom() : 16);

  // Keep the hunter a little larger than a SOLID egg,
  // but still clearly in the same visual scale family.
  const eggSz = eggSizeForZoom_(z, "SOLID");

  const w = Math.round(eggSz.w * 1.3);
  const h = Math.round(w * 1.3);

  return {
    w: Math.max(20, Math.min(96, w)),
    h: Math.max(20, Math.min(96, h))
  };
}

function eggLabel_(egg) {
  if (String(egg && egg.specialType || "").toUpperCase() === "EGG_PRIME") {
    return "Egg<sup>0</sup>";
  }

  const c = properCase_(egg.color || "RED");
  const p = patternDisplayName_(egg.pattern || "SOLID");
  return c + " " + p;
}

function eggIcon_(color, pattern, zoom) {
  const fill = eggFillColor_(color);
  const z = (typeof zoom === "number") ? zoom : (map ? map.getZoom() : 16);
  const sz = eggSizeForZoom_(z, pattern);
  const w = sz.w, h = sz.h;

  // Unique ids per SVG to avoid collisions
  const uid = "u" + Math.random().toString(36).slice(2, 9);
  const clipId = "eggClip_" + uid;
  const stripesId = "stripes_" + uid;

  const pat = String(pattern || "SOLID").toUpperCase();

  let overlay = "";
  if (pat === "DOT") {
    overlay =
      '<g clip-path="url(#' + clipId + ')" opacity="0.95">' +
        '<circle cx="10" cy="14" r="1.8" fill="rgba(255,255,255,0.9)"/>' +
        '<circle cx="16" cy="18" r="1.6" fill="rgba(255,255,255,0.85)"/>' +
        '<circle cx="12.5" cy="22.5" r="1.7" fill="rgba(255,255,255,0.85)"/>' +
        '<circle cx="18" cy="12.5" r="1.4" fill="rgba(255,255,255,0.8)"/>' +
      "</g>";
  } else if (pat === "STRIPE") {
    overlay =
      '<g clip-path="url(#' + clipId + ')" opacity="0.95">' +
        '<rect x="0" y="0" width="28" height="36" fill="url(#' + stripesId + ')"/>' +
      "</g>";
   } else if (pat === "CROWN") {
    overlay =
      '<g clip-path="url(#' + clipId + ')" opacity="0.95">' +
        '<path d="M8.5 18.5 L11 14.5 L13.5 18.5 L16 14.5 L18.5 18.5 L21 14.5" ' +
          'fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />' +
      "</g>";
  }

  const svg =
    '<svg width="' + w + '" height="' + h + '" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block">' +
      "<defs>" +
        '<filter id="shadow" x="-40%" y="-40%" width="180%" height="180%">' +
          '<feDropShadow dx="0" dy="1.2" stdDeviation="1.2" flood-color="rgba(0,0,0,0.45)"/>' +
        "</filter>" +

        '<clipPath id="' + clipId + '">' +
          '<path transform="translate(0 36) scale(1 -1)" d="M14 2 C9 2, 5.5 6.5, 5 12 C4.4 18.4, 7.3 34, 14 34 C20.7 34, 23.6 18.4, 23 12 C22.5 6.5, 19 2, 14 2 Z" />' +
        "</clipPath>" +

        '<pattern id="' + stripesId + '" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(20)">' +
          '<rect width="6" height="6" fill="rgba(255,255,255,0)"/>' +
          '<rect x="0" y="0" width="3" height="6" fill="rgba(255,255,255,0.55)"/>' +
        "</pattern>" +
      "</defs>" +

      '<path filter="url(#shadow)" transform="translate(0 36) scale(1 -1)" d="M14 2 C9 2, 5.5 6.5, 5 12 C4.4 18.4, 7.3 34, 14 34 C20.7 34, 23.6 18.4, 23 12 C22.5 6.5, 19 2, 14 2 Z" ' +
        'fill="' + fill + '" stroke="rgba(255,255,255,0.85)" stroke-width="1.3" />' +

      overlay +

      '<path transform="translate(0 36) scale(1 -1)" d="M10.5 8.2 C8.6 10.3, 8.0 12.6, 8.0 14.3 C8.0 15.2, 8.2 16.0, 8.6 16.7" ' +
        'fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="2" stroke-linecap="round" />' +
    "</svg>";

  return L.divIcon({
    className: "egg-icon",
    html: svg,
    iconSize: [w, h],
    iconAnchor: [Math.round(w / 2), h - 2],
    popupAnchor: [0, -Math.round(h * 0.85)]
  });
}

function eggPrimeIcon_(iconUrl, zoom) {
  const z = (typeof zoom === "number") ? zoom : (map ? map.getZoom() : 16);
  const sz = eggSizeForZoom_(z, "CROWN");

  const w = Math.round(sz.w * 1.25);
  const h = Math.round(sz.h * 1.25);

  const html =
    '<img src="' + escapeHtml_(iconUrl || "./assets/egg-prime.gif") + '" ' +
    'alt="" ' +
    'style="display:block;width:' + w + 'px;height:' + h + 'px;object-fit:contain;" />';

  return L.divIcon({
    className: "egg-icon egg-icon--prime",
    html: html,
    iconSize: [w, h],
    iconAnchor: [Math.round(w / 2), h - 2],
    popupAnchor: [0, -Math.round(h * 0.85)]
  });
}

// -----------------------------
// UI helpers
// -----------------------------

function showLoading_(message) {
  const overlay = document.getElementById("loadingOverlay");
  const text = document.getElementById("loadingText");
  const subtext = document.getElementById("loadingSubtext");

  const payload = (message && typeof message === "object")
    ? message
    : { text: message || "Working…", subtext: "" };

  if (text) {
    text.textContent = payload.text || "Working…";
  }

  if (subtext) {
    const secondary = String(payload.subtext || "").trim();
    subtext.textContent = secondary;
    subtext.classList.toggle("hidden", !secondary);
  }

  if (overlay) {
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
  }
}

function hideLoading_() {
  const overlay = document.getElementById("loadingOverlay");
  const text = document.getElementById("loadingText");
  const subtext = document.getElementById("loadingSubtext");

  if (text) text.textContent = "Working…";
  if (subtext) {
    subtext.textContent = "";
    subtext.classList.add("hidden");
  }

  if (overlay) {
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
  }
}

function setButtonBusy_(btn, isBusy, busyText) {
  if (!btn) return;
  if (isBusy) {
    if (!btn.dataset.originalText) {
      btn.dataset.originalText = btn.textContent;
    }
    btn.disabled = true;
    btn.classList.add("is-busy");
    if (busyText) btn.textContent = busyText;
  } else {
    btn.disabled = false;
    btn.classList.remove("is-busy");
    if (btn.dataset.originalText) {
      btn.textContent = btn.dataset.originalText;
      delete btn.dataset.originalText;
    }
  }
}

async function runWithLoading_(options, fn) {
  const {
    button = null,
    buttonText = "Working…",
    loadingText = "Working…",
    delayMs = 150
  } = options || {};

  let loadingShown = false;
  const timer = setTimeout(() => {
    loadingShown = true;
    setButtonBusy_(button, true, buttonText);
    showLoading_(loadingText);
  }, delayMs);

  try {
    return await fn();
  } finally {
    clearTimeout(timer);
    if (loadingShown) {
      hideLoading_();
      setButtonBusy_(button, false);
    }
  }
}

function positiveNumberOrNull_(v) {
  if (v === null || v === undefined) return null;
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return n;
}


function $(id) { return document.getElementById(id); }

function escapeHtml_(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function properCase_(s) {
  s = String(s || "").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function patternDisplayName_(pattern) {
  switch (String(pattern || "").toUpperCase()) {
    case "SOLID": return "Base";
    case "DOT": return "Node";
    case "STRIPE": return "Band";
    case "CROWN": return "Waveform";
    default: return properCase_(pattern || "");
  }
}

function formatBonusPercent_(multiplier) {
  return "+" + Math.round(Number(multiplier || 0) * 100) + "%";
}

function formatMetersDisplay_(meters) {
  const n = Number(meters);
  if (!Number.isFinite(n)) return "0";

  // Whole numbers show as integers; otherwise show one decimal max.
  const roundedTenth = Math.round(n * 10) / 10;
  return Number.isInteger(roundedTenth)
    ? String(Math.round(roundedTenth))
    : roundedTenth.toFixed(1);
}

function buildClaimScoreHtml_(label, out, lootMsg) {
  const sb = out && out.scoreBreakdown ? out.scoreBreakdown : null;

  if (!sb) {
    return escapeHtml_(
      "Scanned (" + label + ")\n\nTotal data points: " + Number(out && out.points || 0)
    ).replace(/\n/g, "<br>");
  }

  const firstClaimBonusPoints = Number(sb.firstClaimBonusPoints || 0);
  const fieldLogBonusPoints = Number(sb.fieldLogBonusPoints || 0);
  const challengeBonusPoints = Number(sb.challengeBonusPoints || 0);

  const hasBonuses =
    firstClaimBonusPoints > 0 ||
    fieldLogBonusPoints > 0 ||
    challengeBonusPoints > 0;

  let html = "";
  html += "<div>Scanned (" + escapeHtml_(label) + ")</div>";

  if (!hasBonuses) {
    html += '<div style="margin-top:12px;">Total data points: ' + Number(sb.totalPoints || out.points || 0) + "</div>";
  } else {
    html += '<div style="margin-top:12px;">Base data points for egg: ' + Number(sb.basePoints || 0) + "</div>";

    if (firstClaimBonusPoints > 0) {
      html +=
        '<div style="margin-top:6px;">First scan yield (' +
        escapeHtml_(formatBonusPercent_(sb.multipliers && sb.multipliers.firstClaim)) +
        '): +' +
        firstClaimBonusPoints +
        "</div>";
    }

    if (fieldLogBonusPoints > 0) {
      html +=
        '<div style="margin-top:6px;">Scanner yield (' +
        escapeHtml_(formatBonusPercent_(sb.multipliers && sb.multipliers.fieldLog)) +
        '): +' +
        fieldLogBonusPoints +
        "</div>";
    }

    if (challengeBonusPoints > 0) {
      const challengeName = String(sb.challengeBonusName || "Timed Event Yield");
      html +=
        '<div style="margin-top:6px;">' +
        escapeHtml_(challengeName) +
        ' yield (' +
        escapeHtml_(formatBonusPercent_(sb.multipliers && sb.multipliers.challenge)) +
        '): +' +
        challengeBonusPoints +
        "</div>";
    }

    html +=
      '<div style="margin-top:14px;font-weight:800;font-size:16px;">TOTAL DATA POINTS: ' +
      Number(sb.totalPoints || out.points || 0) +
      "</div>";
  }

  if (lootMsg) {
    html += '<div style="margin-top:14px;white-space:pre-wrap;">' + escapeHtml_(lootMsg) + "</div>";
  }

  return html;
}

function modalSetVisible_(visible) {
  const root = $("appModal");
  if (!root) return;
  root.classList.toggle("hidden", !visible);
  root.setAttribute("aria-hidden", visible ? "false" : "true");
  document.body.style.overflow = visible ? "hidden" : "";
}

function modalCleanup_() {
  const actions = $("appModalActions");
  const body = $("appModalBody");
  const input = $("appModalInput");
  const inputWrap = $("appModalInputWrap");

  if (actions) actions.innerHTML = "";
  if (body) body.innerHTML = "";
  if (input) {
    input.value = "";
    input.onkeydown = null;
  }
  if (inputWrap) inputWrap.classList.add("hidden");

  document.onkeydown = null;
}

function showModal_(opts) {
  opts = opts || {};

  return new Promise((resolve) => {
    const root = $("appModal");
    const title = $("appModalTitle");
    const body = $("appModalBody");
    const actions = $("appModalActions");
    const inputWrap = $("appModalInputWrap");
    const input = $("appModalInput");

    if (!root || !title || !body || !actions || !inputWrap || !input) {
      resolve(null);
      return;
    }

    let finished = false;

    function disableModalActions_() {
      actions.querySelectorAll("button").forEach(function(btn) {
        btn.disabled = true;
        btn.classList.add("is-busy");
      });
    }

    function finish(value) {
      if (finished) return;
      finished = true;
      modalCleanup_();
      modalSetVisible_(false);
      resolve(value);
    }

    title.textContent = opts.title || "Message";
    body.innerHTML = opts.html != null
      ? opts.html
      : escapeHtml_(opts.message || "").replace(/\n/g, "<br>");

    inputWrap.classList.toggle("hidden", !opts.input);
    input.value = opts.defaultValue || "";

    actions.innerHTML = "";

    const buttons = Array.isArray(opts.buttons) && opts.buttons.length
      ? opts.buttons
      : [{ label: "OK", value: true, className: "btn btn--primary" }];

    buttons.forEach((b, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = b.className || "btn";

      if (b.htmlLabel != null) {
        btn.innerHTML = b.htmlLabel;
      } else {
        btn.textContent = b.label || "OK";
      }

      btn.disabled = !!b.disabled;

      if (!b.disabled) {
        btn.onclick = function() {
          if (finished || btn.disabled) return;
          disableModalActions_();

          if (opts.input) {
            finish(input.value);
          } else {
            finish(b.value);
          }
        };
      }

      actions.appendChild(btn);

      if (idx === buttons.length - 1 && !b.disabled) {
        setTimeout(() => btn.focus(), 0);
      }
    });

    root.querySelectorAll("[data-modal-close]").forEach(el => {
      el.onclick = function() {
        if (finished) return;
        if (opts.dismissValue !== undefined) {
          finish(opts.dismissValue);
        }
      };
    });

    document.onkeydown = function(e) {
      if (finished) return;

      if (e.key === "Escape" && opts.dismissValue !== undefined) {
        finish(opts.dismissValue);
        return;
      }

      if (opts.input && e.key === "Enter") {
        e.preventDefault();
        disableModalActions_();
        finish(input.value);
      }
    };

    modalSetVisible_(true);

    if (typeof opts.onRender === "function") {
      opts.onRender({
        root: root,
        body: body,
        actions: actions,
        input: input,
        finish: finish
      });
    }

    if (opts.input) {
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
    }
  });
}

async function modalAlert_(message, title) {
  return showModal_({
    title: title || "Message",
    message: message,
    buttons: [
      { label: "OK", value: true, className: "btn btn--primary" }
    ],
    dismissValue: true
  });
}

async function modalConfirm_(message, title, okLabel, cancelLabel) {
  return showModal_({
    title: title || "Confirm",
    message: message,
    buttons: [
      { label: cancelLabel || "Cancel", value: false, className: "btn" },
      { label: okLabel || "OK", value: true, className: "btn btn--primary" }
    ],
    dismissValue: false
  });
}

async function modalPrompt_(message, defaultValue, title) {
  const out = await showModal_({
    title: title || "Input",
    message: message,
    input: true,
    defaultValue: defaultValue || "",
    buttons: [
      { label: "Cancel", value: null, className: "btn" },
      { label: "OK", value: true, className: "btn btn--primary" }
    ],
    dismissValue: null
  });

  return out;
}

function setStatus(html) {
  var el = $("status");
  if (el) el.innerHTML = html;
}

function setTopStats() {
  $("playerName").textContent = playerName || "-";
  $("score").textContent = String(score || 0);
  $("revealedCount").textContent = String(eggMarkers.size);
}

function formatGameTimeRemaining(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return (
      "T-" +
      String(hours) + ":" +
      String(minutes).padStart(2, "0") + ":" +
      String(seconds).padStart(2, "0")
    );
  }

  return (
    "T-" +
    String(minutes) + ":" +
    String(seconds).padStart(2, "0")
  );
}

function currentServerNowMs_() {
  return Date.now() + serverClockOffsetMs;
}

function gameIsOver_() {
  return Number.isFinite(gameEndMs) && currentServerNowMs_() >= gameEndMs;
}

function renderGameClock_() {
  const el = $("gameClock");
  if (!el) return;

  if (!Number.isFinite(gameStartMs) || !Number.isFinite(gameEndMs)) {
    el.textContent = "Awaiting start";
    return;
  }

  const nowMs = currentServerNowMs_();

  if (nowMs < gameStartMs) {
    el.textContent = "Awaiting start";
    return;
  }

  if (nowMs >= gameEndMs) {
    el.textContent = "Game Over";
    return;
  }

  el.textContent = formatGameTimeRemaining(gameEndMs - nowMs); 
  renderMessageUi_();
}


function applyGameTiming_(payload) {
  if (!payload || !payload.serverNowTs) return;

  const serverNowMs = Date.parse(payload.serverNowTs);
  if (Number.isFinite(serverNowMs)) {
    const measuredOffsetMs = serverNowMs - Date.now();

    if (!hasServerClockSync_) {
      serverClockOffsetMs = measuredOffsetMs;
      hasServerClockSync_ = true;
    } else {
      const driftMs = measuredOffsetMs - serverClockOffsetMs;

      // If we're way off, snap immediately.
      // Otherwise, ease toward the new value to avoid visible jumps.
      if (Math.abs(driftMs) > 1500) {
        serverClockOffsetMs = measuredOffsetMs;
      } else {
        serverClockOffsetMs = serverClockOffsetMs + (driftMs * 0.2);
      }
    }
  }

  const nextStartMs = Date.parse(payload.gameStartTs || "");
  const nextEndMs = Date.parse(payload.gameEndTs || "");

  gameStartMs = Number.isFinite(nextStartMs) ? nextStartMs : null;
  gameEndMs = Number.isFinite(nextEndMs) ? nextEndMs : null;

  renderGameClock_();
}

function startGameClockTicker_() {
  if (gameClockIntervalId) return;
  gameClockIntervalId = setInterval(function() {
    renderGameClock_();
  }, 250);
}

function messageReadKey_() {
  return "eggHunt_readMessages_" + String(teamId || "solo") + "_" + String(playerId || "anon");
}

function getReadMessageIds_() {
  try {
    const raw = localStorage.getItem(messageReadKey_()) || "[]";
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (e) {
    return [];
  }
}

function saveReadMessageIds_(ids) {
  localStorage.setItem(messageReadKey_(), JSON.stringify(Array.from(new Set((ids || []).map(String)))));
}

function isMessageRead_(msg) {
  return getReadMessageIds_().includes(String(msg && msg.id || ""));
}

function markMessageRead_(messageId) {
  messageId = String(messageId || "");
  if (!messageId) return;

  const ids = getReadMessageIds_();
  if (!ids.includes(messageId)) {
    ids.push(messageId);
    saveReadMessageIds_(ids);
  }

  renderMessageUi_();
}

function normalizeOverlayDef_(overlay) {
  overlay = (overlay && typeof overlay === "object") ? overlay : {};

  return {
    overlayType: overlay.overlayType == null ? null : String(overlay.overlayType),
    overlayKey: overlay.overlayKey == null ? null : String(overlay.overlayKey),
    data: overlay.data && typeof overlay.data === "object" ? overlay.data : null
  };
}

function normalizeMessage_(msg) {
  msg = (msg && typeof msg === "object") ? msg : {};

  const startTs = Number(msg.startTs);
  const endTs = Number(msg.endTs);
  const priority = Number(msg.priority);

  let mapOverlays = [];
  if (Array.isArray(msg.mapOverlays)) {
    mapOverlays = msg.mapOverlays
      .map(normalizeOverlayDef_)
      .filter(function(ov) { return !!ov.overlayType; });
  } else if (msg.overlayType || msg.overlayKey) {
    mapOverlays = [
      normalizeOverlayDef_({
        overlayType: msg.overlayType,
        overlayKey: msg.overlayKey,
        data: msg.overlayData || null
      })
    ].filter(function(ov) { return !!ov.overlayType; });
  }


  return {
    id: String(msg.id || ""),
    type: String(msg.type || "info"),
    title: String(msg.title || ""),
    body: String(msg.body || ""),
    bodyHtml: msg.bodyHtml == null ? null : String(msg.bodyHtml),
    startTs: Number.isFinite(startTs) ? startTs : null,
    endTs: Number.isFinite(endTs) ? endTs : null,
    priority: Number.isFinite(priority) ? priority : 0,

    // legacy fields preserved so older UI/debug output won't break
    overlayType: msg.overlayType == null ? null : String(msg.overlayType),
    overlayKey: msg.overlayKey == null ? null : String(msg.overlayKey),

    mapOverlays: mapOverlays,
    eventKey: msg.eventKey == null ? null : String(msg.eventKey)
  };
}

function dedupeMessagesById_(messages) {
  messages = Array.isArray(messages) ? messages : [];

  const seen = new Set();
  const out = [];

  messages.forEach(function(msg) {
    msg = (msg && typeof msg === "object") ? msg : null;
    if (!msg) return;

    const id = String(msg.id || "").trim();

    if (!id) {
      out.push(msg);
      return;
    }

    if (seen.has(id)) return;
    seen.add(id);
    out.push(msg);
  });

  return out;
}

function setMessageFeed_(messages) {
  messageFeed_ = dedupeMessagesById_(
    (Array.isArray(messages) ? messages : []).map(normalizeMessage_)
  );
  renderMessageUi_();
}

function isMessageActive_(msg) {
  const now = currentServerNowMs_();

  if (Number.isFinite(msg.startTs) && now < msg.startTs) return false;
  if (Number.isFinite(msg.endTs) && now > msg.endTs) return false;

  return true;
}

function isMessageExpired_(msg) {
  return Number.isFinite(msg.endTs) && currentServerNowMs_() > msg.endTs;
}

function messageTypeLabel_(type) {
  const t = String(type || "").toLowerCase();
  if (!t) return "Info";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function messageClockLabel_(targetTs) {
  if (!Number.isFinite(targetTs) || !Number.isFinite(gameEndMs)) return "";
  return formatGameTimeRemaining(Math.max(0, gameEndMs - targetTs));
}

function messageStateLabel_(msg) {
  if (isMessageActive_(msg)) return "Active";
  if (isMessageExpired_(msg)) return "Expired";
  return "Upcoming";
}

function compareMessages_(a, b) {
  const aStart = Number.isFinite(a.startTs) ? a.startTs : -Infinity;
  const bStart = Number.isFinite(b.startTs) ? b.startTs : -Infinity;
  if (aStart !== bStart) return bStart - aStart;

  return String(b.id).localeCompare(String(a.id));
}

function getSortedMessages_() {
  return messageFeed_.slice().sort(compareMessages_);
}

function getUnreadMessages_() {
  return getSortedMessages_().filter(function(msg) {
    return !isMessageRead_(msg);
  });
}

function getUnreadActiveMessages_() {
  return getSortedMessages_().filter(function(msg) {
    return isMessageActive_(msg) && !isMessageRead_(msg);
  });
}

function stripHtml_(html) {
  return String(html || "").replace(/<[^>]+>/g, " ");
}

function messagePreviewText_(msg) {
  const type = String(msg && msg.type || "").toLowerCase();
  const eventKey = String(msg && msg.eventKey || "").toLowerCase();
  const title = String(msg && msg.title || "");
  const body = String(msg && msg.body || "").trim();

  const isEggPrime =
    type === "egg_prime" ||
    eventKey.indexOf("egg_prime") >= 0 ||
    /egg\s*(\^?0|prime)/i.test(title) ||
    /egg\s*(\^?0|prime)/i.test(body);

  if (isEggPrime) {
    if (isMessageActive_(msg) && Number.isFinite(msg.endTs)) {
      return "Egg⁰ anomaly active until " + messageClockLabel_(msg.endTs) + ".";
    }

    if (!isMessageActive_(msg) && !isMessageExpired_(msg) && Number.isFinite(msg.startTs)) {
      return "Egg⁰ anomaly expected at " + messageClockLabel_(msg.startTs) + ".";
    }

    if (isMessageExpired_(msg)) {
      return "Egg⁰ anomaly window has closed.";
    }

    return "Egg⁰ anomaly detected.";
  }

  if (!body) return "";
  return body.length > 120 ? body.slice(0, 117) + "..." : body;
}

function buildMessageDetailHtml_(msg) {
  const meta = [];
  const stateLabel = messageStateLabel_(msg);

  meta.push('<span class="messageBadge">' + escapeHtml_(messageTypeLabel_(msg.type)) + '</span>');

  if (!isMessageRead_(msg)) {
    meta.push('<span class="messageBadge messageBadge--unread">Unread</span>');
  }

  if (stateLabel === "Active") {
    meta.push('<span class="messageBadge messageBadge--active">Active</span>');
  } else if (stateLabel === "Expired") {
    meta.push('<span class="messageBadge messageBadge--expired">Expired</span>');
  } else {
    meta.push('<span class="messageBadge">Upcoming</span>');
  }

  if (Number.isFinite(msg.startTs)) {
    meta.push('<span class="messageBadge">Starts ' + escapeHtml_(messageClockLabel_(msg.startTs)) + '</span>');
  }

  if (Number.isFinite(msg.endTs)) {
    meta.push('<span class="messageBadge">Ends ' + escapeHtml_(messageClockLabel_(msg.endTs)) + '</span>');
  }

  const bodyHtml = msg.bodyHtml != null
    ? msg.bodyHtml
    : escapeHtml_(msg.body || "");

  return (
    '<div class="messageDetailMeta">' + meta.join("") + '</div>' +
    '<div class="messageDetailBody">' + bodyHtml + '</div>'
  );
}

function getPlayAreaBounds_() {
  const cfg = window.EGGHUNT_CONFIG || {};

  const south = Number(cfg.PLAY_AREA_SOUTH ?? cfg.BOUNDS_SOUTH ?? cfg.MIN_LAT);
  const west = Number(cfg.PLAY_AREA_WEST ?? cfg.BOUNDS_WEST ?? cfg.MIN_LNG);
  const north = Number(cfg.PLAY_AREA_NORTH ?? cfg.BOUNDS_NORTH ?? cfg.MAX_LAT);
  const east = Number(cfg.PLAY_AREA_EAST ?? cfg.BOUNDS_EAST ?? cfg.MAX_LNG);

  if (
    Number.isFinite(south) &&
    Number.isFinite(west) &&
    Number.isFinite(north) &&
    Number.isFinite(east)
  ) {
    return L.latLngBounds([[south, west], [north, east]]);
  }

  return null;
}

function setMessageOverlayHudVisible_(visible) {
  const btn = $("messageOverlayClose");
  if (!btn) return;
  btn.classList.toggle("hidden", !visible);
  btn.setAttribute("aria-hidden", visible ? "false" : "true");
}

function renderMessageOverlays_(msg) {
  clearActiveMessageOverlays_();

  if (!map || !msg || !Array.isArray(msg.mapOverlays) || !msg.mapOverlays.length) {
    return;
  }

  const layers = [];

  msg.mapOverlays.forEach(function(overlay) {
    if (!overlay || !overlay.overlayType) return;

    let layer = null;
    const overlayType = String(overlay.overlayType || "").toLowerCase();

    if (overlayType === "heatmap") {
      layer = buildHeatmapLayer_(overlay);
    }

    if (layer) {
      layer.addTo(map);
      layers.push(layer);
    }
  });

  activeMessageOverlayLayers_ = layers;
  activeMessageOverlayMessageId_ = String(msg.id || "");
}

function activateMessageOverlays_(msg) {
  renderMessageOverlays_(msg);

  const bounds = getPlayAreaBounds_();
  if (bounds && bounds.isValid()) {
    map.fitBounds(bounds, { padding: [20, 20] });
  }

  setMessageOverlayHudVisible_(activeMessageOverlayLayers_.length > 0);

}

async function closeActiveMessageOverlay_() {
  const messageId = activeMessageOverlayMessageId_;

  clearActiveMessageOverlays_();

  if (messageId) {
    setTimeout(function() {
      openMessageById_(messageId).catch(function() {});
    }, 0);
  }
}

function clearActiveMessageOverlays_() {
  if (!map) return;

  activeMessageOverlayLayers_.forEach(function(layer) {
    try {
      if (layer && map.hasLayer(layer)) {
        map.removeLayer(layer);
      }
    } catch (e) {}
  });

  activeMessageOverlayLayers_ = [];
  activeMessageOverlayMessageId_ = "";

  // ✅ THIS WAS MISSING
  setMessageOverlayHudVisible_(false);
}

function normalizeHeatPoint_(pt) {
  pt = (pt && typeof pt === "object") ? pt : {};

  const lat = Number(pt.lat);
  const lng = Number(pt.lng);
  const weight = Number(pt.weight);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return [
    lat,
    lng,
    Number.isFinite(weight) ? Math.max(0, weight) : 0.5
  ];
}

function buildHeatmapLayer_(overlay) {
  if (typeof L === "undefined" || typeof L.heatLayer !== "function") {
    console.warn("Leaflet heat plugin not loaded.");
    return null;
  }

  const data = overlay && overlay.data && typeof overlay.data === "object"
    ? overlay.data
    : {};

  const rawPoints = Array.isArray(data.points) ? data.points : [];
  const points = rawPoints
    .map(normalizeHeatPoint_)
    .filter(function(pt) { return !!pt; });

  if (!points.length) return null;

  return L.heatLayer(points, {
    pane: "messageOverlayPane",
    radius: Number.isFinite(Number(data.radius)) ? Number(data.radius) : 16,
    blur: Number.isFinite(Number(data.blur)) ? Number(data.blur) : 9,
    maxZoom: Number.isFinite(Number(data.maxZoom)) ? Number(data.maxZoom) : 18,
    minOpacity: Number.isFinite(Number(data.minOpacity)) ? Number(data.minOpacity) : 0.06
  });
}



async function openMessageById_(messageId) {

  if (activeMessageOverlayLayers_.length) {
    clearActiveMessageOverlays_();
  }

  const msg = messageFeed_.find(function(m) { return String(m.id) === String(messageId); });
  if (!msg) return;

  markMessageRead_(msg.id);

  const overlays = Array.isArray(msg.mapOverlays) ? msg.mapOverlays : [];
  const hasHeatmap = overlays.some(function(ov) {
    return String(ov && ov.overlayType || "").toLowerCase() === "heatmap";
  });

  const buttons = [
    { label: "Close", value: "close", className: "btn btn--primary" }
  ];

  if (hasHeatmap) {
    buttons.unshift({
      label: "View Intel Map",
      value: "view_heatmap",
      className: "btn"
    });
  }

  const decision = await showModal_({
    title: msg.title || "Message",
    html: buildMessageDetailHtml_(msg),
    buttons: buttons,
    dismissValue: "close"
  });

  if (decision === "view_heatmap") {
    activateMessageOverlays_(msg);
  }

  renderMessageUi_();
}

function buildMessageArchiveHtml_() {
  const messages = getSortedMessages_();

  if (!messages.length) {
    return '<div class="messageList__empty">No notices yet.</div>';
  }

  return (
    '<div class="messageList">' +
      messages.map(function(msg) {
        const stateLabel = messageStateLabel_(msg);
        const badges = [
          '<span class="messageBadge">' + escapeHtml_(messageTypeLabel_(msg.type)) + '</span>'
        ];

        if (!isMessageRead_(msg)) {
          badges.push('<span class="messageBadge messageBadge--unread">Unread</span>');
        }

        if (stateLabel === "Active") {
          badges.push('<span class="messageBadge messageBadge--active">Active</span>');
        } else if (stateLabel === "Expired") {
          badges.push('<span class="messageBadge messageBadge--expired">Expired</span>');
        } else {
          badges.push('<span class="messageBadge">Upcoming</span>');
        }

        if (Number.isFinite(msg.endTs)) {
          badges.push('<span class="messageBadge">Ends ' + escapeHtml_(messageClockLabel_(msg.endTs)) + '</span>');
        }

        return (
          '<button type="button" class="messageItem ' + (!isMessageRead_(msg) ? 'messageItem--unread' : '') + '" data-message-id="' + escapeHtml_(msg.id) + '">' +
            '<div class="messageItem__meta">' + badges.join("") + '</div>' +
            '<div class="messageItem__title">' + escapeHtml_(msg.title || "Message") + '</div>' +
            '<div class="messageItem__body">' + escapeHtml_(messagePreviewText_(msg)) + '</div>' +
          '</button>'
        );
      }).join("") +
    '</div>'
  );
}

async function openMessagesArchive_() {
  await showModal_({
    title: "Messages",
    html: buildMessageArchiveHtml_(),
    buttons: [
      { label: "Close", value: true, className: "btn btn--primary" }
    ],
    dismissValue: true,
    onRender: function(ctx) {
      const nodes = ctx.body.querySelectorAll("[data-message-id]");
      nodes.forEach(function(node) {
        node.onclick = function() {
          const id = node.getAttribute("data-message-id");
          ctx.finish(true);
          setTimeout(function() {
            openMessageById_(id).catch(function() {});
          }, 0);
        };
      });
    }
  });

  renderMessageUi_();
}

async function openTopUnreadMessage_() {
  const unread = getUnreadActiveMessages_();
  if (unread.length) {
    await openMessageById_(unread[0].id);
    return;
  }
  await openMessagesArchive_();
}

function renderMessageUi_() {
  const unreadAll = getUnreadMessages_();
  const unreadActive = getUnreadActiveMessages_();

  const banner = $("messageBanner");
  const bannerTitle = $("messageBannerTitle");
  const bannerBody = $("messageBannerBody");
  const bannerCount = $("messageBannerCount");
  const messagesBtn = $("messagesBtn");

  if (messagesBtn) {
    messagesBtn.textContent = unreadAll.length ? ("Notices (" + unreadAll.length + ")") : "Notices";
  }

  if (!banner || !bannerTitle || !bannerBody || !bannerCount) return;

  if (!unreadActive.length) {
    banner.classList.add("hidden");
    return;
  }

  const top = unreadActive[0];
  bannerTitle.textContent = top.title || "Unread Message";
  bannerBody.textContent = messagePreviewText_(top) || "Tap to view the latest message.";
  bannerCount.textContent = unreadActive.length > 1 ? (unreadActive.length + " unread") : "1 unread";
  banner.classList.remove("hidden");
}

function wireMessagesUi_() {
  const archiveBtn = $("messagesBtn");
  const bannerBtn = $("messageBannerBtn");
  const banner = $("messageBanner");

  if (archiveBtn) {
    archiveBtn.onclick = function() {
      openMessagesArchive_().catch(function() {});
    };
  }

  if (bannerBtn) {
    bannerBtn.onclick = function(e) {
      e.stopPropagation();
      openTopUnreadMessage_().catch(function() {});
    };
  }

  if (banner) {
    banner.onclick = function() {
      openTopUnreadMessage_().catch(function() {});
    };
  }
}

function renderKitHudPlaceholder_() {
  const slots = ["binoculars", "boots", "scanner", "antenna", "basket", "powercell"];
  slots.forEach(function(slot) {
    const nameEl = $("kit_" + slot + "_name");
    const bonusEl = $("kit_" + slot + "_bonus");
    if (nameEl) nameEl.textContent = "Loading…";
    if (bonusEl) bonusEl.textContent = "Loading yield…";
  });
}



function formatKitBonus_(slotOrItem, maybeItem) {
  let slot = "";
  let item = null;

  if (typeof slotOrItem === "string") {
    slot = slotOrItem;
    item = maybeItem || null;
  } else {
    item = slotOrItem || null;
    slot = String((item && item.slot) || "");
  }

  if (!item) return "No additional yield";

  const mag = Number(item.magnitude || 0);

  if (slot === "binoculars") {
    return mag > 0 ? "+" + Math.round(mag * 100) + "% detect radius" : "Base detect radius";
  }

  if (slot === "boots") {
    return mag > 0 ? "+" + Math.round(mag * 100) + "% scan radius" : "Base scan radius";
  }

  if (slot === "scanner") {
    return mag > 0 ? "+" + Math.round(mag * 100) + "% sweep range" : "Base sweep range";
  }

  if (slot === "antenna") {
    return mag > 0
      ? "+" + Math.round(mag) + " radar ping" + (Math.round(mag) === 1 ? "" : "s")
      : "1 radar ping";
  }

  if (slot === "basket") {
    return mag > 0 ? "+" + Math.round(mag * 100) + "% scan data points" : "Base scan yield";
  }

  if (slot === "powercell") {
    return mag > 0 ? "+" + Math.round(mag * 100) + "% radar recharge speed" : "Base radar recharge";
  }

  return "No increase";
}

function renderKitFromState_(equipment) {
  const slots = ["binoculars", "boots", "scanner", "antenna", "basket", "powercell"];

  slots.forEach(function(slot) {
    const nameEl = $("kit_" + slot + "_name");
    const bonusEl = $("kit_" + slot + "_bonus");
    if (!nameEl || !bonusEl) return;

    const item = equipment && equipment[slot];

    if (!item) {
      nameEl.textContent = "—";
      bonusEl.textContent = "No equipment";
      return;
    }

    nameEl.textContent = item.name || "Unknown";
    bonusEl.textContent = formatKitBonus_(slot, item);
  });
}

function equipmentSlotMeta_(slot) {
    const map = {
      binoculars: { label: "Optical Array", icon: "🔭" },
      boots: { label: "Signal Booster", icon: "📶" },
      scanner: { label: "Mobile Radar", icon: "📡" },
      antenna: { label: "Resonance Dish", icon: "📡" },
      basket: { label: "Scanner", icon: "🖲️" },
      powercell: { label: "Power Cell", icon: "🔋" }
    };
  return map[String(slot || "")] || { label: String(slot || "Equipment"), icon: "🎁" };
}

function equipmentOfferTitle_(offer) {
  const meta = equipmentSlotMeta_(offer && offer.slot);
  const cmp = String((offer && offer.comparison) || "").toUpperCase();

  if (cmp === "DUPLICATE") {
    return meta.icon + " Duplicate " + meta.label + " Deployed";
  }
  return meta.icon + " New " + meta.label + " Deployed";
}

function equipmentOfferButtons_(offer) {
  const isViewerDevice = isViewer_();
  const disabledClass = isViewerDevice ? " is-disabled" : "";
  const disabledAttr = !!isViewerDevice;

  const cmp = String((offer && offer.comparison) || "").toUpperCase();
  const item = (offer && offer.item) || {};
  const equipped = (offer && offer.equipped) || null;
  const incomingSellValue = Number((offer && offer.incomingSellValue) || 0);
  const equippedSellValue = Number((offer && offer.equippedSellValue) || 0);

  const newName = escapeHtml_(item.name || "New equipment");
  const newBonus = escapeHtml_(formatKitBonus_(item));
  const currentName = escapeHtml_((equipped && equipped.name) || "Current equipment");
  const currentBonus = escapeHtml_(equipped ? formatKitBonus_(equipped) : "No equipment");

  function choiceHtml_(topLine, effectLine, convertLine) {
    return (
      '<div class="equipmentChoiceBtn__inner">' +
        '<div class="equipmentChoiceBtn__title">' + topLine + '</div>' +
        '<div class="equipmentChoiceBtn__effect">' + effectLine + '</div>' +
        '<div class="equipmentChoiceBtn__convert">' + convertLine + '</div>' +
      '</div>'
    );
  }

  if (cmp === "DUPLICATE") {
    return [
      {
        htmlLabel: choiceHtml_(
          "Keep " + currentName,
          currentBonus,
          "Convert duplicate \u2192 +" + incomingSellValue + " data points"
        ),
        label: "Keep Current",
        value: "KEEP_CURRENT",
        className: "btn btn--primary equipmentChoiceBtn" + disabledClass,
        disabled: disabledAttr
      }
    ];
  }

  return [
    {
      htmlLabel: choiceHtml_(
        (cmp === "UPGRADE" ? "Upgrade to " : (cmp === "DOWNGRADE" ? "Downgrade to " : "Equip ")) + newName,
        newBonus,
        "Convert current equipment \u2192 +" + equippedSellValue + " data points"
      ),
      label: "Equip New",
      value: "EQUIP_NEW",
      className: (
        "btn equipmentChoiceBtn" +
        (cmp === "UPGRADE" ? " btn--primary" : "") +
        disabledClass
      ),
      disabled: disabledAttr
    },
    {
      htmlLabel: choiceHtml_(
        "Keep " + currentName,
        currentBonus,
        "Convert new equipment \u2192 +" + incomingSellValue + " data points"
      ),
      label: "Keep Current",
      value: "KEEP_CURRENT",
      className: (
        "btn equipmentChoiceBtn" +
        (cmp === "DOWNGRADE" ? " btn--primary" : "") +
        disabledClass
      ),
      disabled: disabledAttr
    }
  ];
}

function renderEquipmentOfferHtml_(offer) {
  const meta = equipmentSlotMeta_(offer && offer.slot);
  const cmp = String((offer && offer.comparison) || "").toUpperCase();

  let statusLabel = "";
  if (cmp === "UPGRADE") statusLabel = "Better than current equipment";
  else if (cmp === "DOWNGRADE") statusLabel = "Lower-grade item";
  else if (cmp === "DUPLICATE") statusLabel = "Duplicate";
  else statusLabel = "Equipment comparison";

  return (
    '<div class="equipmentOfferSummary">' +
      '<div class="equipmentOfferSummary__slot">' + escapeHtml_(meta.label) + '</div>' +
      '<div class="equipmentOfferSummary__status">' + escapeHtml_(statusLabel) + '</div>' +
      '<div class="equipmentOfferSummary__note">' +
        'Choose which equipment to keep. The other will be converted into data points.' +
      '</div>' +
    '</div>'
  );
}

async function respondEquipmentOffer_(offerId, decision) {
  return api("equipment_offerRespond", {
    offerId: offerId,
    decision: decision,
    playerId: playerId,
    teamId: teamId
  });
}

function dismissActiveEquipmentOffer_(offerId) {
  const activeId = String(activeEquipmentOfferId_ || "");
  const targetId = String(offerId || "");

  if (!activeId) return;
  if (targetId && activeId !== targetId) return;
  if (typeof activeEquipmentOfferDismiss_ !== "function") return;

  const dismiss = activeEquipmentOfferDismiss_;
  activeEquipmentOfferDismiss_ = null;
  activeEquipmentOfferId_ = "";

  try {
    dismiss("__AUTO_DISMISSED__");
  } catch (e) {}
}

function isTeamMode_() { return !!teamId; }
function isPrimary_() { return String(teamRole || "").toUpperCase() === "PRIMARY"; }
function isViewer_() { return isTeamMode_() && !isPrimary_(); }

function persistTeamContext_() {
  localStorage.setItem("eggHunt_teamId", teamId || "");
  localStorage.setItem("eggHunt_teamRole", teamRole || "");
  localStorage.setItem("eggHunt_teamName", teamName || "");
  lastRadarIdPlayed = localStorage.getItem(radarPlayedKey_()) || "";
}

function roleDisplayLabel_() {
  if (!isTeamMode_()) return "SOLO MODE";
  return isPrimary_() ? "PRIMARY DEVICE" : "VIEWER MODE";
}

function renderTeamContext_() {
  const pill = $("teamContextPill");
  const nameEl = $("teamContextName");
  const roleEl = $("teamContextRole");
  if (!pill || !nameEl || !roleEl) return;

  if (!isTeamMode_()) {
    pill.classList.add("hidden");
    pill.classList.remove("teamContext--primary", "teamContext--viewer");
    return;
  }

  nameEl.textContent = teamName || "Unnamed Team";
  roleEl.textContent = roleDisplayLabel_();

  pill.classList.remove("hidden");
  pill.classList.toggle("teamContext--primary", isPrimary_());
  pill.classList.toggle("teamContext--viewer", isViewer_());
}

function getJoinTeamIdFromUrl_() {
  try {
    const url = new URL(window.location.href);
    return String(url.searchParams.get("join") || "").trim();
  } catch (e) {
    return "";
  }
}

function clearJoinParamFromUrl_() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("join");
    window.history.replaceState({}, "", url.toString());
  } catch (e) {}
}

function currentJoinUrl_(tid) {
  const url = new URL(window.location.href);
  url.searchParams.set("join", String(tid || ""));
  return url.toString();
}

// -----------------------------
// API helper (GET JSON)
// -----------------------------
async function api(action, params) {
  params = params || {};
  const url = new URL(API_URL);
  url.searchParams.set("action", action);
  Object.keys(params).forEach(function(k) {
    url.searchParams.set(k, String(params[k]));
  });

  const res = await fetch(url.toString(), {
    method: "GET",
    cache: "no-store"
  });
  const text = await res.text();

  if (text.trim().startsWith("<")) {
    throw new Error("API returned HTML (not JSON). First 120 chars: " + text.slice(0, 120));
  }
  return JSON.parse(text);
}

let radarCooldownUntilMs = 0;
let radarCooldownTimer = null;

function startRadarCooldown_(ms) {
  const now = Date.now();
  radarCooldownUntilMs = Math.max(radarCooldownUntilMs, now + Math.max(0, Number(ms || 0)));

  if (!radarCooldownTimer) {
    radarCooldownTimer = setInterval(updateRadarBtnState_, 250);
  }
  updateRadarBtnState_();
}

function clearRadarCooldown_() {
  radarCooldownUntilMs = 0;
  if (radarCooldownTimer) {
    clearInterval(radarCooldownTimer);
    radarCooldownTimer = null;
  }
  updateRadarBtnState_();
}

function requestRadarPlayback_(payload) {
  const rid = String((payload && payload.radarId) || "");
  if (!payload || !rid) return;

  // Already seen in this page session
  if (radarSeenIds_.has(rid)) return;

  // Already fully played (persisted)
  if (rid === lastRadarIdPlayed) {
    radarSeenIds_.add(rid);
    return;
  }

  // Already queued or currently animating
  if (rid === radarQueuedId_ || rid === radarActiveId_) return;

  radarQueuedId_ = rid;
  radarSeenIds_.add(rid);

  playRadar_(payload).catch(function() {
    if (radarQueuedId_ === rid) radarQueuedId_ = "";
    if (radarActiveId_ === rid) radarActiveId_ = "";
    radarSeenIds_.delete(rid);
  });
}

function updateRadarBtnState_() {
  const btn = document.getElementById("radarBtn");
  if (!btn) return;

  if (!isTeamMode_()) {
    btn.disabled = true;
    btn.classList.remove("isCooldown");
    btn.textContent = "📡 Radar";
    btn.setAttribute("aria-disabled", "true");
    btn.title = "Join or create a team first";
    return;
  }

  if (!isPrimary_()) {
    btn.disabled = true;
    btn.classList.remove("isCooldown");
    btn.textContent = "📡 Radar";
    btn.setAttribute("aria-disabled", "true");
    btn.title = "Primary device only";
    return;
  }

  const now = Date.now();
  const remainingMs = Math.max(0, radarCooldownUntilMs - now);
  const remainingS = Math.ceil(remainingMs / 1000);
  const recharging = remainingMs > 0;

  btn.disabled = recharging;
  btn.classList.toggle("isCooldown", recharging);

  if (recharging) {
    btn.textContent = `📡 Radar (${remainingS}s)`;
    btn.setAttribute("aria-disabled", "true");
    btn.title = `Recharging… ${remainingS}s`;
  } else {
    btn.textContent = "📡 Radar";
    btn.setAttribute("aria-disabled", "false");
    btn.title = "Radar sweep (PRIMARY only)";
    if (radarCooldownTimer) {
      clearInterval(radarCooldownTimer);
      radarCooldownTimer = null;
    }
  }
}

let lastLootOfferIdSeen = localStorage.getItem("eggHunt_lastLootOfferId") || "";
let lastEquipmentOfferIdSeen = localStorage.getItem("eggHunt_lastEquipmentOfferId") || "";

// Keep a local snapshot of the last loot/team state rendered to the HUD.
// Use this for "Use loot" instead of forcing a fresh poll right before prompting.
let lastLootHudState_ = {
  inventory: [],
  activeEffects: {},
  lootSlotsMax: 0
};

// Latest full team state snapshot from polling
let lastTeamState_ = null;

// Guardrails for UI races
let lootFlowActive_ = false;
let equipmentOfferFlowActive_ = false;
let pauseTeamStatePolling_ = false;

// Equipment-offer modal tracking
let activeEquipmentOfferId_ = "";
let activeEquipmentOfferDismiss_ = null;

let scanRequestInFlight_ = false;
let teamStatePollInFlight_ = false;
let nearbyEggsPollInFlight_ = false;
let quietPeriodUntilMs_ = 0;

function beginQuietPeriod_(ms) {
  const dur = Math.max(0, Number(ms || 0));
  if (!dur) return;
  quietPeriodUntilMs_ = Math.max(quietPeriodUntilMs_, Date.now() + dur);
}

function isQuietPeriodActive_() {
  return Date.now() < quietPeriodUntilMs_;
}

function shouldSuppressBackgroundPolling_() {
  return (
    pauseTeamStatePolling_ ||
    lootFlowActive_ ||
    equipmentOfferFlowActive_ ||
    radarRequestInFlight ||
    scanRequestInFlight_ ||
    isQuietPeriodActive_()
  );
}

function userFacingBusyMessage_(errOrMessage, fallback) {
  const raw = String(
    (errOrMessage && (errOrMessage.message || errOrMessage.error)) ||
    errOrMessage ||
    ""
  ).toLowerCase();

  if (
    raw.includes("busy") ||
    raw.includes("overloaded") ||
    raw.includes("too many") ||
    raw.includes("try again") ||
    raw.includes("timeout") ||
    raw.includes("timed out") ||
    raw.includes("invocation") ||
    raw.includes("service invoked") ||
    raw.includes("lock") ||
    raw.includes("temporarily unavailable")
  ) {
    return "Field link busy. Try again in a moment.";
  }

  return fallback || "System traffic is high. Please retry.";
}

function fmtMs_(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2,"0")}`;
}

function effectLabel_(k, eff) {
  if (!eff) return k;
  if (k === "revealRadiusBoost") return `Detect +${Math.round(Number(eff.magnitude||0)*100)}%`;
  if (k === "claimRadiusBoost") return `Scan +${Math.round(Number(eff.magnitude||0)*100)}%`;
  if (k === "pingCooldownReduction") return `Radar recharge +${Math.round(Number(eff.magnitude||0)*100)}%`;
  if (k === "pingPulseIncrease") return `+${Math.floor(Number(eff.magnitude||0))} pulse`;
  if (k === "scoreMultiplier") return `x${Number(eff.magnitude||1)}`;
  return k;
}

function renderLootHud_(st) {
  const invEl = $("lootInvCount");
  const chipsEl = $("lootChips");
  if (!invEl || !chipsEl) return;

  const inv = (st && st.inventory) ? st.inventory : [];
  const maxSlots = Number(st && st.lootSlotsMax || 0);
  const eff = (st && st.activeEffects) ? st.activeEffects : {};

  // Persist the latest rendered snapshot so the Use Loot flow
  // can rely on local state instead of triggering a fresh poll.
  lastLootHudState_ = {
    inventory: Array.isArray(inv) ? inv.slice() : [],
    activeEffects: eff || {},
    lootSlotsMax: maxSlots
  };

  invEl.textContent = `${inv.length}/${maxSlots || "?"}`;
  chipsEl.innerHTML = "";

  Object.keys(eff).forEach(k => {
    const e = eff[k];
    const span = document.createElement("span");
    span.className = "chip";

    if (e && e.expiresAt) {
      const rem = new Date(e.expiresAt).getTime() - Date.now();
      span.textContent = `${effectLabel_(k, e)} (${fmtMs_(rem)})`;
    } else if (e && Number.isFinite(Number(e.chargesRemaining))) {
      span.textContent = `${effectLabel_(k, e)} (${Number(e.chargesRemaining)}x)`;
    } else {
      span.textContent = effectLabel_(k, e);
    }

    chipsEl.appendChild(span);
  });
}

async function maybeHandleLootOffer_(st) {
  if (lootFlowActive_) return;
  const offer = st && st.lootOffer;
  if (!offer || !offer.offerId) return;

  const offerId = String(offer.offerId);
  if (offerId === lastLootOfferIdSeen) return;

  lastLootOfferIdSeen = offerId;
  localStorage.setItem("eggHunt_lastLootOfferId", offerId);

  const item = offer.item || {};
  const effectType = item.effectType || item.type || "Unknown effect";

  let effectDetail = "";
  if (Number.isFinite(Number(item.magnitude))) {
    effectDetail = `\nValue: ${item.magnitude}`;
  } else if (Number.isFinite(Number(item.durationMs))) {
    effectDetail = `\nDuration: ${Math.round(Number(item.durationMs) / 1000)}s`;
  }

  const msg =
    `Loot drop (inventory full)\n\n` +
    `${item.name || item.lootId || "Loot"}\n` +
    `Effect: ${effectType}` +
    effectDetail +
    `\n\nUse now?`;

  const useNow = await modalConfirm_(msg, "Loot Drop", "Use now", "Forfeit");

  const out = await api("loot_offerRespond", {
    playerId: playerId,
    teamId: teamId,
    decision: useNow ? "USE" : "FORFEIT"
  });

  if (!out || !out.ok) {
    await modalAlert_((out && out.error) || "Loot offer response failed.", "Loot");
  }
}


async function maybeHandleEquipmentOffer_(offer) {
  console.log("[equipmentOffer] handler called:", offer);

  if (equipmentOfferFlowActive_) {
    console.log("[equipmentOffer] skipped: flow already active");
    return;
  }

  if (!offer || !offer.offerId) {
    console.log("[equipmentOffer] skipped: missing offer/offerId");
    return;
  }

  const offerId = String(offer.offerId);
  const effectiveSeen = localStorage.getItem("eggHunt_lastEquipmentOfferId") || "";
  lastEquipmentOfferIdSeen = effectiveSeen;

  console.log("[equipmentOffer] seen:", effectiveSeen, "incoming:", offerId);

  if (offerId === effectiveSeen) {
    console.log("[equipmentOffer] skipped: already seen");
    return;
  }

  equipmentOfferFlowActive_ = true;
  pauseTeamStatePolling_ = true;
  activeEquipmentOfferId_ = offerId;

  try {
    const isViewerDevice = isViewer_();

    const extraViewerHtml = isViewerDevice
      ? '<div class="small" style="margin-top:12px;"><strong>Primary device required.</strong> This notice will close automatically once the primary device resolves it.</div>'
      : "";

    const decision = await showModal_({
      title: equipmentOfferTitle_(offer),
      html: renderEquipmentOfferHtml_(offer) + extraViewerHtml,
      buttons: isViewerDevice
        ? [
            {
              label: "Awaiting Primary Device",
              value: "__VIEWER_WAITING__",
              className: "btn btn--primary",
              disabled: true
            },
            {
              label: "Close",
              value: "close",
              className: "btn"
            }
          ]
        : equipmentOfferButtons_(offer),
      dismissValue: isViewerDevice ? "close" : null,
      onRender: function(ctx) {
        activeEquipmentOfferDismiss_ = ctx.finish;
      }
    });

    activeEquipmentOfferDismiss_ = null;
    activeEquipmentOfferId_ = "";

    if (decision === "__AUTO_DISMISSED__") {
      console.log("[equipmentOffer] auto-dismissed after primary resolution");
      return;
    }

    if (isViewerDevice) {
      console.log("[equipmentOffer] viewer acknowledged locally");
      return;
    }

    if (!decision) {
      console.log("[equipmentOffer] no decision returned");
      return;
    }

    beginQuietPeriod_(2500);

    const out = await runWithLoading_(
      {
        loadingText: {
          text: "Peepochron tunneling in process…",
          subtext: "Routing equipment through substrate layers."
        },
        delayMs: 150
      },
      async function() {
        return await respondEquipmentOffer_(offerId, decision);
      }
    );

    if (!out || !out.ok) {
      await modalAlert_(
        userFacingBusyMessage_(out && out.error, "Equipment offer response failed."),
        "Egg Hunter Kit"
      );
      return;
    }

    lastEquipmentOfferIdSeen = offerId;
    localStorage.setItem("eggHunt_lastEquipmentOfferId", offerId);
    console.log("[equipmentOffer] resolved:", decision, offerId);

    await pollTeamState_({
      skipLootOffer: true,
      skipEquipmentOffer: true,
      force: true
    });
  } catch (err) {
    console.error("[equipmentOffer] modal failed:", err);
    await modalAlert_(
      userFacingBusyMessage_(err, "Equipment offer response failed."),
      "Egg Hunter Kit"
    );
  } finally {
    activeEquipmentOfferDismiss_ = null;
    activeEquipmentOfferId_ = "";
    equipmentOfferFlowActive_ = false;
    pauseTeamStatePolling_ = false;
  }
}

// -----------------------------
// Player registration
// -----------------------------
async function ensurePlayer() {
  if (playerId && playerName) return;

  const rawName = await modalPrompt_(
    "What should I call you in the hunt?",
    playerName || "Player",
    "Player Name"
  );
  const name = (rawName == null ? "" : String(rawName).trim()) || "Player";
  const out = await api("player_register", { name: name });

  if (!out.ok || !out.playerId) throw new Error(out.error || "Failed to register player.");

  playerId = out.playerId;
  playerName = name;

  localStorage.setItem("eggHunt_playerId", playerId);
  localStorage.setItem("eggHunt_playerName", playerName);

  setTopStats();
}

async function ensureTeam_(opts) {
  opts = opts || {};
  const forceDialog = !!opts.forceDialog;

  if (teamId && teamRole && !forceDialog) {
    renderTeamContext_();
    return;
  }

  const joinTidFromUrl = getJoinTeamIdFromUrl_();
  if (joinTidFromUrl && !forceDialog) {
    const out = await api("joinTeam", { playerId: playerId, teamId: joinTidFromUrl });
    if (!out.ok) throw new Error(out.error || "Failed to join team.");
    teamId = out.teamId;
    teamRole = out.role || "VIEWER";
    teamName = out.teamName || "";
    persistTeamContext_();
    renderTeamContext_();
    clearJoinParamFromUrl_();
    return;
  }

  const buttons = [];

  if (isTeamMode_() && isPrimary_()) {
    buttons.push({ label: "Show Join QR", value: "show_qr", className: "btn btn--primary" });
  }

  buttons.push({ label: "Join Team", value: "join", className: "btn" });
  buttons.push({ label: "Create Team", value: "create", className: "btn" });

  const mode = await showModal_({
    title: "Team Mode",
    html:
      '<div class="teamSetupActions">' +
        (isTeamMode_()
          ? '<div class="teamSetupCard">' +
              '<div class="teamSetupCard__title">Current Team</div>' +
              '<div class="teamSetupCard__body"><strong>' + escapeHtml_(teamName || "Unnamed Team") + '</strong><br>' +
              escapeHtml_(roleDisplayLabel_()) + '</div>' +
            '</div>'
          : '') +
        '<div class="teamSetupCard">' +
          '<div class="teamSetupCard__title">Create Team</div>' +
          '<div class="teamSetupCard__body">Create a team, become the PRIMARY device, and generate a join QR for nearby teammates.</div>' +
        '</div>' +
        '<div class="teamSetupCard">' +
          '<div class="teamSetupCard__title">Join Team</div>' +
          '<div class="teamSetupCard__body">Join an existing nearby team as a VIEWER by scanning a QR code or entering a team code.</div>' +
        '</div>' +
      '</div>',
    buttons: buttons,
    dismissValue: "cancel"
  });

  if (mode === "cancel" || !mode) {
    renderTeamContext_();
    return;
  }

  if (mode === "show_qr") {
    if (teamId && isPrimary_()) {
      await showTeamCreatedModal_(teamId, teamName || "Unnamed Team");
    }
    renderTeamContext_();
    return;
  }

  if (mode === "create") {
    const rawTeamName = await modalPrompt_("Team name?", teamName || "Team", "Create Team");
    const name = (rawTeamName == null ? "" : String(rawTeamName).trim()) || "Team";
    const out = await api("createTeam", { playerId: playerId, teamName: name });
    if (!out.ok) throw new Error(out.error || "Failed to create team.");

    teamId = out.teamId;
    teamRole = out.role || "PRIMARY";
    teamName = out.teamName || name;

    persistTeamContext_();
    renderTeamContext_();

    await showTeamCreatedModal_(teamId, teamName);
    return;
  }

  if (mode === "join") {
    const rawTid = await modalPrompt_("Enter team code:", "", "Join Team");
    const tid = (rawTid == null ? "" : String(rawTid).trim());
    if (!tid) {
      renderTeamContext_();
      return;
    }

    const out = await api("joinTeam", { playerId: playerId, teamId: tid });
    if (!out.ok) throw new Error(out.error || "Failed to join team.");

    teamId = out.teamId;
    teamRole = out.role || "VIEWER";
    teamName = out.teamName || "";

    persistTeamContext_();
    renderTeamContext_();
    return;
  }

  renderTeamContext_();
}

async function openTeamModeModal_() {
  return showModal_({
    title: "Team Mode",
    html:
      '<div class="teamSetupActions">' +
        '<div class="teamSetupCard">' +
          '<div class="teamSetupCard__title">Create Team</div>' +
          '<div class="teamSetupCard__body">Create a team, become the PRIMARY device, and generate a join QR for nearby teammates.</div>' +
        '</div>' +
        '<div class="teamSetupCard">' +
          '<div class="teamSetupCard__title">Join Team</div>' +
          '<div class="teamSetupCard__body">Join an existing nearby team as a VIEWER by scanning a QR code or entering a team code.</div>' +
        '</div>' +
      '</div>',
    buttons: [
      { label: "Solo", value: "solo", className: "btn" },
      { label: "Join Team", value: "join", className: "btn" },
      { label: "Create Team", value: "create", className: "btn btn--primary" }
    ],
    dismissValue: "solo"
  });
}

async function showTeamCreatedModal_(tid, name) {
  const joinUrl = currentJoinUrl_(tid);

  await showModal_({
    title: "Team Created",
    html:
      '<div><strong>' + escapeHtml_(name) + '</strong> is ready.</div>' +
      '<div class="small" style="margin-top:8px;">Nearby teammates can scan this QR code to join as viewers.</div>' +
      '<div class="teamQrWrap">' +
        '<div id="teamJoinQr" class="teamQrCode"></div>' +
        '<div class="teamJoinMeta">' +
          '<div class="small">Fallback join code</div>' +
          '<input class="teamJoinCode mono" readonly value="' + escapeHtml_(tid) + '">' +
          '<div class="small">Join URL</div>' +
          '<div class="small teamJoinUrl mono">' + escapeHtml_(joinUrl) + '</div>' +
        '</div>' +
      '</div>',
    buttons: [
      { label: "Done", value: true, className: "btn btn--primary" }
    ],
    dismissValue: true,
    onRender: function(ctx) {
      const qrEl = ctx.body.querySelector("#teamJoinQr");
      if (qrEl && window.QRCode) {
        qrEl.innerHTML = "";
        new QRCode(qrEl, {
          text: joinUrl,
          width: 180,
          height: 180
        });
      } else if (qrEl) {
        qrEl.innerHTML = '<div class="small">QR unavailable</div>';
      }
    }
  });
}

async function openTeamPillModal_() {
  const isPrimaryDevice = isPrimary_();

  const html =
    '<div class="teamSetupActions">' +
      '<div class="teamSetupCard">' +
        '<div class="teamSetupCard__title">Current Team</div>' +
        '<div class="teamSetupCard__body">' +
          '<strong>' + escapeHtml_(teamName || "Unnamed Team") + '</strong><br>' +
          escapeHtml_(roleDisplayLabel_()) +
        '</div>' +
      '</div>' +
      (teamId
        ? '<div class="teamSetupCard">' +
            '<div class="teamSetupCard__title">Team Code</div>' +
            '<div class="teamSetupCard__body mono">' + escapeHtml_(teamId) + '</div>' +
          '</div>'
        : '') +
    '</div>';

  const buttons = isPrimaryDevice
    ? [
        { label: "Close", value: "close", className: "btn" },
        { label: "Show Join QR", value: "show_qr", className: "btn btn--primary" }
      ]
    : [
        { label: "Close", value: "close", className: "btn btn--primary" }
      ];

  const result = await showModal_({
    title: "Team",
    html: html,
    buttons: buttons,
    dismissValue: "close"
  });

  if (result === "show_qr" && teamId && isPrimaryDevice) {
    await showTeamCreatedModal_(teamId, teamName || "Unnamed Team");
  }
}

// -----------------------------
// Geolocation
// -----------------------------
function startGeolocation() {
  if (!navigator.geolocation) {
    setStatus('<span class="bad">Geolocation not supported.</span>');
    return;
  }

  navigator.geolocation.watchPosition(
    function(pos) {
      const c = pos.coords;
      lastDevicePos = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy };

      // Always show the local device marker.
      updateYouOnMap(lastDevicePos);

      // PRIMARY device remains authoritative for gameplay state.
      if (!teamId || isPrimary_()) {
        lastPos = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy };

        if (teamId && isPrimary_()) {
          api("updateLocation", {
            playerId: playerId,
            teamId: teamId,
            lat: lastPos.lat,
            lng: lastPos.lng,
            accuracyM: lastPos.accuracy
          }).catch(function() {});
        }
      }
    },
    function(err) {
      setStatus('<span class="bad">Location error:</span> ' + err.message);
    },
    { enableHighAccuracy: true, maximumAge: 1500, timeout: 15000 }
  );
}

function waitForInitialGpsFix_(timeoutMs) {
  timeoutMs = Number(timeoutMs || 20000);

  return new Promise(function(resolve, reject) {
    if (lastPos) {
      resolve(lastPos);
      return;
    }

    const started = Date.now();
    const timer = setInterval(function() {
      if (lastPos) {
        clearInterval(timer);
        resolve(lastPos);
        return;
      }

      if ((Date.now() - started) >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for GPS fix."));
      }
    }, 200);
  });
}

function waitForPlayerMarker_(timeoutMs) {
  timeoutMs = Number(timeoutMs || 5000);

  return new Promise(function(resolve, reject) {
    if (youMarker) {
      resolve(youMarker);
      return;
    }

    const started = Date.now();
    const timer = setInterval(function() {
      if (youMarker) {
        clearInterval(timer);
        resolve(youMarker);
        return;
      }

      if ((Date.now() - started) >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for player marker."));
      }
    }, 100);
  });
}

function updateRangeRings_(latlng) {
  if (!map) return;

    const claimM = positiveNumberOrNull_(lastClaimMeters) ?? DEFAULT_CLAIM_METERS;
    const revealM = positiveNumberOrNull_(lastRevealMeters); // null means "don't draw reveal ring yet"

    console.log("[rings]", {
      lastClaimMeters,
      lastRevealMeters,
      claimM,
      revealM,
      hasClaim: !!claimCircle,
      hasReveal: !!revealCircle
    });

  // Reveal ring (outer, subtle dashed)
  if (revealM && revealM > 0) {
    if (!revealCircle) {
    revealCircle = L.circle(latlng, {
      pane: "ringsPane",
      radius: revealM,
      color: "rgba(96,165,250,0.85)",
      weight: 2,
      opacity: 0.8,
      fillColor: "rgba(96,165,250,0.10)",
      fillOpacity: 0.04,

      // dotted-ish but clearer than 2 8
      dashArray: "3 7",

      // optional: makes dash ends rounder (nice “dots” feel)
      lineCap: "round",

      interactive: false
    }).addTo(map);
        } else {
      revealCircle.setLatLng(latlng);
      revealCircle.setRadius(revealM);
    }
  } else if (revealCircle) {
    // If we later lose the value, hide it (remove layer to keep it clean)
    map.removeLayer(revealCircle);
    revealCircle = null;
  }

  // Claim ring (inner, slightly brighter solid)
  if (claimM && claimM > 0) {
    if (!claimCircle) {
    claimCircle = L.circle(latlng, {
      pane: "ringsPane",
      radius: claimM,

      // Base ring (glow is handled by CSS)
      color: "rgba(96,165,250,0.95)",
      weight: 2.5,
      opacity: 0.95,
      fillColor: "rgba(96,165,250,0.16)",
      fillOpacity: 0.10,

      // Give the SVG path a class so we can apply a glow
      className: "claim-ring",

      interactive: false
    }).addTo(map);
        } else {
      claimCircle.setLatLng(latlng);
      claimCircle.setRadius(claimM);
      claimCircle.setStyle({
        color: "rgba(96,165,250,0.95)",
        weight: 2.5,
        opacity: 0.95,
        fillColor: "rgba(96,165,250,0.16)",
        fillOpacity: 0.10
      });
    }
  } else if (claimCircle) {
    map.removeLayer(claimCircle);
    claimCircle = null;
  }

  if (revealCircle) revealCircle.bringToFront();
  if (claimCircle) claimCircle.bringToFront();
}



function updateYouOnMap(p) {
  const latlng = [p.lat, p.lng];

  if (!youMarker) {
    youMarker = L.marker(latlng, { icon: playerIcon_() }).addTo(map).bindPopup("You");
    map.setView(latlng, 16);
  } else {
    youMarker.setLatLng(latlng);
  }

  if (!accuracyCircle) {
  accuracyCircle = L.circle(latlng, {
    pane: "overlayPane",     // explicitly keep it in the normal overlay pane
    radius: Math.max(10, p.accuracy || 25),
    weight: 1,
    opacity: 0.10,
    fillOpacity: 0.015,
    interactive: false
  }).addTo(map);
  } else {
    accuracyCircle.setLatLng(latlng);
    accuracyCircle.setRadius(Math.max(10, p.accuracy || 25));
    accuracyCircle.setStyle({ weight: 1, opacity: 0.10, fillOpacity: 0.015 });
  }

  if (accuracyCircle) accuracyCircle.bringToBack();

  // Draw/update claim + reveal rings around current position
    // Draw rings only around the authoritative gameplay position.
  // Solo mode: local player.
  // Team mode PRIMARY: local player.
  // Team mode VIEWER: do not draw around this device; rings will be drawn
  // from updatePrimaryTeamOnMap_() around the primary device instead.
   // Rings should only be controlled by the authoritative gameplay position.
  // Solo mode: local player controls them.
  // Team PRIMARY: local player controls them.
  // Team VIEWER: do not update or clear here; the team-state sync will place
  // them around the primary device position.
  if (!teamId || isPrimary_()) {
    updateRangeRings_(latlng);
  }

  // Refresh popup distances for already-revealed eggs
  refreshEggMarkerDistances_();

  if (!startupLoading_) {
    setStatus(
      '<span class="ok">GPS OK</span> - ' +
      'lat <span class="mono">' + p.lat.toFixed(5) + '</span>, ' +
      'lng <span class="mono">' + p.lng.toFixed(5) + '</span> - ' +
      '+/-' + Math.round(p.accuracy) + 'm'
    );
  }
}

function clearRangeRings_() {
  if (claimCircle) {
    map.removeLayer(claimCircle);
    claimCircle = null;
  }
  if (revealCircle) {
    map.removeLayer(revealCircle);
    revealCircle = null;
  }
}

function playerIcon_(zoom, variant) {
  const z = (typeof zoom === "number") ? zoom : (map ? map.getZoom() : 16);
  const sz = hunterSizeForZoom_(z);
  const w = sz.w;
  const h = sz.h;
  const v = variant || "primary";

  let asset = "assets/hunter.png";
  if (v === "viewer" || v === "secondary") {
    asset = "assets/hunter-secondary.png";
  }

  const imgHtml =
    '<img class="player-icon__img" src="' + asset + '" alt="" ' +
    'style="display:block;width:' + w + 'px;height:' + h + 'px;object-fit:contain;" />';

  return L.divIcon({
    className: "player-icon player-icon--" + v,
    html: imgHtml,
    iconSize: [w, h],
    iconAnchor: [Math.round(w / 2), Math.round(h / 2)],
    popupAnchor: [0, -Math.round(h * 0.45)]
  });
}

function primaryTeamIcon_(zoom) {
  const z = (typeof zoom === "number") ? zoom : (map ? map.getZoom() : 16);
  const sz = hunterSizeForZoom_(z);
  const w = Math.round(sz.w * 1.08);
  const h = Math.round(sz.h * 1.08);

  const imgHtml =
    '<img class="team-primary-icon__img" src="assets/hunter.png" alt="" ' +
    'style="display:block;width:' + w + 'px;height:' + h + 'px;object-fit:contain;" />';

  return L.divIcon({
    className: "team-primary-icon",
    html: imgHtml,
    iconSize: [w, h],
    iconAnchor: [Math.round(w / 2), Math.round(h / 2)],
    popupAnchor: [0, -Math.round(h * 0.45)]
  });
}

function updatePrimaryTeamOnMap_(p) {
  if (!map || !p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return;

  const latlng = [p.lat, p.lng];

  if (isPrimary_()) {
    if (primaryMarker) {
      map.removeLayer(primaryMarker);
      primaryMarker = null;
    }
    updateRangeRings_(latlng);
    return;
  }

  if (!primaryMarker) {
    primaryMarker = L.marker(latlng, {
      icon: primaryTeamIcon_(map.getZoom())
    }).addTo(map).bindPopup("Primary device");
  } else {
    primaryMarker.setLatLng(latlng);
  }

  updateRangeRings_(latlng);
}

// -----------------------------
// Eggs
// -----------------------------

function eggDistanceMeters_(marker) {
  if (lastPos && map) {
    return Math.round(
      map.distance(
        [lastPos.lat, lastPos.lng],
        [marker._eggLat, marker._eggLng]
      )
    );
  }

  return Math.round(Number(marker._eggDistanceMeters || 0));
}

function currentClaimMeters_() {
  return positiveNumberOrNull_(lastClaimMeters) ?? DEFAULT_CLAIM_METERS;
}

function eggIsInClaimRange_(marker) {
  return eggDistanceMeters_(marker) <= currentClaimMeters_();
}

function eggResolutionState_(marker) {
  const resolvedByTeam =
    !!(
      marker &&
      (
        marker._claimedByTeam ||
        marker._scannedByTeam
      )
    );

  const resolved =
    resolvedByTeam ||
    !!(
      marker &&
      (
        marker._resolved ||
        marker._claimed ||
        marker._scanned ||
        marker._isResolved ||
        marker._isClaimed ||
        marker._isScanned
      )
    );

  if (!resolved) {
    return {
      resolved: false,
      message: ""
    };
  }

  return {
    resolved: true,
    message: resolvedByTeam ? "Already scanned by your team" : "Already scanned"
  };
}

function applyEggResolutionState_(marker, egg) {
  if (!marker || !egg) return;

  marker._resolved =
    !!(
      egg.resolved ||
      egg.claimed ||
      egg.scanned ||
      egg.isResolved ||
      egg.isClaimed ||
      egg.isScanned
    );

  marker._claimed =
    !!(
      egg.claimed ||
      egg.isClaimed
    );

  marker._scanned =
    !!(
      egg.scanned ||
      egg.isScanned
    );

  marker._claimedByTeam =
    !!(
      egg.claimedByTeam ||
      egg.scannedByTeam
    );

  marker._scannedByTeam =
    !!(
      egg.scannedByTeam ||
      egg.claimedByTeam
    );
}

function markEggResolvedLocally_(eggId, byTeam) {
  const marker = eggMarkers.get(eggId);
  if (!marker) return;

  marker._resolved = true;
  marker._claimed = true;
  marker._scanned = true;
  marker._claimedByTeam = !!byTeam;
  marker._scannedByTeam = !!byTeam;

  marker.setPopupContent(buildEggPopupHtml_(marker));

  if (marker.isPopupOpen && marker.isPopupOpen()) {
    applyPopupScale_();
  }
}

function buildEggPopupHtml_(marker) {
  const d = eggDistanceMeters_(marker);
  const claimM = currentClaimMeters_();
  const claimMDisplay = formatMetersDisplay_(claimM);
  const inRange = eggIsInClaimRange_(marker);
  const resolution = eggResolutionState_(marker);

  let claimUi = "";

  if (resolution.resolved) {
    claimUi =
      '<div class="egg-popup-status egg-popup-status--resolved">' +
        escapeHtml_(resolution.message || "Already scanned") +
      '</div>';
  } else if (gameIsOver_()) {
    claimUi =
      '<div class="egg-popup-status egg-popup-status--resolved">' +
        'Game over' +
      '</div>';
  } else if (teamId && isViewer_()) {
    claimUi = '<div class="small"><span class="bad">Primary device required</span></div>';
  } else if (inRange) {
    claimUi = '<button id="claim_' + marker._eggId + '" class="claim-btn">Scan</button>';
  } else {
    claimUi =
      '<div class="small">' +
        '<span class="muted">Move closer to scan</span><br/>' +
        'Need &le; ' + claimMDisplay + 'm' +
      '</div>';
  }

  return (
    "<b>" + eggLabel_({
      color: marker._eggColor,
      pattern: marker._eggPattern,
      specialType: marker._specialType,
      title: marker._title
    }) + "</b><br/>" +
    "~" + d + "m away<br/><br/>" +
    claimUi
  );
}

function refreshEggMarkerDistances_() {
  if (!map || !lastPos) return;

  eggMarkers.forEach(function(m) {
    m.setPopupContent(buildEggPopupHtml_(m));

    if (m.isPopupOpen && m.isPopupOpen()) {
      bindClaimButton_(m);
      applyPopupScale_();
    }
  });
}

function bindClaimButton_(marker) {
  if (!marker || (teamId && isViewer_())) return;
  if (eggResolutionState_(marker).resolved) return;
  if (gameIsOver_()) return;

  const btn = document.getElementById("claim_" + marker._eggId);
  if (!btn) return;

  btn.onclick = async function() {
    if (eggResolutionState_(marker).resolved) return;

    await runWithLoading_(
      {
        button: btn,
        buttonText: "Scan in progress…",
        loadingText: {
          text: "Scan in progress…",
          subtext: "Sample stabilizing. You may continue moving."
        },
        delayMs: 150
      },
      async function() {
        await claimEgg(marker._eggId);
      }
    );
  };
}


function upsertEggMarker(egg) {
  const existing = eggMarkers.get(egg.eggId);
  if (existing) {
    existing._eggLat = Number(egg.lat);
    existing._eggLng = Number(egg.lng);
    existing._eggColor = egg.color;
    existing._eggPattern = egg.pattern;
    existing._eggDistanceMeters = Number(egg.distanceMeters || 0);
    existing._specialType = egg.specialType || "";
    existing._title = egg.title || "";
    existing._iconUrl = egg.iconUrl || "";

    applyEggResolutionState_(existing, egg);
    existing.setPopupContent(buildEggPopupHtml_(existing));

    if (existing.isPopupOpen && existing.isPopupOpen()) {
      bindClaimButton_(existing);
      applyPopupScale_();
    }
    return;
  }

  const isPrime = String(egg && egg.specialType || "").toUpperCase() === "EGG_PRIME";

  const fc = String($("filterColor").value || "").toUpperCase();
  const fp = String($("filterPattern").value || "").toUpperCase();

  if (!isPrime) {
    if ((fc && String(egg.color || "").toUpperCase() !== fc) ||
        (fp && String(egg.pattern || "").toUpperCase() !== fp)) {
      return;
    }
  }

  const icon = isPrime
    ? eggPrimeIcon_(egg.iconUrl || "./assets/egg-prime.gif", map.getZoom())
    : eggIcon_(egg.color, egg.pattern, map.getZoom());

  const m = L.marker([egg.lat, egg.lng], { icon: icon }).addTo(map);

  m._eggId = egg.eggId;
  m._eggLat = Number(egg.lat);
  m._eggLng = Number(egg.lng);
  m._eggColor = egg.color;
  m._eggPattern = egg.pattern;
  m._eggDistanceMeters = Number(egg.distanceMeters || 0);
  m._specialType = egg.specialType || "";
  m._title = egg.title || "";
  m._iconUrl = egg.iconUrl || "";

  applyEggResolutionState_(m, egg);

  m.bindPopup(buildEggPopupHtml_(m));

  m.on("popupopen", function() {
    m.setPopupContent(buildEggPopupHtml_(m));
    applyPopupScale_();
    bindClaimButton_(m);
  });

  eggMarkers.set(egg.eggId, m);
  setTopStats();
}

function clearEggMarkers() {
  eggMarkers.forEach(function(m) { map.removeLayer(m); });
  eggMarkers.clear();
  setTopStats();
}

async function pollTeamState_(options) {
  options = options || {};
  if (!teamId) return null;

  if (!options.force && shouldSuppressBackgroundPolling_()) {
    return lastTeamState_;
  }

  if (teamStatePollInFlight_) {
    return lastTeamState_;
  }

  teamStatePollInFlight_ = true;

  try {
    const out = await api("teamState", { playerId: playerId, teamId: teamId });
    applyGameTiming_(out);

    if (!out.ok) {
      setStatus(
        '<span class="bad">Field Link Unstable:</span> ' +
        userFacingBusyMessage_(out && out.error, "System traffic is high. Please retry.")
      );
      return lastTeamState_;
    }

    const st = out.state || {};
    setMessageFeed_(out.messages || []);

    if (out.teamName) {
      teamName = String(out.teamName || "");
      localStorage.setItem("eggHunt_teamName", teamName);
    }

    renderTeamContext_();

    if (Number.isFinite(st.lastLat) && Number.isFinite(st.lastLng)) {
      lastPos = { lat: st.lastLat, lng: st.lastLng, accuracy: st.lastAccuracyM || 25 };
      updatePrimaryTeamOnMap_(lastPos);

      if (isPrimary_()) {
        updateYouOnMap(lastPos);
      } else {
        refreshEggMarkerDistances_();
      }
    }

    if (typeof st.score === "number") {
      score = st.score;
      localStorage.setItem("eggHunt_score", String(score));
      setTopStats();
    }

    if (st && st.radarMeta && Number.isFinite(st.radarMeta.cooldownRemainingMs)) {
      const rem = Number(st.radarMeta.cooldownRemainingMs || 0);
      if (rem > 0) startRadarCooldown_(rem);
    }

    if (st && st.radar && st.radar.radarId) {
      requestRadarPlayback_(st.radar);
    }

    lastTeamState_ = st;
    renderLootHud_(st);
    renderKitFromState_(st.equipment || {});

    const pendingEquipmentOffer = st.pendingLootOffer || null;

    if (!pendingEquipmentOffer || !pendingEquipmentOffer.offerId) {
      dismissActiveEquipmentOffer_();
    } else if (
      activeEquipmentOfferId_ &&
      String(activeEquipmentOfferId_) !== String(pendingEquipmentOffer.offerId)
    ) {
      dismissActiveEquipmentOffer_(activeEquipmentOfferId_);
    }

    if (!options.skipLootOffer) {
      maybeHandleLootOffer_(st).catch(function() {});
    }

    if (!options.skipEquipmentOffer) {
      maybeHandleEquipmentOffer_(pendingEquipmentOffer).catch(function() {});
    }

    return st;
  } finally {
    teamStatePollInFlight_ = false;
  }
}

async function pollNearbyEggs(options) {
  options = options || {};
  if (!lastPos || !playerId) return;

  if (!options.force && shouldSuppressBackgroundPolling_()) {
    return;
  }

  if (nearbyEggsPollInFlight_) {
    return;
  }

  nearbyEggsPollInFlight_ = true;

  try {
    const out = await api("game_nearbyEggs", {
      playerId: playerId,
      teamId: teamId,
      lat: lastPos ? lastPos.lat : "",
      lng: lastPos ? lastPos.lng : ""
    });

    applyGameTiming_(out);

    if (!out.ok) {
      setStatus(
        '<span class="bad">Field Link Unstable:</span> ' +
        userFacingBusyMessage_(out && out.error, "System traffic is high. Please retry.")
      );
      return;
    }

    if (out.state && out.state !== "LIVE") {
      clearEggMarkers();
      setStatus('<span class="bad">Game state:</span> ' + out.state);
      return;
    }

    const revealFromOut =
      (out && (out.revealMeters ?? out.revealRadiusM)) ??
      (out && out.debug && (out.debug.reveal ?? out.debug.revealMeters ?? out.debug.revealRadiusM));

    const revealNum = Number(revealFromOut);
    if (Number.isFinite(revealNum) && revealNum > 0) {
      lastRevealMeters = revealNum;
    }

    const claimFromOut =
      (out && (out.claimMeters ?? out.claimRadiusM)) ??
      (out && out.debug && (out.debug.claim ?? out.debug.claimMeters ?? out.debug.claimRadiusM));

    const claimNum = Number(claimFromOut);
    if (Number.isFinite(claimNum) && claimNum > 0) {
      lastClaimMeters = claimNum;
    }

    if (lastPos) updateRangeRings_([lastPos.lat, lastPos.lng]);

    (out.eggs || []).forEach(upsertEggMarker);
  } finally {
    nearbyEggsPollInFlight_ = false;
  }
}

async function claimEgg(eggId) {
  if (!lastPos || !playerId) return;

  if (gameIsOver_()) {
    await modalAlert_("Game over. Scanning has ended.", "Scan Egg");
    return;
  }

  if (teamId && !isPrimary_()) {
    await modalAlert_("Primary device required.", "Scan Egg");
    return;
  }

  if (scanRequestInFlight_) {
    return;
  }

  const prevPause = pauseTeamStatePolling_;
  pauseTeamStatePolling_ = true;
  scanRequestInFlight_ = true;
  beginQuietPeriod_(2500);

  try {
    const out = await api("game_claimEgg", {
      playerId: playerId,
      teamId: teamId,
      eggId: eggId,
      lat: lastPos.lat,
      lng: lastPos.lng
    });

    if (out && Number.isFinite(Number(out.claimMeters))) {
      lastClaimMeters = Number(out.claimMeters);
      updateRangeRings_([lastPos.lat, lastPos.lng]);
    }

    if (!out || !out.ok) {
      if (out && out.tooFar) {
        await modalAlert_(
          "Too far! You're " +
            out.distanceMeters +
            "m away (need <= " +
            out.claimMeters +
            "m).",
          "Scan Egg"
        );
        return;
      }

      await modalAlert_(
        userFacingBusyMessage_(out && out.error, "Scan failed."),
        "Scan Egg"
      );
      return;
    }

    if (out.alreadyClaimed) {
      markEggResolvedLocally_(eggId, true);
      await modalAlert_("Already scanned by your team.", "Scan Egg");
      return;
    }

    if (typeof out.teamScore === "number") {
      score = out.teamScore;
    } else {
      score = (score || 0) + (out.points || 0);
    }
    localStorage.setItem("eggHunt_score", String(score));
    setTopStats();

    const m = eggMarkers.get(eggId);
    if (m) map.removeLayer(m);
    eggMarkers.delete(eggId);
    setTopStats();

    const label =
      String(out.specialType || "").toUpperCase() === "EGG_PRIME"
        ? String(out.title || "Egg Prime")
        : (out.color && out.pattern
            ? properCase_(out.color) + " " + properCase_(out.pattern)
            : properCase_(out.rarity || "Egg"));

    let lootMsg = "";
    if (out.loot) {
      if (out.loot.kind === "INVENTORY" && out.loot.item) {
        const item = out.loot.item;

        lootMsg = "\nLoot drop: " + (item.name || item.lootId || "Loot");

        if (item.effectType) {
          lootMsg += "\nEffect: " + item.effectType;
        }

        if (Number.isFinite(Number(item.durationSec))) {
          lootMsg += "\nDuration: " + Number(item.durationSec) + "s";
        }
      } else if (out.loot.kind === "OFFER" && out.loot.item) {
        const item = out.loot.item;
        lootMsg = "\nEquipment Deployment: " + (item.name || item.lootId || "Loot");
      } else {
        lootMsg = "\nHQ is transmitting new equipment through the peepochron substrate. Resolving details...";
      }
    }

    await showModal_({
      title: "Egg Scanned",
      html: buildClaimScoreHtml_(label, out, lootMsg),
      buttons: [
        { label: "OK", value: true, className: "btn btn--primary" }
      ],
      dismissValue: true
    });

    if (teamId) {
      const hasEquipmentOfferFollowup =
        !!out.loot &&
        String(out.loot.kind || "").toUpperCase() === "OFFER";

      const st = hasEquipmentOfferFollowup
        ? await runWithLoading_(
            {
              loadingText: {
                text: "Recalibrating scanner…",
                subtext: "Re-tuning signal alignment after scan."
              },
              delayMs: 150
            },
            async function() {
              return await pollTeamState_({
                skipLootOffer: true,
                skipEquipmentOffer: true,
                force: true
              });
            }
          )
        : await pollTeamState_({
            skipLootOffer: true,
            skipEquipmentOffer: true,
            force: true
          });

      if (st && st.pendingLootOffer) {
        await maybeHandleEquipmentOffer_(st.pendingLootOffer);
      }
    }
  } catch (err) {
    await modalAlert_(
      userFacingBusyMessage_(err, "Scan failed."),
      "Scan Egg"
    );
  } finally {
    scanRequestInFlight_ = false;
    pauseTeamStatePolling_ = prevPause;
  }
}
function popupMetricsForZoom_(z) {
  const effectiveZoom = Math.min(z, 19);

  const titleSize = Math.max(14, Math.min(18, 14 + (effectiveZoom - 16) * 1.0));
  const bodySize = Math.max(12, Math.min(16, 12 + (effectiveZoom - 16) * 0.8));
  const padY = Math.max(8, Math.min(12, 8 + (effectiveZoom - 16) * 0.7));
  const padX = Math.max(10, Math.min(14, 10 + (effectiveZoom - 16) * 0.7));
  const btnRadius = Math.max(10, Math.min(14, 10 + (effectiveZoom - 16) * 0.5));

  return { titleSize, bodySize, padY, padX, btnRadius };
}

function applyPopupScale_() {
  if (!map) return;
  const z = map.getZoom();
  const m = popupMetricsForZoom_(z);

  document.documentElement.style.setProperty("--popupTitleSize", m.titleSize + "px");
  document.documentElement.style.setProperty("--popupBodySize", m.bodySize + "px");
  document.documentElement.style.setProperty("--popupPadY", m.padY + "px");
  document.documentElement.style.setProperty("--popupPadX", m.padX + "px");
  document.documentElement.style.setProperty("--popupBtnRadius", m.btnRadius + "px");
}

// -----------------------------
// Map init
// -----------------------------
function initMap() {
  map = L.map("map", {
    center: [CENTER_LAT, CENTER_LNG],
    zoom: 13,
    zoomControl: true,
    maxZoom: 21,
    zoomSnap: 0.5,
    zoomDelta: 0.5
  });

  // Rings pane (claim/reveal circles) — above normal overlays, below markers
  map.createPane("ringsPane");
  map.getPane("ringsPane").style.zIndex = 450;

  // Message overlays pane
  map.createPane("messageOverlayPane");
  map.getPane("messageOverlayPane").style.zIndex = 430;

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 21,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  map.on("zoomend", function() {
    applyPopupScale_();
    const z = map.getZoom();

    eggMarkers.forEach(function(m) {
      const isPrime = String(m._specialType || "").toUpperCase() === "EGG_PRIME";

      if (isPrime) {
        m.setIcon(eggPrimeIcon_(m._iconUrl || "./assets/egg-prime.gif", z));
      } else {
        m.setIcon(eggIcon_(m._eggColor, m._eggPattern, z));
      }
    });

    if (youMarker) {
      youMarker.setIcon(playerIcon_(z, isViewer_() ? "viewer" : "primary"));
    }

    if (primaryMarker) {
      primaryMarker.setIcon(primaryTeamIcon_(z));
    }
  });

  const overlayCloseBtn = $("messageOverlayClose");
  if (overlayCloseBtn) {
    overlayCloseBtn.onclick = function() {
      closeActiveMessageOverlay_().catch(function() {});
    };
  }

  setMessageOverlayHudVisible_(false);
}

function refreshMapLayout_() {
  if (!map) return;
  setTimeout(function() {
    if (map) map.invalidateSize();
  }, 0);
}

function setStartupMessage_(msg) {
  setStatus('<span class="mono">' + msg + '</span>');
  if (startupLoading_) {
    showLoading_(msg);
  }
}

function afterSetupUiSettles_() {
  return new Promise(function(resolve) {
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        setTimeout(resolve, 0);
      });
    });
  });
}

function waitForNextPaint_() {
  return new Promise(function(resolve) {
    requestAnimationFrame(function() {
      setTimeout(resolve, 0);
    });
  });
}

function waitForPlayerMarkerRendered_(timeoutMs) {
  timeoutMs = Number(timeoutMs || 5000);

  return new Promise(function(resolve, reject) {
    const started = Date.now();

    const timer = setInterval(function() {
      const rendered =
        !!youMarker &&
        !!youMarker._map &&
        !!youMarker._icon;

      if (rendered) {
        clearInterval(timer);
        resolve();
        return;
      }

      if ((Date.now() - started) >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for player marker to render."));
      }
    }, 100);
  });
}

function waitForMapSettled_(timeoutMs) {
  timeoutMs = Number(timeoutMs || 1500);

  return new Promise(function(resolve) {
    if (!map) {
      resolve();
      return;
    }

    let done = false;

    function finish() {
      if (done) return;
      done = true;
      map.off("moveend", finish);
      map.off("zoomend", finish);
      resolve();
    }

    map.once("moveend", finish);
    map.once("zoomend", finish);

    setTimeout(finish, timeoutMs);
  });
}

function waitForMapMoveEnd_(timeoutMs) {
  timeoutMs = Number(timeoutMs || 1500);

  return new Promise(function(resolve) {
    if (!map) {
      resolve();
      return;
    }

    let done = false;

    function finish() {
      if (done) return;
      done = true;
      map.off("moveend", finish);
      map.off("zoomend", finish);
      resolve();
    }

    map.once("moveend", finish);
    map.once("zoomend", finish);

    setTimeout(finish, timeoutMs);
  });
}

// -----------------------------
// Boot
// -----------------------------
function wireResetButton_() {
  const btn = $("resetPlayerBtn");
  if (!btn) return;

  btn.onclick = async function() {
    const isPrimaryDevice = isPrimary_();

    const modalConfig = isPrimaryDevice
      ? {
          title: "Reinitialize Primary Device",
          html:
            '<div>This will wipe this device’s field identity.</div>' +
            '<div class="small" style="margin-top:8px;">' +
              'This device is the <strong>PRIMARY</strong> for your team.' +
            '</div>' +
            '<div class="small" style="margin-top:6px;">' +
              'If you continue, your team will lose its active position and become non-functional.' +
            '</div>' +
            '<div class="small" style="margin-top:6px;">' +
              'All teammates will need to regroup and create a new team.' +
            '</div>'
        }
      : {
          title: "Reinitialize Device",
          html:
            '<div>This will wipe this device’s field identity.</div>' +
            '<div class="small" style="margin-top:8px;">' +
              'You will leave your current team and need to rejoin.' +
            '</div>'
        };

    const ok = await showModal_({
      title: modalConfig.title,
      html: modalConfig.html,
      buttons: [
        { label: "Cancel", value: false, className: "btn" },
        { label: "Reset", value: true, className: "btn btn--danger" }
      ],
      dismissValue: false
    });

    if (!ok) return;

    localStorage.removeItem("eggHunt_playerId");
    localStorage.removeItem("eggHunt_playerName");
    localStorage.removeItem("eggHunt_score");
    localStorage.removeItem("eggHunt_teamId");
    localStorage.removeItem("eggHunt_teamRole");
    localStorage.removeItem("eggHunt_teamName");
    sessionStorage.removeItem(FIRST_SETUP_RELOAD_KEY_);

    location.reload();
  };
}

function wireFilters_() {
  const filterColor = $("filterColor");
  const filterPattern = $("filterPattern");

  const onFilterChange = function() {
    clearEggMarkers();
    pollNearbyEggs().catch(function() {});
  };

  if (filterColor) filterColor.addEventListener("change", onFilterChange);
  if (filterPattern) filterPattern.addEventListener("change", onFilterChange);
}

function wireRadarButton_() {
  const btn = $("radarBtn");
  if (!btn) return;

  if (!isTeamMode_()) {
    btn.disabled = true;
    btn.title = "Join or create a team first";
    return;
  }

  if (isViewer_()) {
    btn.disabled = true;
    btn.title = "Primary device only";
    return;
  }

  btn.disabled = false;
  btn.onclick = async function() {
    if (!teamId || !playerId) return;
    if (!isPrimary_()) return;
    if (radarRequestInFlight || radarAnimating) return;

    radarRequestInFlight = true;
    btn.disabled = true;
    beginQuietPeriod_(2500);

    try {
      await runWithLoading_(
        {
          button: btn,
          delayMs: 150
        },
        async function() {
          const res = await api("radar", { playerId, teamId });

          if (!res || !res.ok) {
            if (res && Number.isFinite(res.cooldownRemainingMs)) {
              startRadarCooldown_(res.cooldownRemainingMs);
            }
            await modalAlert_(
              userFacingBusyMessage_(res && res.error, "Radar failed."),
              "Radar"
            );
            return;
          }

          if (Number.isFinite(res.cooldownMs)) {
            startRadarCooldown_(res.cooldownMs);
          }

          requestRadarPlayback_(res);
        }
      );
    } catch (e) {
      await modalAlert_(
        userFacingBusyMessage_(e, "Radar failed."),
        "Radar"
      );
    } finally {
      radarRequestInFlight = false;
      updateRadarBtnState_();
    }
  };
}

function wireLootUseBtn_() {
  const btn = $("lootUseBtn");
  if (!btn) return;

  btn.onclick = async function() {
    if (!teamId) {
      await modalAlert_("Join a team to use loot.", "Use Loot");
      return;
    }
    if (!isPrimary_()) {
      await modalAlert_("Primary device required.", "Use Loot");
      return;
    }
    if (lootFlowActive_) {
      return;
    }

    lootFlowActive_ = true;
    pauseTeamStatePolling_ = true;

    try {
      await runWithLoading_(
        {
          button: btn,
          delayMs: 150
        },
        async function() {
          // Use the latest locally-rendered HUD snapshot instead of forcing
          // a fresh poll with side effects right before prompting.
          const st = lastLootHudState_ || {};
          const inv = Array.isArray(st.inventory) ? st.inventory.slice() : [];

          if (!inv.length) {
            await modalAlert_("No loot in inventory.", "Use Loot");
            return;
          }

          const lines = inv
            .map((it, i) => `${i}: ${it.name || it.lootId || "Loot"}`)
            .join("\n");

          const pick = await modalPrompt_(
            `Use which slot?\n\n${lines}\n\nEnter a number:`,
            "0",
            "Use Loot"
          );

          if (pick === null) return;

          const idx = Number(pick);
          if (!Number.isInteger(idx) || idx < 0 || idx >= inv.length) {
            await modalAlert_("Please enter a valid slot number.", "Use Loot");
            return;
          }

          const chosen = inv[idx];

          const out = await api("loot_activate", {
            playerId: playerId,
            teamId: teamId,
            slotIndex: idx
          });

        if (!out || !out.ok) {
          await modalAlert_(
            userFacingBusyMessage_(out && out.error, "Failed to activate loot."),
            "Use Loot"
          );
          return;
}

          // Reflect mutation response immediately.
          const hudState = {
            inventory: out.inventory || [],
            activeEffects: out.activeEffects || {},
            lootSlotsMax: Number(st.lootSlotsMax || 0)
          };
          renderLootHud_(hudState);

          // Explicit success feedback so the action still feels successful
          // even if a later poll redraws the HUD.
          const activatedName = chosen && (chosen.name || chosen.lootId || "Loot");
          await modalAlert_("Activated: " + activatedName, "Use Loot");

          // Quiet sync after activation: refresh state, but do NOT trigger
          // a loot-offer modal as part of this post-mutation reconciliation.
          await pollTeamState_({ skipLootOffer: true });
        }
      );
      } catch (e) {
        await modalAlert_(
          userFacingBusyMessage_(e, "Failed to activate loot."),
          "Use Loot"
        );
      } finally {
      pauseTeamStatePolling_ = false;
      lootFlowActive_ = false;
    }
  };
}

function wireTeamContextPill_() {
  const pill = $("teamContextPill");
  if (!pill) return;

  pill.style.cursor = "pointer";
  pill.title = "View team details";

  pill.addEventListener("click", async function() {
    try {
      if (!isTeamMode_()) return;
      await openTeamPillModal_();
    } catch (err) {
      console.error(err);
      alert(err.message || "Failed to open team details.");
    }
  });
}
// -----------------------------
// Radar rendering (canvas overlay)
// -----------------------------
function setRadarOverlayVisible_(visible) {
  const ov = $("radarOverlay");
  if (!ov) return;
  ov.classList.toggle("hidden", !visible);
  ov.setAttribute("aria-hidden", visible ? "false" : "true");
}

function resizeRadarCanvas_() {
  const canvas = $("radarCanvas");
  const mapEl = $("map");
  if (!canvas || !mapEl) return;

  const rect = mapEl.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);

  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  canvas.style.width = rect.width + "px";
  canvas.style.height = rect.height + "px";
}

function bearingRad_(lat1, lng1, lat2, lng2) {
  // Returns bearing in radians, normalized to [0, 2π), where 0 is north, clockwise positive.
  const toRad = (x) => x * Math.PI / 180;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  let θ = Math.atan2(y, x); // -π..π, 0 = north
  if (θ < 0) θ += Math.PI * 2;
  return θ;
}

function metersToPixelRadius_(originLat, originLng, meters) {
  // Approx: project a point 'meters' to the north and measure pixel distance
  const dLat = meters / 111320; // meters per degree latitude approx
  const p0 = map.latLngToContainerPoint([originLat, originLng]);
  const p1 = map.latLngToContainerPoint([originLat + dLat, originLng]);
  return Math.max(1, Math.abs(p1.y - p0.y));
}

async function playRadar_(payload) {
  const radarId = String((payload && payload.radarId) || "");

  if (!map || radarAnimating) return;
  radarAnimating = true;
  radarActiveId_ = radarId;

  if (radarQueuedId_ === radarId) {
    radarQueuedId_ = "";
  }

  const originLat = Number(payload.originLat);
  const originLng = Number(payload.originLng);
  const radarRadiusM = Number(payload.radarRadiusM || 800);
  const revealRadiusM = Number(payload.revealRadiusM || 60);

  // Save current view; then fit radar circle
  radarPrevView = { center: map.getCenter(), zoom: map.getZoom() };
  const bounds = L.latLng(originLat, originLng).toBounds(radarRadiusM * 2);
  map.fitBounds(bounds, { padding: [24, 24] });

  // Disable interactions during sweep (optional but keeps it clean)
  map.dragging && map.dragging.disable();
  map.scrollWheelZoom && map.scrollWheelZoom.disable();
  map.doubleClickZoom && map.doubleClickZoom.disable();

  // Show overlay
  setRadarOverlayVisible_(true);
  resizeRadarCanvas_();

  const closeBtn = $("radarClose");
  if (closeBtn) {
    closeBtn.onclick = function() {
      // Allow manual close (minimal + safe)
      finishRadar_();
    };
  }

  const canvas = $("radarCanvas");
  const ctx = canvas.getContext("2d");
  const dpr = Math.max(1, window.devicePixelRatio || 1);

  const start = performance.now();
  const pulses = Math.max(1, Math.floor(Number(payload.pulses || 1)));
  const sweepDurationMs = 5000;
  const durationMs = pulses * sweepDurationMs;
  const eggs = (payload.eggs || []).map(e => ({
    eggId: e.eggId,
    lat: Number(e.lat),
    lng: Number(e.lng),
    color: e.color,
    pattern: e.pattern,
    bearing: bearingRad_(originLat, originLng, Number(e.lat), Number(e.lng)),
    lastSweepFired: -1
  }));

  const blips = []; // { x,y, bornMs }

  function drawFrame(now) {
    const t = Math.min(1, (now - start) / durationMs);

    // Convert total animation progress into multiple full sweeps.
    const sweepProgress = t * pulses;
    const sweepIndex = Math.min(pulses - 1, Math.floor(sweepProgress));
    const sweepT = (t >= 1) ? 1 : (sweepProgress - sweepIndex);
    const angle = sweepT * Math.PI * 2; // 0..2π within the current sweep

    // Clear
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Dark tint overlay
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Center point in pixels
    const c = map.latLngToContainerPoint([originLat, originLng]);
    const cx = c.x * dpr, cy = c.y * dpr;

    // Rings
    const ringEvery = 200;
    ctx.lineWidth = 1 * dpr;

    for (let m = ringEvery; m <= radarRadiusM; m += ringEvery) {
      const r = metersToPixelRadius_(originLat, originLng, m) * dpr;
      ctx.strokeStyle = "rgba(122,167,255,0.18)";
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      // Label every 200m (requested); keep subtle
      ctx.fillStyle = "rgba(232,238,252,0.55)";
      ctx.font = `${Math.round(11 * dpr)}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
      ctx.fillText(`${m}m`, cx + r + 6 * dpr, cy + 3 * dpr);
    }

    // Reveal radius ring (distinct)
    {
      const rr = metersToPixelRadius_(originLat, originLng, revealRadiusM) * dpr;
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Sweep counter
    if (pulses > 1) {
      ctx.fillStyle = "rgba(232,238,252,0.72)";
      ctx.font = `${Math.round(12 * dpr)}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
      ctx.fillText(`Pulse ${sweepIndex + 1}/${pulses}`, 12 * dpr, 22 * dpr);
    }

    // Compass markers
    ctx.fillStyle = "rgba(232,238,252,0.55)";
    ctx.font = `${Math.round(12 * dpr)}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    ctx.fillText("N", cx - 4 * dpr, 18 * dpr);
    ctx.fillText("S", cx - 4 * dpr, canvas.height - 10 * dpr);
    ctx.fillText("W", 10 * dpr, cy + 4 * dpr);
    ctx.fillText("E", canvas.width - 16 * dpr, cy + 4 * dpr);

    // Sweep arm
    const armLen = metersToPixelRadius_(originLat, originLng, radarRadiusM) * dpr;
    ctx.strokeStyle = "rgba(122,167,255,0.45)";
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + armLen * Math.sin(angle), cy - armLen * Math.cos(angle));
    ctx.stroke();

    // When arm passes egg bearing, add a blip once per sweep
    for (const e of eggs) {
      if (e.lastSweepFired === sweepIndex) continue;

      if (angle >= e.bearing || (t >= 1 && sweepIndex === pulses - 1)) {
        const pt = map.latLngToContainerPoint([e.lat, e.lng]);
        blips.push({ x: pt.x * dpr, y: pt.y * dpr, bornMs: now });
        e.lastSweepFired = sweepIndex;
      }
    }

    // Draw blips with fade out 0.8s
    const blipLife = 800;
    for (let i = blips.length - 1; i >= 0; i--) {
      const b = blips[i];
      const age = now - b.bornMs;
      if (age > blipLife) {
        blips.splice(i, 1);
        continue;
      }
      const a = 1 - (age / blipLife);
      ctx.fillStyle = `rgba(74,222,128,${0.75 * a})`;
      ctx.beginPath();
      ctx.arc(b.x, b.y, 4 * dpr, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(74,222,128,${0.35 * a})`;
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(b.x, b.y, 10 * dpr, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (t < 1) requestAnimationFrame(drawFrame);
    else finishRadar_();
  }

  function finishRadar_() {
    if (!radarAnimating) return;

    radarAnimating = false;
    radarQueuedId_ = "";

    if (radarId) {
      radarActiveId_ = "";
      lastRadarIdPlayed = radarId;
      localStorage.setItem(radarPlayedKey_(), radarId);
      radarSeenIds_.add(radarId);
    }

    setRadarOverlayVisible_(false);

    map.dragging && map.dragging.enable();
    map.scrollWheelZoom && map.scrollWheelZoom.enable();
    map.doubleClickZoom && map.doubleClickZoom.enable();

    if (radarPrevView) map.setView(radarPrevView.center, radarPrevView.zoom);
  }

  const onResize = function() { resizeRadarCanvas_(); };
  window.addEventListener("resize", onResize, { passive: true });

  try {
    requestAnimationFrame(drawFrame);
  } finally {
    const cleanup = function() {
      if (!radarAnimating) window.removeEventListener("resize", onResize);
      else setTimeout(cleanup, 250);
    };
    cleanup();
  }
}

async function boot() {
  setStatus('<span class="mono">Linking to ERSD Systems...</span>');

  wireResetButton_();
  wireMessagesUi_();
  if (!$("appModal")) {
    setStatus('<span class="bad">Modal UI failed to load.</span>');
    return;
  }
  wireFilters_();

  if (typeof L === "undefined") {
    setStatus('<span class="bad">Leaflet failed to load.</span> Check network/integrity/CSP.');
    return;
  }

  setTopStats();
  renderKitHudPlaceholder_();
  renderGameClock_();
  startGameClockTicker_();
  const hadPlayerBeforeBoot = !!playerId;
  const hadTeamBeforeBoot = !!teamId || !!teamRole;

  setStatus('<span class="mono">Setting up player...</span>');
  await ensurePlayer();

  setStatus('<span class="mono">Setting up team...</span>');
  await ensureTeam_();
  const gainedPlayerDuringSetup = !hadPlayerBeforeBoot && !!playerId;
  const gainedTeamDuringSetup = !hadTeamBeforeBoot && (!!teamId || !!teamRole);
  const needsPostSetupReload = gainedPlayerDuringSetup || gainedTeamDuringSetup;

  if (needsPostSetupReload && !sessionStorage.getItem(FIRST_SETUP_RELOAD_KEY_)) {
    sessionStorage.setItem(FIRST_SETUP_RELOAD_KEY_, "1");
    setStatus('<span class="mono">Setup complete. Reloading app...</span>');
    location.reload();
    return;
  }

  startupLoading_ = true;
  setStartupMessage_("Loading map...");

  initMap();
  applyPopupScale_();
  refreshMapLayout_();

  wireRadarButton_();
  wireLootUseBtn_();
  wireTeamContextPill_();
  renderTeamContext_();

  try {
    setStartupMessage_("Starting GPS...");
    startGeolocation();

    if (teamId) {
      setStartupMessage_("Loading equipment and team state...");
      await pollTeamState_();
    }

    if (!isViewer_()) {
      setStartupMessage_("Waiting for GPS fix...");
      await waitForInitialGpsFix_(20000);

      // Force the player marker/rings onto the map before eggs render
      if (lastPos) {
        updateYouOnMap(lastPos);
        refreshMapLayout_();

        // On a fresh player, the first setView/zoom is still settling here.
        // Wait for Leaflet to finish that move before adding eggs.
        await waitForMapSettled_(1500);
      }

      // Then give the browser one paint to show the settled player marker
      await waitForNextPaint_();

      setStartupMessage_("Detecting nearby eggs...");
      await pollNearbyEggs();
      setStartupMessage_("Placing your marker...");
      await waitForPlayerMarkerRendered_(5000);
      await waitForNextPaint_();
    }

    setInterval(function() {
      if (teamId && !pauseTeamStatePolling_) {
        pollTeamState_().catch(function() {});
      }

      pollNearbyEggs().catch(function(err) {
        setStatus('<span class="bad">Error:</span> ' + String(err && (err.message || err)));
      });
    }, POLL_MS);

    startupLoading_ = false;
    hideLoading_();

   if (isViewer_()) {
    setStatus('<span class="ok">Viewer mode</span> - observing PRIMARY device state...');
  } else if (lastPos) {
      setStatus(
        '<span class="ok">GPS OK</span> - ' +
        'lat <span class="mono">' + lastPos.lat.toFixed(5) + '</span>, ' +
        'lng <span class="mono">' + lastPos.lng.toFixed(5) + '</span> - ' +
        '+/-' + Math.round(lastPos.accuracy || 0) + 'm'
      );
    } else {
      setStatus('<span class="ok">Running</span>');
    }
  } catch (err) {
    startupLoading_ = false;
    hideLoading_();
    throw err;
  }
}

window.addEventListener("load", function() {
  boot().catch(function(err) {
    setStatus('<span class="bad">Startup error:</span> ' + String(err && (err.message || err)));
  });
});