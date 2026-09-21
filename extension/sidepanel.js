const $ = (id) => document.getElementById(id);

const threshold = $("threshold");
const thresholdValue = $("thresholdValue");
const helperStatus = $("helperStatus");
const errorBox = $("errorBox");
const sitePill = $("sitePill");
const resultsList = $("resultsList");
const emptyState = $("emptyState");
const detectedCount = $("detectedCount");
const scannedCount = $("scannedCount");
const flaggedCount = $("flaggedCount");
const uncertainCount = $("uncertainCount");
const queueCount = $("queueCount");
const latencyValue = $("latencyValue");
const scanState = $("scanState");
const clearBtn = $("clearBtn");
const rescanBtn = $("rescanBtn");

const EXPECTED_SCANNER_VERSION = "0.5.2";
const EXPECTED_SCORING_VERSION = "0.5.0";

let pollTimer = null;
let lastFindingsKey = "";

const LABELS = {
  genericity: "Generic",
  templated_style: "Templated",
  synthetic_tone: "Synthetic tone",
  engagement_bait: "Engagement bait",
  low_information: "Low information",
  formula_patterns: "Formula patterns",
  repetition: "Repetition",
  listicle: "Listicle",
  cta_bait: "CTA bait",
  buzzword_hype: "Hype language",
  regular_cadence: "Regular cadence",
  conditional_template: "Conditional templates",
  contrast_template: "Contrast templates",
  dash_style: "Dash pattern",
  ai_slop: "AI slop"
};

function pct(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function setError(message = "") {
  errorBox.textContent = message;
  errorBox.classList.toggle("hidden", !message);
}

async function getTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");
  if (!/^https?:/i.test(tab.url || "")) {
    throw new Error("Open X, LinkedIn or Reddit in a normal web tab.");
  }
  return tab;
}

async function forceInjectScanner() {
  const tab = await getTab();
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["extraction.js", "content.js"]
  });
}

async function sendToTab(message, injectIfMissing = true) {
  const tab = await getTab();

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (firstError) {
    if (!injectIfMissing) throw firstError;

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["extraction.js", "content.js"]
    });

    return await chrome.tabs.sendMessage(tab.id, message);
  }
}

async function checkHelper() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "LAYA_HELPER_HEALTH" });
    if (!response?.ok) throw new Error(response?.error || "helper offline");

    if (response.data?.scoring_version !== EXPECTED_SCORING_VERSION) {
      helperStatus.className = "status bad";
      helperStatus.textContent = "restart helper";
      return false;
    }
    helperStatus.className = "status ok";
    helperStatus.textContent = response.data?.loaded ? "Laya-MLX ready" : "helper ready";
    return true;
  } catch {
    helperStatus.className = "status bad";
    helperStatus.textContent = "helper offline";
    return false;
  }
}

function findingsKey(findings) {
  return (findings || []).map((x) => `${x.id}:${x.risk}`).join("|");
}

function renderFindings(findings = []) {
  const key = findingsKey(findings);
  if (key === lastFindingsKey) return;
  lastFindingsKey = key;

  resultsList.replaceChildren();
  emptyState.classList.toggle("hidden", findings.length > 0);

  for (const item of findings) {
    const card = document.createElement("article");
    card.className = "finding";

    const top = document.createElement("div");
    top.className = "finding-top";

    const label = document.createElement("span");
    label.className = "finding-label";
    label.textContent = "AI SLOP";

    const risk = document.createElement("span");
    risk.className = "risk";
    risk.textContent = `${Math.round(Number(item.risk || 0) * 100)}/100`;

    top.append(label, risk);

    const quote = document.createElement("p");
    quote.className = "quote";
    quote.textContent = item.text || "";

    const signals = document.createElement("div");
    signals.className = "signals";

    Object.entries(item.signals || {})
      .filter(([name]) => name !== "ai_slop")
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .forEach(([name, value]) => {
        const chip = document.createElement("span");
        chip.className = "signal";
        chip.textContent = `${LABELS[name] || name} ${pct(value)}`;
        signals.appendChild(chip);
      });

    card.append(top, quote, signals);
    resultsList.appendChild(card);
  }
}

async function refreshStatus() {
  try {
    let status = await sendToTab({ type: "LAYA_STATUS" });

    // An already-open tab can keep an old extension content script alive after
    // the extension is reloaded. Require an explicit scanner-version handshake
    // and replace stale scanners automatically.
    if (status?.scannerVersion !== EXPECTED_SCANNER_VERSION) {
      await forceInjectScanner();
      status = await sendToTab({ type: "LAYA_STATUS" }, false);
    }

    setError("");

    if (!status?.supported) {
      sitePill.textContent = "Unsupported site";
      sitePill.className = "site-pill unsupported";
      scanState.textContent = "waiting";
      detectedCount.textContent = "0";
      scannedCount.textContent = "0";
      flaggedCount.textContent = "0";
      uncertainCount.textContent = "0";
      queueCount.textContent = "0";
      latencyValue.textContent = "—";
      renderFindings([]);
      return;
    }

    sitePill.textContent = status.site;
    sitePill.className = "site-pill";

    detectedCount.textContent = String(status.candidateRoots || status.foundRoots || 0);
    scannedCount.textContent = String(status.scanned || 0);
    flaggedCount.textContent = String(status.flagged || 0);
    uncertainCount.textContent = String(status.uncertain || 0);
    queueCount.textContent = String((status.queued || 0) + (status.analyzing || 0));
    latencyValue.textContent = status.lastLatencyMs ? `${status.lastLatencyMs} ms` : "—";

    const scanAge = status.lastScanAt ? Date.now() - Number(status.lastScanAt) : Infinity;

    if (status.scannerError) {
      scanState.textContent = "scanner error";
      setError(`Scanner: ${status.scannerError}`);
    } else if (status.helperError) {
      scanState.textContent = "retrying";
      setError(`Local helper: ${status.helperError}`);
    } else if (status.analyzing) {
      scanState.textContent = `analyzing · v${status.scannerVersion} · DOM ${status.candidateRoots || 0}/${status.foundRoots || 0}`;
    } else if (status.queued) {
      scanState.textContent = `queued · v${status.scannerVersion} · DOM ${status.candidateRoots || 0}/${status.foundRoots || 0}`;
    } else if (scanAge > 4500) {
      scanState.textContent = `scanner stalled · v${status.scannerVersion} · DOM ${status.candidateRoots || 0}/${status.foundRoots || 0}`;
      await sendToTab({ type: "LAYA_RESCAN" }, false).catch(() => {});
    } else if (!status.foundRoots && status.candidateRoots) {
      scanState.textContent = "no eligible text";
      const reasons = [];
      if (status.skippedVisibility) reasons.push(`${status.skippedVisibility} outside view or hidden`);
      if (status.skippedMissingText) reasons.push(`${status.skippedMissingText} without readable post text`);
      if (status.skippedShortText) reasons.push(`${status.skippedShortText} with too little text`);
      setError(`Found ${status.candidateRoots} containers; ${reasons.join("; ") || "no posts ready for analysis"}.`);
    } else {
      scanState.textContent = `watching · v${status.scannerVersion} · DOM ${status.candidateRoots || 0}/${status.foundRoots || 0}`;
    }

    renderFindings(status.recentFindings || []);
  } catch (error) {
    const message = String(error?.message || error);
    setError(message);
    sitePill.textContent = "Could not attach";
    sitePill.className = "site-pill unsupported";
  }
}

threshold.addEventListener("input", () => {
  thresholdValue.textContent = `${threshold.value}/100`;
});

threshold.addEventListener("change", async () => {
  const value = Number(threshold.value);
  await chrome.storage.local.set({ slopThreshold: value });
  await sendToTab({ type: "LAYA_CONFIG", threshold: value / 100 }).catch(() => {});
});

clearBtn.addEventListener("click", async () => {
  await sendToTab({ type: "LAYA_CLEAR" }).catch((error) => setError(String(error?.message || error)));
  await refreshStatus();
});

rescanBtn.addEventListener("click", async () => {
  await sendToTab({ type: "LAYA_RESCAN" }).catch((error) => setError(String(error?.message || error)));
  await refreshStatus();
});

chrome.storage.local.get({ slopThreshold: 65, calibrationVersion: 0 }, async ({ slopThreshold, calibrationVersion }) => {
  // v3 switched to precision-first calibration. Reset older installs once so
  // stale 72% settings do not recreate the old false-positive behavior.
  if (Number(calibrationVersion) < 4) {
    slopThreshold = 65;
    await chrome.storage.local.set({ slopThreshold: 65, calibrationVersion: 4 });
  }
  threshold.value = String(slopThreshold);
  thresholdValue.textContent = `${slopThreshold}/100`;
});

async function start() {
  await checkHelper();
  await refreshStatus();
  pollTimer = setInterval(refreshStatus, 850);
}

addEventListener("unload", () => {
  if (pollTimer) clearInterval(pollTimer);
});

start();
