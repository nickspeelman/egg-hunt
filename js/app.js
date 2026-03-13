// js/app.js

// -----------------------------
// Config
// -----------------------------
const API_URL = (window.EGGHUNT_CONFIG && window.EGGHUNT_CONFIG.API_URL) || "";
const POLL_MS = (window.EGGHUNT_CONFIG && window.EGGHUNT_CONFIG.POLL_MS) || 1000;
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


let map, youMarker, accuracyCircle;

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
let radarPrevView = null; // { center, zoom }
let eggMarkers = new Map(); // eggId -> Leaflet marker
let lastPos = null;
let startupLoading_ = false;
const FIRST_SETUP_RELOAD_KEY_ = "eggHunt_firstSetupReloadDone";

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

  const w = Math.round(eggSz.w * 1.15);
  const h = Math.round(w * 1.15);

  return {
    w: Math.max(20, Math.min(96, w)),
    h: Math.max(20, Math.min(96, h))
  };
}

function eggLabel_(egg) {
  const c = properCase_(egg.color || "RED");
  const p = properCase_(egg.pattern || "SOLID");
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
        '<path d="M9 10 L11.5 13 L14 9.5 L16.5 13 L19 10 L18.2 15 H9.8 Z" ' +
          'fill="rgba(255,255,255,0.92)" stroke="rgba(0,0,0,0.18)" stroke-width="0.4" />' +
        '<circle cx="11.5" cy="13" r="0.8" fill="rgba(0,0,0,0.18)"/>' +
        '<circle cx="14" cy="9.5" r="0.8" fill="rgba(0,0,0,0.18)"/>' +
        '<circle cx="16.5" cy="13" r="0.8" fill="rgba(0,0,0,0.18)"/>' +
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

// -----------------------------
// UI helpers
// -----------------------------

function showLoading_(message) {
  const overlay = document.getElementById("loadingOverlay");
  const text = document.getElementById("loadingText");
  if (text) text.textContent = message || "Working…";
  if (overlay) {
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
  }
}

function hideLoading_() {
  const overlay = document.getElementById("loadingOverlay");
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

    function finish(value) {
      modalCleanup_();
      modalSetVisible_(false);
      resolve(value);
    }

    buttons.forEach((b, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = b.className || "btn";
      btn.textContent = b.label || "OK";
      btn.onclick = function() {
        if (opts.input) {
          finish(input.value);
        } else {
          finish(b.value);
        }
      };
      actions.appendChild(btn);

      if (idx === buttons.length - 1) {
        setTimeout(() => btn.focus(), 0);
      }
    });

    root.querySelectorAll("[data-modal-close]").forEach(el => {
      el.onclick = function() {
        if (opts.dismissValue !== undefined) {
          finish(opts.dismissValue);
        }
      };
    });

    document.onkeydown = function(e) {
      if (e.key === "Escape" && opts.dismissValue !== undefined) {
        finish(opts.dismissValue);
        return;
      }

      if (opts.input && e.key === "Enter") {
        e.preventDefault();
        finish(input.value);
      }
    };

    modalSetVisible_(true);

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

function renderKitHudPlaceholder_() {
  const slots = ["binoculars", "boots", "scanner", "antenna", "basket", "powercell"];
  slots.forEach(function(slot) {
    const nameEl = $("kit_" + slot + "_name");
    const bonusEl = $("kit_" + slot + "_bonus");
    if (nameEl) nameEl.textContent = "Loading…";
    if (bonusEl) bonusEl.textContent = "Loading bonus…";
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

  if (!item) return "No bonus";

  const mag = Number(item.magnitude || 0);

  if (slot === "binoculars") {
    return mag > 0 ? "+" + Math.round(mag * 100) + "% reveal radius" : "Base reveal radius";
  }

  if (slot === "boots") {
    return mag > 0 ? "+" + Math.round(mag * 100) + "% claim radius" : "Base claim radius";
  }

  if (slot === "scanner") {
    return mag > 0 ? "+" + Math.round(mag * 100) + "% radar range" : "Base radar range";
  }

  if (slot === "antenna") {
    return mag > 0
      ? "+" + Math.round(mag) + " radar ping" + (Math.round(mag) === 1 ? "" : "s")
      : "1 radar ping";
  }

  if (slot === "basket") {
    return mag > 0 ? "+" + Math.round(mag * 100) + "% egg points" : "Base egg points";
  }

  if (slot === "powercell") {
    return mag > 0 ? "+" + Math.round(mag * 100) + "% radar recharge speed" : "Base radar recharge";
  }

  return "No bonus";
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
    binoculars: { label: "Binoculars", icon: "🔭" },
    boots: { label: "Boots", icon: "🥾" },
    scanner: { label: "Scanner", icon: "🎒" },
    antenna: { label: "Antenna", icon: "📡" },
    basket: { label: "Field Log", icon: "📓" },
    powercell: { label: "Power Cell", icon: "🔋" }
  };
  return map[String(slot || "")] || { label: String(slot || "Equipment"), icon: "🎁" };
}

function equipmentOfferTitle_(offer) {
  const meta = equipmentSlotMeta_(offer && offer.slot);
  const cmp = String((offer && offer.comparison) || "").toUpperCase();

  if (cmp === "DUPLICATE") {
    return meta.icon + " Duplicate " + meta.label + " Found";
  }
  return meta.icon + " New " + meta.label + " Found";
}

function equipmentOfferButtons_(offer) {
  const cmp = String((offer && offer.comparison) || "").toUpperCase();
  const incomingSellValue = Number((offer && offer.incomingSellValue) || 0);
  const equippedSellValue = Number((offer && offer.equippedSellValue) || 0);

  if (cmp === "DUPLICATE") {
    return [
      {
        label: "Convert to " + incomingSellValue + " points",
        value: "KEEP_CURRENT",
        className: "btn btn--primary"
      }
    ];
  }

  if (cmp === "DOWNGRADE") {
    return [
      {
        label: "Keep Current (+" + incomingSellValue + " points)",
        value: "KEEP_CURRENT",
        className: "btn"
      },
      {
        label: "Equip New (+" + equippedSellValue + " points)",
        value: "EQUIP_NEW",
        className: "btn btn--primary"
      }
    ];
  }

  return [
    {
      label: "Keep Current (+" + incomingSellValue + " points)",
      value: "KEEP_CURRENT",
      className: "btn"
    },
    {
      label: "Equip New",
      value: "EQUIP_NEW",
      className: "btn btn--primary"
    }
  ];
}

function renderEquipmentOfferHtml_(offer) {
  const meta = equipmentSlotMeta_(offer && offer.slot);
  const cmp = String((offer && offer.comparison) || "").toUpperCase();
  const item = (offer && offer.item) || {};
  const equipped = (offer && offer.equipped) || null;
  const incomingSellValue = Number((offer && offer.incomingSellValue) || 0);
  const equippedSellValue = Number((offer && offer.equippedSellValue) || 0);

  let comparisonText = "Choose which item to keep.";
  if (cmp === "UPGRADE") comparisonText = "This looks better than your current gear.";
  if (cmp === "DOWNGRADE") comparisonText = "This is weaker, but you can still swap if you want the points.";
  if (cmp === "DUPLICATE") comparisonText = "Your current gear is identical.";

  let noteHtml = "";
  if (cmp === "DUPLICATE") {
    noteHtml =
      '<div class="small">Keeping your current ' + escapeHtml_(meta.label) +
      ' converts the duplicate into <strong>' + incomingSellValue + ' points</strong>.</div>';
  } else if (cmp === "DOWNGRADE") {
    noteHtml =
      '<div class="small">' +
      'Keep Current: <strong>+' + incomingSellValue + ' points</strong><br>' +
      'Equip New: <strong>+' + equippedSellValue + ' points</strong> from your currently equipped item' +
      '</div>';
  } else {
    noteHtml =
      '<div class="small">Keep Current converts the new item into <strong>' +
      incomingSellValue + ' points</strong>.</div>';
  }

  return (
    '<div style="display:grid;gap:12px;">' +
      '<div>' +
        '<div style="font-weight:700;">' + escapeHtml_(meta.label) + '</div>' +
        '<div class="small">' + escapeHtml_(comparisonText) + '</div>' +
      '</div>' +

      '<div style="border:1px solid var(--border);border-radius:12px;padding:10px;">' +
        '<div class="small">New Item</div>' +
        '<div style="font-weight:700;">' + escapeHtml_(item.name || "Unknown item") + '</div>' +
        '<div class="small">' + escapeHtml_(formatKitBonus_(item)) + '</div>' +
      '</div>' +

      (
        equipped
          ? (
              '<div style="border:1px solid var(--border);border-radius:12px;padding:10px;">' +
                '<div class="small">Currently Equipped</div>' +
                '<div style="font-weight:700;">' + escapeHtml_(equipped.name || "Unknown item") + '</div>' +
                '<div class="small">' + escapeHtml_(formatKitBonus_(equipped)) + '</div>' +
              '</div>'
            )
          : ""
      ) +

      noteHtml +
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

function isTeamMode_() { return !!teamId; }
function isPrimary_() { return String(teamRole || "").toUpperCase() === "PRIMARY"; }
function isViewer_() { return isTeamMode_() && !isPrimary_(); }

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

function updateRadarBtnState_() {
  const btn = document.getElementById("radarBtn");
  if (!btn) return;

  const now = Date.now();
  const remainingMs = Math.max(0, radarCooldownUntilMs - now);
  const remainingS = Math.ceil(remainingMs / 1000);

  const inCooldown = remainingMs > 0;

  // If you already track primary/viewer, fold that in here:
  // const canUseRadar = (window.APP_ROLE === "PRIMARY");
  // btn.disabled = inCooldown || !canUseRadar;
  btn.disabled = inCooldown;
  btn.classList.toggle("isCooldown", inCooldown);

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
    // Stop the interval once we’re done
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

function fmtMs_(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2,"0")}`;
}

function effectLabel_(k, eff) {
  if (!eff) return k;
  if (k === "revealRadiusBoost") return `Reveal +${Math.round(Number(eff.magnitude||0)*100)}%`;
  if (k === "claimRadiusBoost") return `Claim +${Math.round(Number(eff.magnitude||0)*100)}%`;
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

  try {
    const decision = await showModal_({
      title: equipmentOfferTitle_(offer),
      html: renderEquipmentOfferHtml_(offer),
      buttons: equipmentOfferButtons_(offer)
    });

    if (!decision) {
      console.log("[equipmentOffer] no decision returned");
      return;
    }

    const out = await respondEquipmentOffer_(offerId, decision);

    if (!out || !out.ok) {
      await modalAlert_((out && out.error) || "Equipment offer response failed.", "Egg Hunter Kit");
      return;
    }

    lastEquipmentOfferIdSeen = offerId;
    localStorage.setItem("eggHunt_lastEquipmentOfferId", offerId);
    console.log("[equipmentOffer] resolved:", decision, offerId);

    await pollTeamState_({
      skipLootOffer: true,
      skipEquipmentOffer: true
    });
  } catch (err) {
    console.error("[equipmentOffer] modal failed:", err);
    throw err;
  } finally {
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

async function ensureTeam_() {
  if (teamId && teamRole) return;

  const mode = await modalPrompt_(
    "Team mode:\n" +
    "1 = Create a team (PRIMARY)\n" +
    "2 = Join a team (VIEWER)\n" +
    "Leave blank for solo mode",
    "",
    "Team Mode"
  );

  if (!mode) return; // solo mode (legacy)

  if (String(mode).trim() === "1") {
    const rawTeamName = await modalPrompt_("Team name?", teamName || "Team", "Create Team");
    const name = (rawTeamName == null ? "" : String(rawTeamName).trim()) || "Team";
    const out = await api("createTeam", { playerId: playerId, teamName: name });
    if (!out.ok) throw new Error(out.error || "Failed to create team.");
    teamId = out.teamId; teamRole = out.role || "PRIMARY"; teamName = out.teamName || name;
  } else if (String(mode).trim() === "2") {
    const rawTid = await modalPrompt_("Enter teamId to join:", "", "Join Team");
    const tid = (rawTid == null ? "" : String(rawTid).trim());
    const out = await api("joinTeam", { playerId: playerId, teamId: tid });
    if (!out.ok) throw new Error(out.error || "Failed to join team.");
    teamId = out.teamId; teamRole = out.role || "VIEWER";
    teamName = teamName || "";
  } else {
    return; // treat as solo
  }

  localStorage.setItem("eggHunt_teamId", teamId);
  localStorage.setItem("eggHunt_teamRole", teamRole);
  localStorage.setItem("eggHunt_teamName", teamName);
    // After teamId is known, load persisted "last radar played" for THIS team
  lastRadarIdPlayed = localStorage.getItem(radarPlayedKey_()) || "";
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
      lastPos = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy };
      updateYouOnMap(lastPos);

      // PRIMARY updates authoritative TeamState
      if (teamId && isPrimary_()) {
        api("updateLocation", {
          playerId: playerId,
          teamId: teamId,
          lat: lastPos.lat,
          lng: lastPos.lng,
          accuracyM: lastPos.accuracy
        }).catch(function() {});
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

function playerIcon_(zoom) {
  const z = (typeof zoom === "number") ? zoom : (map ? map.getZoom() : 16);
  const sz = hunterSizeForZoom_(z);
  const w = sz.w;
  const h = sz.h;

  const imgHtml =
    '<img src="assets/hunter.png" alt="" ' +
    'style="display:block;width:' + w + 'px;height:' + h + 'px;object-fit:contain;" />';

  return L.divIcon({
    className: "player-icon",
    html: imgHtml,
    iconSize: [w, h],
    iconAnchor: [Math.round(w / 2), Math.round(h / 2)],
    popupAnchor: [0, -Math.round(h * 0.45)]
  });
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
  updateRangeRings_(latlng);

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

// -----------------------------
// Eggs
// -----------------------------

function buildEggPopupHtml_(marker) {
  const d = lastPos
    ? Math.round(map.distance(
        [lastPos.lat, lastPos.lng],
        [marker._eggLat, marker._eggLng]
      ))
    : Math.round(Number(marker._eggDistanceMeters || 0));

  const claimUi = (teamId && isViewer_())
    ? '<div class="small"><span class="bad">Primary device required</span></div>'
    : '<button id="claim_' + marker._eggId + '" class="claim-btn">Claim</button>';

  return (
    "<b>" + eggLabel_({ color: marker._eggColor, pattern: marker._eggPattern }) + "</b><br/>" +
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

  const btn = document.getElementById("claim_" + marker._eggId);
  if (!btn) return;

  btn.onclick = async function() {
    await runWithLoading_(
      {
        button: btn,
        delayMs: 150
      },
      async function() {
        await claimEgg(marker._eggId);
      }
    );
  };
}


function upsertEggMarker(egg) {
  if (eggMarkers.has(egg.eggId)) return;

  const fc = String($("filterColor").value || "").toUpperCase();
  const fp = String($("filterPattern").value || "").toUpperCase();
  if ((fc && String(egg.color || "").toUpperCase() !== fc) ||
      (fp && String(egg.pattern || "").toUpperCase() !== fp)) {
    return;
  }

  const m = L.marker(
    [egg.lat, egg.lng],
    { icon: eggIcon_(egg.color, egg.pattern, map.getZoom()) }
  ).addTo(map);

  m._eggId = egg.eggId;
  m._eggLat = Number(egg.lat);
  m._eggLng = Number(egg.lng);
  m._eggColor = egg.color;
  m._eggPattern = egg.pattern;
  m._eggDistanceMeters = Number(egg.distanceMeters || 0);

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
  const out = await api("teamState", { playerId: playerId, teamId: teamId });
  if (!out.ok) {
    setStatus('<span class="bad">API error:</span> ' + (out.error || "teamState failed"));
    return null;
  }
  const st = out.state || {};
  if (Number.isFinite(st.lastLat) && Number.isFinite(st.lastLng)) {
    lastPos = { lat: st.lastLat, lng: st.lastLng, accuracy: st.lastAccuracyM || 25 };
    updateYouOnMap(lastPos);
  }
  if (typeof st.score === "number") {
    score = st.score;
    localStorage.setItem("eggHunt_score", String(score));
    setTopStats();
  }

  // Restore cooldown from server (so refresh doesn't reset)
  if (st && st.radarMeta && Number.isFinite(st.radarMeta.cooldownRemainingMs)) {
    const rem = Number(st.radarMeta.cooldownRemainingMs || 0);
    if (rem > 0) startRadarCooldown_(rem);
  }

  // Replay latest RADAR only once per radarId (persisted across refresh)
  if (st && st.radar && st.radar.radarId) {
    const rid = String(st.radar.radarId);
    if (rid && rid !== lastRadarIdPlayed && !radarAnimating) {
      lastRadarIdPlayed = rid;
      localStorage.setItem(radarPlayedKey_(), rid);
      playRadar_(st.radar).catch(function() {});
    }
  }

  lastTeamState_ = st;
  renderLootHud_(st);
  renderKitFromState_(st.equipment || {});

  console.log("[teamState] pendingLootOffer top-level:", out.pendingLootOffer);
  console.log("[teamState] pendingLootOffer in state:", st.pendingLootOffer);
  console.log("[teamState] full out:", out);

  if (!options.skipLootOffer) {
    maybeHandleLootOffer_(st).catch(function(){});
  }

  if (!options.skipEquipmentOffer) {
    maybeHandleEquipmentOffer_(st.pendingLootOffer).catch(function(){});
  }

  return st;
}

async function pollNearbyEggs() {
  if (!lastPos || !playerId) return;

  const out = await api("game_nearbyEggs", {
    playerId: playerId,
    teamId: teamId,
    lat: lastPos ? lastPos.lat : "",
    lng: lastPos ? lastPos.lng : ""
  });

  console.log("[nearbyEggs] keys:", Object.keys(out || {}));
  console.log("[nearbyEggs] claim candidates:", {
    claimMeters: out?.claimMeters,
    claimRadiusM: out?.claimRadiusM,
    debugClaim: out?.debug?.claim,
    debugClaimMeters: out?.debug?.claimMeters,
    cfgClaimMeters: out?.cfg?.claimMeters,
    cfgClaimRadiusM: out?.cfg?.claimRadiusM
  });

  if (!out.ok) {
    setStatus('<span class="bad">API error:</span> ' + (out.error || "unknown"));
    return;
  }

  if (out.state && out.state !== "LIVE") {
    clearEggMarkers();
    setStatus('<span class="bad">Game state:</span> ' + out.state);
    return;
  }

    // Capture reveal radius if the backend includes it (support a few common shapes)
  const revealFromOut =
    (out && (out.revealMeters ?? out.revealRadiusM)) ??
    (out && out.debug && (out.debug.reveal ?? out.debug.revealMeters ?? out.debug.revealRadiusM));

    const revealNum = Number(revealFromOut);
    if (Number.isFinite(revealNum) && revealNum > 0) {
      lastRevealMeters = revealNum;
    }

  // If you ever include claim radius in nearbyEggs responses, we'll pick it up too
  const claimFromOut =
    (out && (out.claimMeters ?? out.claimRadiusM)) ??
    (out && out.debug && (out.debug.claim ?? out.debug.claimMeters ?? out.debug.claimRadiusM));

    const claimNum = Number(claimFromOut);
    if (Number.isFinite(claimNum) && claimNum > 0) {
      lastClaimMeters = claimNum;
    }
  // If we already have a position, refresh rings immediately
  if (lastPos) updateRangeRings_([lastPos.lat, lastPos.lng]);

  (out.eggs || []).forEach(upsertEggMarker);
}

async function claimEgg(eggId) {
  if (!lastPos || !playerId) return;

  if (teamId && !isPrimary_()) {
    await modalAlert_("Primary device required.", "Claim Egg");
    return;
  }

  const prevPause = pauseTeamStatePolling_;
  pauseTeamStatePolling_ = true;

  try {
    const out = await api("game_claimEgg", {
      playerId: playerId,
      teamId: teamId,
      eggId: eggId,
      lat: lastPos.lat,
      lng: lastPos.lng
    });

    // If backend tells us the claim radius, store it and refresh the ring immediately.
    if (out && Number.isFinite(Number(out.claimMeters))) {
      lastClaimMeters = Number(out.claimMeters);
      updateRangeRings_([lastPos.lat, lastPos.lng]);
    }

    // Handle errors
    if (!out || !out.ok) {
      if (out && out.tooFar) {
        await modalAlert_(
          "Too far! You're " +
            out.distanceMeters +
            "m away (need <= " +
            out.claimMeters +
            "m).",
          "Claim Egg"
        );
        return;
      }
      await modalAlert_((out && out.error) || "Claim failed.", "Claim Egg");
      return;
    }

    // Server says it's already claimed
    if (out.alreadyClaimed) {
      await modalAlert_("You already claimed this egg.", "Claim Egg");
      return;
    }

    // Update score
    if (typeof out.teamScore === "number") {
      score = out.teamScore;
    } else {
      score = (score || 0) + (out.points || 0);
    }
    localStorage.setItem("eggHunt_score", String(score));
    setTopStats();

    // Remove marker from map
    const m = eggMarkers.get(eggId);
    if (m) map.removeLayer(m);
    eggMarkers.delete(eggId);
    setTopStats();

    // Success message
    const label =
      out.color && out.pattern
        ? properCase_(out.color) + " " + properCase_(out.pattern)
        : properCase_(out.rarity || "Egg");

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
        lootMsg = "\nLoot found: " + (item.name || item.lootId || "Loot");
      } else {
        lootMsg = "\nLoot drop!";
      }
    }

    await modalAlert_(
      "Claimed (" + label + ") +" + out.points + " points!" + lootMsg,
      "Egg Claimed"
    );

    if (teamId) {
      const st = await pollTeamState_({
        skipLootOffer: true,
        skipEquipmentOffer: true
      });

      if (st && st.pendingLootOffer) {
        await maybeHandleEquipmentOffer_(st.pendingLootOffer);
      }
    }
  } 
  
  finally {
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
  // overlayPane ~400, markerPane ~600
  map.getPane("ringsPane").style.zIndex = 450;

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 21,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  map.on("zoomend", function() {
    applyPopupScale_();
    const z = map.getZoom();

    eggMarkers.forEach(function(m) {
      m.setIcon(eggIcon_(m._eggColor, m._eggPattern, z));
    });

    if (youMarker) {
      youMarker.setIcon(playerIcon_(z));
    }
  });
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
  btn.onclick = function() {
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

  // Only PRIMARY can trigger; VIEWERS can still see replay
  if (!isTeamMode_() || isViewer_()) {
    btn.disabled = true;
    return;
  }

  btn.disabled = false;
  btn.onclick = async function() {
    if (!teamId || !playerId) return;
    if (!isPrimary_()) return;

       try {
      await runWithLoading_(
        {
          button: btn,
          delayMs: 150
        },
        async function() {
          // ONE call only
          const res = await api("radar", { playerId, teamId });

          if (!res || !res.ok) {
            if (res && Number.isFinite(res.cooldownRemainingMs)) {
              startRadarCooldown_(res.cooldownRemainingMs);
            }
            await modalAlert_((res && res.error) || "Radar failed.", "Radar");
            return;
          }

          // Success: start cooldown immediately (server tells us how long)
          if (Number.isFinite(res.cooldownMs)) {
            startRadarCooldown_(res.cooldownMs);
          }

          // Mark as played on PRIMARY too (so polling doesn't double-trigger)
          lastRadarIdPlayed = String(res.radarId || "");
          localStorage.setItem(radarPlayedKey_(), lastRadarIdPlayed);
          await playRadar_(res);
        }
      );
    } catch (e) {
      await modalAlert_(String(e && (e.message || e)), "Radar");
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
            await modalAlert_((out && out.error) || "Failed to activate loot.", "Use Loot");
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
      await modalAlert_(String(e && (e.message || e)), "Use Loot");
    } finally {
      pauseTeamStatePolling_ = false;
      lootFlowActive_ = false;
    }
  };
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
  if (!map || radarAnimating) return;
  radarAnimating = true;

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
    setRadarOverlayVisible_(false);

    map.dragging && map.dragging.enable();
    map.scrollWheelZoom && map.scrollWheelZoom.enable();
    map.doubleClickZoom && map.doubleClickZoom.enable();

    if (radarPrevView) map.setView(radarPrevView.center, radarPrevView.zoom);
    radarAnimating = false;
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
  setStatus('<span class="mono">Initializing...</span>');

  wireResetButton_();
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
   try {
    if (!isViewer_()) {
      setStartupMessage_("Starting GPS...");
      startGeolocation();
    }

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

      setStartupMessage_("Revealing nearby eggs...");
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
      setStatus('<span class="ok">Viewer mode</span> - mirroring team location...');
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