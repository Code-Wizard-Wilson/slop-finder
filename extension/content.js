(() => {
  const SCANNER_VERSION = "0.4.1";
  const previousScanner = globalThis.__slopFinderScanner;

  if (previousScanner?.version === SCANNER_VERSION && typeof previousScanner.rescan === "function") {
    previousScanner.rescan();
    return;
  }

  if (previousScanner && typeof previousScanner.destroy === "function") {
    try { previousScanner.destroy(); } catch (_) {}
  }

  const POST_ATTR = "data-slop-finder-post-id";
  const STATE_ATTR = "data-slop-finder-state-v041";
  const HASH_ATTR = "data-slop-finder-hash-v041";
  const TAPE_CLASS = "slop-finder-overlay";
  const DEFAULT_THRESHOLD = 0.65;
  const BATCH_SIZE = 4;
  const MIN_TEXT = 45;
  const MAX_TEXT = 4200;

  let threshold = DEFAULT_THRESHOLD;
  let idCounter = 0;
  let scanTimer = null;
  let processing = false;
  let helperOfflineUntil = 0;
  const queue = [];
  const resultsById = new Map();
  const recentFindings = [];

  const stats = {
    site: "unsupported",
    supported: false,
    scanned: 0,
    flagged: 0,
    queued: 0,
    analyzing: 0,
    helperError: "",
    lastLatencyMs: 0,
    foundRoots: 0,
    candidateRoots: 0,
    scanCycles: 0,
    lastScanAt: 0,
    scannerVersion: SCANNER_VERSION,
  };

  const SITE = detectSite();
  if (SITE) {
    stats.site = SITE.name;
    stats.supported = true;
  }

  injectStyles();

  chrome.storage.local.get({
    slopThreshold: Math.round(DEFAULT_THRESHOLD * 100),
    calibrationVersion: 0
  }, async (data) => {
    let stored = Number(data.slopThreshold || 65);
    if (Number(data.calibrationVersion) < 4) {
      stored = 65;
      await chrome.storage.local.set({ slopThreshold: 65, calibrationVersion: 4 });
    }
    threshold = Math.max(0.4, Math.min(0.98, stored / 100));
    refreshExistingMarks();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.slopThreshold) {
      threshold = Math.max(0.4, Math.min(0.98, Number(changes.slopThreshold.newValue || 65) / 100));
      refreshExistingMarks();
    }
  });

  function detectSite() {
    const host = location.hostname.toLowerCase().replace(/^www\./, "");

    if (host === "x.com" || host === "twitter.com") {
      return {
        name: "X / Twitter",
        key: "x",
        selectors: ["article[data-testid='tweet']"],
        markerSelectors: ["article[data-testid='tweet']"],
        rootSelector: "article[data-testid='tweet']",
        textSelectors: ["[data-testid='tweetText']"],
      };
    }

    if (host === "reddit.com" || host.endsWith(".reddit.com")) {
      return {
        name: "Reddit",
        key: "reddit",
        selectors: [
          "shreddit-post",
          "article[data-testid='post-container']",
          "div[data-testid='post-container']",
          "[data-post-id]",
          "[data-fullname^='t3_']",
          "main article",
          "main [role='article']"
        ],
        markerSelectors: [
          "a[href*='/comments/']",
          "[data-click-id='comments']",
          "a[aria-label*='comment']",
          "button[aria-label*='upvote']",
          "button[aria-label*='downvote']",
          "shreddit-post"
        ],
        rootSelector: "shreddit-post, article[data-testid='post-container'], div[data-testid='post-container'], [data-post-id], [data-fullname^='t3_'], article, [role='article']",
        textSelectors: [
          "[slot='title']",
          "[data-testid='post-title']",
          "[data-post-click-location='title']",
          "[data-post-click-location='text-body']",
          "[slot='text-body']",
          "[data-click-id='text']",
          ".md"
        ],
      };
    }

    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
      return {
        name: "LinkedIn",
        key: "linkedin",
        selectors: [
          "main div.feed-shared-update-v2",
          "main [data-urn^='urn:li:activity']",
          "main [data-urn*='activity']",
          "main article[data-view-name='feed-full-update']",
          "main [data-view-name='feed-full-update']",
          "main article",
          "main [role='article']"
        ],
        markerSelectors: [
          "a[href*='/feed/update/urn:li:activity:']",
          "a[href*='/posts/']",
          "[data-urn^='urn:li:activity']",
          "[data-urn*='activity']",
          "button[aria-label*='Like']",
          "button[aria-label*='Comment']",
          "button[aria-label*='Repost']",
          "button[aria-label*='React']"
        ],
        rootSelector: "article, [role='article'], .feed-shared-update-v2, [data-view-name='feed-full-update'], [data-urn*='activity']",
        textSelectors: [
          ".update-components-text",
          ".feed-shared-update-v2__description",
          ".feed-shared-text",
          ".break-words",
          "[data-test-id='main-feed-activity-card__commentary']",
          "[data-view-name='feed-commentary']",
          "[dir='ltr']"
        ],
      };
    }

    return null;
  }

  function minTextForSite() {
    if (!SITE) return MIN_TEXT;
    if (SITE.key === "x") return 18;
    if (SITE.key === "reddit") return 30;
    return MIN_TEXT;
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\u200b/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function extractText(root) {
    if (!SITE) return "";

    const chunks = [];
    const seen = new Set();

    const push = (value) => {
      const text = cleanText(value);
      if (!text || seen.has(text)) return;
      seen.add(text);
      chunks.push(text);
    };

    if (SITE.key === "reddit") {
      push(root.getAttribute?.("post-title"));
      push(root.getAttribute?.("post-title-text"));
    }

    for (const selector of SITE.textSelectors) {
      for (const node of root.querySelectorAll(selector)) {
        if (node.closest?.(".slop-finder-overlay")) continue;
        push(node.innerText || node.textContent);
      }
    }

    let text = cleanText(chunks.join("\n\n"));

    // On X, tweetText is the actual authored text. Falling back to the whole
    // article adds username, timestamps, media duration and engagement counts,
    // which badly pollutes style classification.
    if (SITE.key === "x") {
      if (!text) return "";
      if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
      return text;
    }

    if (text.length < minTextForSite()) {
      const clone = root.cloneNode(true);
      clone.querySelectorAll(".slop-finder-overlay, button, [role='button']").forEach((node) => node.remove());
      text = cleanText(clone.innerText || clone.textContent);
    }

    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    return text;
  }

  function isNearViewport(el) {
    if (!(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 180 || rect.height < 30) return false;
    return rect.bottom > -innerHeight * 0.45 && rect.top < innerHeight * 1.65;
  }

  function chooseMarkerRoot(marker) {
    if (!(marker instanceof Element) || !SITE) return null;

    const direct = marker.closest?.(SITE.rootSelector);
    if (direct && direct !== document.body && direct !== document.documentElement) {
      const text = cleanText(direct.innerText || direct.textContent);
      if (text.length >= minTextForSite() && text.length <= 12000) return direct;
    }

    let node = marker instanceof HTMLElement ? marker.parentElement : null;
    let fallback = null;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      if (node === document.body || node === document.documentElement || node.tagName === "MAIN") break;
      const rect = node.getBoundingClientRect();
      const text = cleanText(node.innerText || node.textContent);
      if (rect.width >= 240 && rect.height >= 80 && rect.height <= 1800 && text.length >= minTextForSite() && text.length <= 9000) {
        fallback = node;
        if (node.tagName === "ARTICLE" || node.getAttribute("role") === "article") break;
      }
    }
    return fallback;
  }

  function candidateRoots() {
    if (!SITE) return [];
    const set = new Set();

    for (const selector of SITE.selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (el instanceof HTMLElement) set.add(el);
      }
    }

    for (const selector of SITE.markerSelectors || []) {
      for (const marker of document.querySelectorAll(selector)) {
        const root = chooseMarkerRoot(marker);
        if (root instanceof HTMLElement) set.add(root);
      }
    }

    if (set.size < 2 && SITE.key !== "x") {
      const actionWords = SITE.key === "linkedin"
        ? /^(like|comment|repost|send|react)$/i
        : /^(upvote|downvote|comment|comments|share|award)$/i;

      for (const marker of document.querySelectorAll("main button, main a")) {
        const label = cleanText(
          marker.getAttribute("aria-label") || marker.innerText || marker.textContent
        );
        if (!label || !actionWords.test(label.split(/\s+/).slice(0, 2).join(" ")) && !actionWords.test(label)) continue;
        const root = chooseMarkerRoot(marker);
        if (root instanceof HTMLElement) set.add(root);
        if (set.size >= 40) break;
      }
    }

    stats.candidateRoots = set.size;
    return [...set];
  }

  function stableRoots() {
    if (!SITE) return [];

    const roots = [];
    const dedupe = new Set();

    for (const el of candidateRoots()) {
      if (!(el instanceof HTMLElement) || !isNearViewport(el)) continue;

      const text = extractText(el);
      if (text.length < minTextForSite()) continue;
      const key = fastHash(text);
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      roots.push({ el, text, hash: key });
    }

    stats.foundRoots = roots.length;
    return roots.slice(0, 32);
  }

  function fastHash(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function ensureId(el) {
    let id = el.getAttribute(POST_ATTR);
    if (!id) {
      id = `laya-post-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
      el.setAttribute(POST_ATTR, id);
    }
    return id;
  }

  function enqueuePost(el, text, hash) {
    const previousHash = el.getAttribute(HASH_ATTR);
    const state = el.getAttribute(STATE_ATTR);

    if (previousHash === hash && ["queued", "analyzing", "done"].includes(state)) return;

    removeTape(el);
    el.setAttribute(HASH_ATTR, hash);
    el.setAttribute(STATE_ATTR, "queued");

    const id = ensureId(el);
    queue.push({
      id,
      text,
      tag: el.tagName.toLowerCase(),
      site: SITE.key,
      el,
      hash,
    });
    stats.queued = queue.length;
  }

  function scanPosts() {
    if (!SITE) return;

    stats.scanCycles += 1;
    stats.lastScanAt = Date.now();

    for (const { el, text, hash } of stableRoots()) {
      enqueuePost(el, text, hash);
    }

    stats.queued = queue.length;
    if (queue.length) drainQueue();
  }

  function scheduleScan(delay = 180) {
    if (!SITE) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanPosts, delay);
  }

  async function drainQueue() {
    if (processing || !queue.length || !SITE) return;
    if (Date.now() < helperOfflineUntil) {
      setTimeout(drainQueue, Math.max(300, helperOfflineUntil - Date.now()));
      return;
    }

    processing = true;
    const batch = queue.splice(0, BATCH_SIZE);
    stats.queued = queue.length;
    stats.analyzing = batch.length;
    stats.helperError = "";

    for (const item of batch) {
      item.el?.setAttribute(STATE_ATTR, "analyzing");
    }

    const started = performance.now();

    try {
      const response = await chrome.runtime.sendMessage({
        type: "LAYA_HELPER_ANALYZE",
        payload: {
          url: location.href,
          title: document.title,
          blocks: batch.map(({ id, text, tag, site }) => ({ id, text, tag, site }))
        }
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Local Laya helper did not respond.");
      }

      stats.lastLatencyMs = Math.round(performance.now() - started);
      const resultMap = new Map((response.data?.results || []).map((item) => [item.id, item]));

      for (const item of batch) {
        const result = resultMap.get(item.id);
        if (!result || result.error) {
          item.el?.setAttribute(STATE_ATTR, "error");
          continue;
        }

        stats.scanned += 1;
        item.el?.setAttribute(STATE_ATTR, "done");
        resultsById.set(item.id, result);

        if (Number(result.risk || 0) >= threshold) {
          markSlop(item.el, result);
          stats.flagged += 1;
          rememberFinding(result);
        } else {
          removeTape(item.el);
        }
      }
    } catch (error) {
      stats.helperError = String(error?.message || error);
      helperOfflineUntil = Date.now() + 5000;

      // Let these posts be retried after the helper comes back.
      for (const item of batch.reverse()) {
        if (item.el?.isConnected) {
          item.el.setAttribute(STATE_ATTR, "queued");
          queue.unshift(item);
        }
      }
    } finally {
      stats.analyzing = 0;
      stats.queued = queue.length;
      processing = false;

      if (queue.length) {
        setTimeout(drainQueue, stats.helperError ? 5000 : 90);
      }
    }
  }

  function rememberFinding(result) {
    const existing = recentFindings.findIndex((item) => item.id === result.id);
    if (existing >= 0) recentFindings.splice(existing, 1);

    recentFindings.unshift({
      id: result.id,
      risk: Number(result.risk || 0),
      text: String(result.text || "").slice(0, 360),
      signals: result.signals || {},
      primary_label: result.primary_label || "ai_slop",
    });

    if (recentFindings.length > 20) recentFindings.length = 20;
  }

  function markSlop(el, result) {
    if (!(el instanceof HTMLElement) || !el.isConnected) return;
    removeTape(el);

    if (getComputedStyle(el).position === "static") {
      el.dataset.slopFinderPositionPatched = "1";
      el.style.position = "relative";
    }

    el.classList.add("slop-finder-detected");

    const overlay = document.createElement("div");
    overlay.className = TAPE_CLASS;
    overlay.setAttribute("aria-hidden", "true");

    const confidence = Math.round(Number(result.risk || 0) * 100);
    const strongest = Object.entries(result.signals || {})
      .filter(([name]) => name !== "ai_slop")
      .sort((a, b) => b[1] - a[1])[0]?.[0] || "synthetic style";

    const friendly = {
      genericity: "GENERIC",
      templated_style: "TEMPLATED",
      synthetic_tone: "SYNTHETIC",
      engagement_bait: "ENGAGEMENT BAIT",
      low_information: "LOW INFO",
      formula_patterns: "FORMULAIC",
      repetition: "REPETITIVE",
      listicle: "LISTICLE",
      cta_bait: "ENGAGEMENT BAIT",
      buzzword_hype: "HYPE COPY",
      regular_cadence: "ROBOTIC CADENCE",
    }[strongest] || "AI SLOP";

    overlay.innerHTML = `
      <div class="slop-finder-dim"></div>
      <div class="slop-finder-tape slop-finder-tape-main">
        <span>AI SLOP&nbsp;&nbsp;·&nbsp;&nbsp;${confidence}%&nbsp;&nbsp;·&nbsp;&nbsp;${friendly}&nbsp;&nbsp;·&nbsp;&nbsp;AI SLOP&nbsp;&nbsp;·&nbsp;&nbsp;${confidence}%</span>
      </div>
      <div class="slop-finder-tape slop-finder-tape-accent">
        <span>SLOP FINDER&nbsp;&nbsp;·&nbsp;&nbsp;STYLE MATCH — NOT PROOF OF AUTHORSHIP</span>
      </div>
    `;

    el.appendChild(overlay);
  }

  function removeTape(el) {
    if (!(el instanceof HTMLElement)) return;
    el.querySelectorAll(`:scope > .${TAPE_CLASS}`).forEach((node) => node.remove());
    el.classList.remove("slop-finder-detected");
  }

  function refreshExistingMarks() {
    for (const [id, result] of resultsById.entries()) {
      const el = document.querySelector(`[${POST_ATTR}="${CSS.escape(id)}"]`);
      if (!el) continue;

      if (Number(result.risk || 0) >= threshold) {
        markSlop(el, result);
      } else {
        removeTape(el);
      }
    }
  }

  function clearVisuals() {
    document.querySelectorAll(`.${TAPE_CLASS}`).forEach((node) => node.remove());
    document.querySelectorAll(".slop-finder-detected").forEach((node) => node.classList.remove("slop-finder-detected"));
    recentFindings.length = 0;
    stats.flagged = 0;
  }

  function injectStyles() {
    if (document.getElementById("slop-finder-styles")) return;

    const style = document.createElement("style");
    style.id = "slop-finder-styles";
    style.textContent = `
      .slop-finder-overlay {
        position: absolute !important;
        inset: 0 !important;
        z-index: 2147483000 !important;
        overflow: hidden !important;
        pointer-events: none !important;
        border-radius: inherit !important;
        isolation: isolate !important;
        animation: slop-finder-overlay-in 110ms ease-out both;
      }

      .slop-finder-dim {
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at 50% 42%, rgba(255,255,255,.02), transparent 46%),
          rgba(10, 10, 8, .10);
        backdrop-filter: blur(.35px) saturate(.9);
        -webkit-backdrop-filter: blur(.35px) saturate(.9);
      }

      .slop-finder-tape {
        position: absolute;
        left: -8%;
        width: 116%;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        background:
          linear-gradient(180deg, rgba(255,255,255,.32), transparent 28%, rgba(150,105,0,.12) 82%),
          repeating-linear-gradient(102deg, #ffd51a 0 34px, #f5c400 34px 68px);
        color: #17130a;
        box-shadow:
          0 7px 20px rgba(0,0,0,.25),
          0 1px 0 rgba(255,255,255,.55) inset,
          0 -1px 0 rgba(122,85,0,.28) inset;
        transform-origin: 0 50%;
        will-change: transform, filter;
      }

      .slop-finder-tape::before {
        content: "";
        position: absolute;
        inset: 0;
        background:
          repeating-linear-gradient(90deg, transparent 0 8px, rgba(80,60,0,.045) 8px 9px),
          linear-gradient(100deg, transparent 15%, rgba(255,255,255,.42) 35%, transparent 52%);
        transform: translateX(-65%);
        animation: laya-tape-sheen 900ms 220ms ease-out 1;
      }

      .slop-finder-tape span {
        position: relative;
        z-index: 1;
        max-width: 94%;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: clip;
        font: 800 13px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        letter-spacing: .12em;
        text-shadow: 0 1px 0 rgba(255,255,255,.38);
      }

      .slop-finder-tape-main {
        top: 40%;
        height: 54px;
        transform: rotate(-2.25deg) scaleX(0);
        clip-path: polygon(.2% 10%, 2% 2%, 4% 8%, 7% 1%, 10% 7%, 14% 2%, 18% 8%, 22% 1%, 26% 7%, 31% 2%, 36% 8%, 42% 1%, 48% 7%, 54% 2%, 60% 8%, 66% 1%, 72% 7%, 78% 2%, 84% 8%, 90% 1%, 96% 7%, 99.8% 2%, 100% 90%, 97% 98%, 93% 92%, 88% 99%, 82% 93%, 76% 98%, 69% 92%, 62% 99%, 55% 93%, 48% 98%, 41% 92%, 34% 99%, 27% 93%, 20% 98%, 13% 92%, 7% 99%, .2% 93%);
        animation: laya-tape-unroll 260ms cubic-bezier(.2, .85, .25, 1) forwards;
      }

      .slop-finder-tape-accent {
        top: calc(40% + 58px);
        height: 28px;
        opacity: .94;
        transform: rotate(1.4deg) scaleX(0);
        animation: laya-tape-unroll-accent 190ms 55ms cubic-bezier(.2, .85, .25, 1) forwards;
      }

      .slop-finder-tape-accent span {
        font-size: 9px;
        letter-spacing: .09em;
        opacity: .78;
      }

      @keyframes laya-tape-unroll {
        0% { transform: rotate(-2.25deg) scaleX(0); filter: blur(.8px); }
        65% { transform: rotate(-2.25deg) scaleX(1.025); filter: blur(0); }
        100% { transform: rotate(-2.25deg) scaleX(1); filter: blur(0); }
      }

      @keyframes laya-tape-unroll-accent {
        0% { transform: rotate(1.4deg) scaleX(0); opacity: 0; }
        100% { transform: rotate(1.4deg) scaleX(1); opacity: .94; }
      }

      @keyframes slop-finder-overlay-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      @keyframes laya-tape-sheen {
        0%, 45% { transform: translateX(-65%); }
        70%, 100% { transform: translateX(70%); }
      }

      @media (prefers-reduced-motion: reduce) {
        .slop-finder-overlay,
        .slop-finder-tape,
        .slop-finder-tape::before {
          animation-duration: 1ms !important;
          animation-iteration-count: 1 !important;
        }
      }
    `;

    document.documentElement.appendChild(style);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "LAYA_PING") {
      sendResponse({ ok: true, site: stats.site, supported: stats.supported });
      return;
    }

    if (message?.type === "LAYA_STATUS") {
      sendResponse({
        ok: true,
        ...stats,
        threshold,
        recentFindings: [...recentFindings],
      });
      return;
    }

    if (message?.type === "LAYA_CONFIG") {
      if (Number.isFinite(message.threshold)) {
        threshold = Math.max(0.4, Math.min(0.98, Number(message.threshold)));
        refreshExistingMarks();
      }
      sendResponse({ ok: true, threshold });
      return;
    }

    if (message?.type === "LAYA_CLEAR") {
      clearVisuals();
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "LAYA_RESCAN") {
      scheduleScan(0);
      sendResponse({ ok: true });
      return;
    }
  });

  let observer = null;
  let heartbeatTimer = null;
  let started = false;

  const onScroll = () => scheduleScan(70);
  const onResize = () => scheduleScan(120);

  function resetStaleDomState() {
    document.querySelectorAll(`[${STATE_ATTR}], [data-slop-finder-state]`).forEach((el) => {
      el.removeAttribute(STATE_ATTR);
      el.removeAttribute(HASH_ATTR);
      el.removeAttribute("data-slop-finder-state");
      el.removeAttribute("data-slop-finder-hash");
    });
    document.querySelectorAll(`.${TAPE_CLASS}`).forEach((node) => node.remove());
    document.querySelectorAll(".slop-finder-detected").forEach((node) => {
      node.classList.remove("slop-finder-detected");
    });
  }

  function destroy() {
    clearTimeout(scanTimer);
    scanTimer = null;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    observer?.disconnect();
    observer = null;
    removeEventListener("scroll", onScroll);
    removeEventListener("resize", onResize);
    started = false;
  }

  function start() {
    if (started || !SITE) return;
    started = true;

    resetStaleDomState();

    observer = new MutationObserver(() => scheduleScan(90));
    observer.observe(document.body || document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onResize, { passive: true });

    // Feed implementations virtualize aggressively. A small periodic fallback
    // catches reused DOM nodes and SPA updates that do not trigger the exact
    // mutation pattern we expect.
    heartbeatTimer = setInterval(() => scheduleScan(0), 1400);
    scheduleScan(0);
  }

  globalThis.__slopFinderScanner = {
    version: SCANNER_VERSION,
    rescan: () => scheduleScan(0),
    destroy,
    status: () => ({ ...stats }),
  };

  if (!SITE) return;

  if (document.body) {
    start();
  } else {
    addEventListener("DOMContentLoaded", start, { once: true });
  }
})();
