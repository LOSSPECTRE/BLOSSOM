if (window.__bloscomLoaded) { /* already loaded */ } else {
window.__bloscomLoaded = true;

let overlayOpen = false;
let chatHistory = [];

// ── Sync BLOSSOM theme if we're on the BLOSSOM dashboard ────────
if (window.location.hostname === "localhost" || window.location.href.includes("127.0.0.1")) {
  const bg     = localStorage.getItem("bgType")     || "sakura";
  const accent = localStorage.getItem("accentColor") || "#f9a8d4";
  chrome.storage.local.set({ bloscomTheme: { bg, accent } });
}

// ── Resume pending steps after navigation ───────────────────────
chrome.storage.local.get("bloscomPendingSteps").then(({ bloscomPendingSteps }) => {
  if (!bloscomPendingSteps?.length) return;
  chrome.storage.local.remove("bloscomPendingSteps");
  const run = async () => {
    await new Promise(r => setTimeout(r, 2000));
    openOverlay();
    await new Promise(r => setTimeout(r, 500));
    await runStepsWithPermission(bloscomPendingSteps, []);
  };
  if (document.readyState === "complete") run();
  else window.addEventListener("load", run, { once: true });
});

// ── Listen for right-click trigger from background ──────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "OPEN_BLOSCOM") {
    if (overlayOpen) return;
    openOverlay(msg.selectedText);
  }
});

// ── DOM Scanner — finds all interactive elements with positions ──
function scanPageElements() {
  const selectors = [
    'button', 'a[href]', 'input', 'textarea', 'select',
    '[role="button"]', '[role="menuitem"]', '[role="tab"]',
    '[onclick]', '[contenteditable="true"]'
  ];
  const seen = new Set();
  const elements = [];
  let index = 0;

  const overlay = document.getElementById("bloscom-overlay");

  document.querySelectorAll(selectors.join(",")).forEach(el => {
    if (seen.has(el)) return;
    seen.add(el);

    // Skip anything inside our own overlay
    if (overlay && overlay.contains(el)) return;

    const rect = el.getBoundingClientRect();
    // Must be visible on screen
    if (rect.width < 4 || rect.height < 4) return;
    if (rect.top < 0 || rect.top > window.innerHeight) return;
    if (rect.left < 0 || rect.left > window.innerWidth) return;

    // Skip visually hidden elements
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || parseFloat(style.opacity) === 0) return;
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);

    const text = (
      el.innerText ||
      el.value ||
      el.placeholder ||
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("alt") ||
      ""
    ).trim().slice(0, 60);

    elements.push({
      index,
      tag: el.tagName.toLowerCase(),
      text,
      placeholder: el.placeholder || "",
      label: el.getAttribute("aria-label") || "",
      x: cx,
      y: cy,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      _el: el
    });
    index++;
  });

  return elements;
}

// ── Action Executor ─────────────────────────────────────────────
async function executeStep(step, elements) {
  const el = elements.find(e => e.index === step.index)?._el;

  if (step.type === "search_after_nav") {
    // Page just loaded — find the search box and type
    await sleep(1500);
    const box = document.querySelector('input[type="search"], input[name="search_query"], input[name="q"], textarea[name="q"], input[placeholder*="earch" i]');
    if (!box) throw new Error("No search box found on page");
    box.focus();
    box.value = "";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    for (const char of step.query) {
      box.value += char;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(30);
    }
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
    box.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", keyCode: 13, bubbles: true }));
    box.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", keyCode: 13, bubbles: true }));
    const form = box.closest("form");
    if (form) form.submit();

  } else if (step.type === "navigate") {
    window.location.href = step.url;
    await sleep(2000);

  } else if (step.type === "history") {
    if (step.direction === "back") window.history.back();
    else window.history.forward();
    await sleep(1000);

  } else if (step.type === "reload") {
    window.location.reload();
    await sleep(2000);

  } else if (step.type === "newtab") {
    window.open("about:blank", "_blank");

  } else if (step.type === "zoom") {
    const current = parseFloat(document.body.style.zoom || "1");
    document.body.style.zoom = step.direction === "in" ? current + 0.1 : Math.max(0.3, current - 0.1);

  } else if (step.type === "select") {
    if (!el) throw new Error(`Element ${step.index} not found`);
    el.focus();
    // Try matching by text or value
    const opt = Array.from(el.options).find(o =>
      o.text.toLowerCase().includes(step.value.toLowerCase()) ||
      o.value.toLowerCase().includes(step.value.toLowerCase())
    );
    if (opt) el.value = opt.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));

  } else if (step.type === "click_at") {
    const x = step.x, y = step.y;
    const target = document.elementFromPoint(x, y) || document.body;
    const evOpts = { bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: x, screenY: y };
    target.dispatchEvent(new MouseEvent("pointerdown", { ...evOpts, pointerId: 1 }));
    target.dispatchEvent(new MouseEvent("mousedown", evOpts));
    target.dispatchEvent(new MouseEvent("pointerup",  { ...evOpts, pointerId: 1 }));
    target.dispatchEvent(new MouseEvent("mouseup",  evOpts));
    target.dispatchEvent(new MouseEvent("click",    evOpts));

  } else if (step.type === "click") {
    if (!el) throw new Error(`Element ${step.index} not found`);
    const elInfo = elements.find(e => e.index === step.index);
    const cx = elInfo?.x ?? 0, cy = elInfo?.y ?? 0;
    const evOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, screenX: cx, screenY: cy };
    // Always use the stored DOM ref — elementFromPoint returns our overlay since it covers the page
    el.focus();
    el.dispatchEvent(new MouseEvent("pointerdown", { ...evOpts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", evOpts));
    el.dispatchEvent(new MouseEvent("pointerup",  { ...evOpts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent("mouseup",  evOpts));
    el.dispatchEvent(new MouseEvent("click",    evOpts));
    el.click();

  } else if (step.type === "type") {
    if (!el) throw new Error(`Element ${step.index} not found`);
    el.focus();
    // Clear existing value
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = "";
    }
    // Type char by char for natural feel
    for (const char of step.text) {
      el.dispatchEvent(new KeyboardEvent("keydown",  { key: char, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true }));
      if (el.isContentEditable) {
        el.textContent += char;
      } else {
        el.value += char;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
      await sleep(30);
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));

  } else if (step.type === "key") {
    // Use the element from previous step if available, otherwise active element
    const target = el || document.activeElement || document.body;
    const keyOpts = { key: step.key, code: step.key, keyCode: step.key === "Enter" ? 13 : 0, which: step.key === "Enter" ? 13 : 0, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent("keydown",  keyOpts));
    target.dispatchEvent(new KeyboardEvent("keypress", keyOpts));
    target.dispatchEvent(new KeyboardEvent("keyup",    keyOpts));
    if (step.key === "Enter") {
      const form = target.closest("form");
      if (form) form.submit();
    }

  } else if (step.type === "scroll") {
    const amount = step.direction === "down" ? step.amount : -step.amount;
    window.scrollBy({ top: amount, behavior: "smooth" });

  } else if (step.type === "wait") {
    await sleep(step.ms || 1000);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Highlight element on page ───────────────────────────────────
function highlightElement(index, elements) {
  removeHighlight();
  const el = elements.find(e => e.index === index)?._el;
  if (!el) return;
  el.style.outline = "2px solid #f9a8d4";
  el.style.outlineOffset = "2px";
  el.setAttribute("data-bloscom-highlight", "true");
}

function removeHighlight() {
  document.querySelectorAll("[data-bloscom-highlight]").forEach(el => {
    el.style.outline = "";
    el.style.outlineOffset = "";
    el.removeAttribute("data-bloscom-highlight");
  });
}

// ── Main Overlay ────────────────────────────────────────────────
function applyThemeToPanel(panel, theme) {
  if (!theme) return;
  const { bg, accent } = theme;
  const lightBgs = ["sakura", "petals"];
  const isLight = lightBgs.includes(bg);

  const overlay = document.getElementById("bloscom-overlay");

  if (isLight) {
    // Dark pinkish/mauve — matches BLOSSOM's sakura panel style
    panel.style.background = "rgba(180,120,150,0.92)";
    panel.style.borderColor = "rgba(255,255,255,0.2)";
    panel.style.boxShadow = `0 24px 80px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.15)`;
    const style = document.createElement("style");
    style.id = "bloscom-theme-overrides";
    style.textContent = `
      #bloscom-header { background: rgba(0,0,0,0.1) !important; border-color: rgba(255,255,255,0.12) !important; }
      #bloscom-title { color: #fff !important; }
      #bloscom-header-btns button { color: rgba(255,255,255,0.6) !important; }
      #bloscom-header-btns button:hover { color: #fff !important; background: rgba(255,255,255,0.12) !important; }
      #bloscom-screenshot-btn { border-color: rgba(255,255,255,0.35) !important; color: #fff !important; }
      .bloscom-ai { background: rgba(0,0,0,0.12) !important; border-color: rgba(255,255,255,0.1) !important; color: #fff !important; }
      .bloscom-user { background: rgba(255,255,255,0.2) !important; border-color: rgba(255,255,255,0.25) !important; color: #fff !important; }
      #bloscom-input { background: rgba(255,255,255,0.15) !important; border-color: rgba(255,255,255,0.25) !important; color: #fff !important; }
      #bloscom-input::placeholder { color: rgba(255,255,255,0.45) !important; }
      #bloscom-input-row { background: rgba(0,0,0,0.1) !important; border-color: rgba(255,255,255,0.1) !important; }
      #bloscom-send { background: rgba(255,255,255,0.85) !important; color: #5a1a35 !important; }
      #bloscom-send:hover { background: #fff !important; }
      .bloscom-perm-option { color: #fff !important; border-color: rgba(255,255,255,0.15) !important; background: rgba(0,0,0,0.1) !important; }
      .bloscom-perm-option.bloscom-focused { background: rgba(255,255,255,0.2) !important; border-color: rgba(255,255,255,0.5) !important; }
      .bloscom-perm-header { color: rgba(255,255,255,0.7) !important; }
      .bloscom-perm-action { color: #fff !important; }
      .bloscom-kbd-hint { color: rgba(255,255,255,0.35) !important; }
      #bloscom-context-bar { background: rgba(0,0,0,0.12) !important; border-color: rgba(255,255,255,0.12) !important; color: #fff !important; }
    `;
    document.head.appendChild(style);
  } else {
    // Dark theme — remove any light overrides
    document.getElementById("bloscom-theme-overrides")?.remove();
    panel.style.background = "#0d1117";
    panel.style.borderColor = accent + "40";
    panel.style.boxShadow = `0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px ${accent}15`;
  }

  // Always update accent color on send button
  const sendBtn = document.getElementById("bloscom-send");
  if (sendBtn) sendBtn.style.background = accent;
}

function openOverlay(prefill = "") {
  overlayOpen = true;
  chatHistory = [];

  const overlay = document.createElement("div");
  overlay.id = "bloscom-overlay";
  const LOGO_SVG = `<img src="${chrome.runtime.getURL('logo.png')}" />`;

  overlay.innerHTML = `
    <div id="bloscom-panel">
      <!-- Watermark logo -->
      <div id="bloscom-watermark">${LOGO_SVG}</div>

      <div id="bloscom-header">
        <div id="bloscom-title">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" opacity="0.7"><rect x="2" y="4" width="16" height="2" rx="1"/><rect x="2" y="9" width="16" height="2" rx="1"/><rect x="2" y="14" width="16" height="2" rx="1"/></svg>
          BLOSCOM-AI
        </div>
        <div id="bloscom-header-btns">
          <button id="bloscom-screenshot-btn" title="Scan page">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
            Scan
          </button>
          <button id="bloscom-close" title="Close">✕</button>
        </div>
      </div>

      <div id="bloscom-context-bar" style="display:none">
        <span>📸 Page scanned — AI can see your screen</span>
        <button id="bloscom-remove-screenshot">✕</button>
      </div>

      <div id="bloscom-messages">
        <div class="bloscom-msg bloscom-ai">
          Hey! I can see you're on <strong>${window.location.hostname}</strong>.<br>
          Tell me what you want to do and I'll do it for you step by step.
        </div>
      </div>

      <div id="bloscom-input-row">
        <textarea id="bloscom-input" placeholder="e.g. Add a pink title that says Hello..." rows="2">${prefill}</textarea>
        <button id="bloscom-send">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Apply saved BLOSSOM theme
  chrome.storage.local.get("bloscomTheme").then(({ bloscomTheme }) => {
    applyThemeToPanel(document.getElementById("bloscom-panel"), bloscomTheme);
  });
  makeDraggable(document.getElementById("bloscom-panel"), document.getElementById("bloscom-header"));

  document.getElementById("bloscom-close").addEventListener("click", closeOverlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeOverlay(); });

  // Screenshot
  let screenshotData = null;
  document.getElementById("bloscom-screenshot-btn").addEventListener("click", async () => {
    const bar = document.getElementById("bloscom-context-bar");
    document.getElementById("bloscom-screenshot-btn").textContent = "Scanning...";
    screenshotData = await captureScreenshot();
    document.getElementById("bloscom-screenshot-btn").textContent = "Scan page";
    if (screenshotData) bar.style.display = "flex";
  });
  document.getElementById("bloscom-remove-screenshot").addEventListener("click", () => {
    screenshotData = null;
    document.getElementById("bloscom-context-bar").style.display = "none";
  });

  // Send
  const sendBtn = document.getElementById("bloscom-send");
  const input   = document.getElementById("bloscom-input");

  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;

    appendMessage("you", text);
    input.value = "";
    sendBtn.disabled = true;

    // Scan DOM elements
    const elements = scanPageElements();
    const thinking = appendMessage("ai", "Scanning page and planning steps...", true);

    try {
      // Fetch directly — content scripts aren't killed like service workers
      const res = await fetch("http://localhost:3000/api/agent/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction: text,
          screenshot: screenshotData,
          elements: elements.map(({ _el, ...rest }) => rest),
          url: window.location.href,
          title: document.title
        })
      });

      thinking.remove();

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        appendMessage("ai", err.error || "Server error — check that BLOSCOM is running.");
        sendBtn.disabled = false;
        return;
      }

      const response = await res.json();

      if (!response.steps?.length) {
        appendMessage("ai", "Couldn't figure out steps for that. Try describing it differently.");
        sendBtn.disabled = false;
        return;
      }

      await runStepsWithPermission(response.steps, elements);

    } catch (err) {
      thinking.remove();
      appendMessage("ai", `Error: ${err.message}. Make sure BLOSCOM server is running.`);
    }

    screenshotData = null;
    document.getElementById("bloscom-context-bar").style.display = "none";
    sendBtn.disabled = false;
  }

  sendBtn.addEventListener("click", sendMessage);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  setTimeout(() => input.focus(), 100);
}

// ── Step-by-step permission runner ──────────────────────────────
async function runStepsWithPermission(steps, elements) {
  const msgs = document.getElementById("bloscom-messages");

  // Show plan summary
  const planDiv = document.createElement("div");
  planDiv.className = "bloscom-msg bloscom-ai";
  planDiv.innerHTML = `Here's my plan:<br><br>${steps.map((s, i) =>
    `<span class="bloscom-step-preview">${i + 1}. ${s.description}</span>`
  ).join("<br>")}`;
  msgs.appendChild(planDiv);
  msgs.scrollTop = msgs.scrollHeight;

  // Execute each step with permission
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Highlight element or show coordinate target
    if (step.type === "click_at") {
      removeHighlight();
    } else if (step.index !== undefined) {
      highlightElement(step.index, elements);
    }

    // Show permission card
    const allowed = await showPermissionCard(step, i + 1, steps.length, msgs);

    removeHighlight();

    if (allowed === "cancel") {
      appendMessage("ai", "Cancelled. Let me know if you want to try something else.");
      return;
    }

    if (allowed === "skip") continue;

    // If this step navigates away, save remaining steps first and wait
    if (step.type === "navigate" && i < steps.length - 1) {
      const remaining = steps.slice(i + 1);
      await chrome.storage.local.set({ bloscomPendingSteps: remaining });
    }

    // Execute
    const doingMsg = appendMessage("ai", `Doing: ${step.description}...`, true);
    try {
      await executeStep(step, elements);
      await sleep(600);
      doingMsg.remove();
      appendMessage("ai", `✓ ${step.description}`);
    } catch (err) {
      doingMsg.remove();
      appendMessage("ai", `⚠ Couldn't do: ${step.description}. Skipping.`);
    }
  }

  appendMessage("ai", "All done! Let me know if you need anything else.");
}

// ── Permission card UI ──────────────────────────────────────────
function showPermissionCard(step, current, total, container) {
  return new Promise(resolve => {
    const card = document.createElement("div");
    card.className = "bloscom-msg bloscom-ai bloscom-permission-card";

    const typeIcon = { click: "🖱", type: "⌨️", scroll: "↕️", wait: "⏳", navigate: "🌐", search_after_nav: "🔍" }[step.type] || "▶";
    const typeLabel = step.type === "type"
      ? `Type <span class="bloscom-type-preview">"${step.text}"</span>`
      : step.description;

    card.innerHTML = `
      <div class="bloscom-perm-header">Step ${current} of ${total}</div>
      <div class="bloscom-perm-action">${typeIcon} ${typeLabel}</div>
      <div class="bloscom-perm-options">
        <button class="bloscom-perm-option bloscom-opt-allow bloscom-focused">
          <span class="bloscom-perm-key">↵</span> Allow
        </button>
        <button class="bloscom-perm-option bloscom-opt-skip">
          <span class="bloscom-perm-key">S</span> Skip
        </button>
        <button class="bloscom-perm-option bloscom-opt-cancel">
          <span class="bloscom-perm-key">Esc</span> Cancel all
        </button>
      </div>
      <div class="bloscom-kbd-hint">↑ ↓ to move · Enter to select</div>
    `;
    container.appendChild(card);
    container.scrollTop = container.scrollHeight;

    const options = Array.from(card.querySelectorAll(".bloscom-perm-option"));
    let focusedIndex = 0;

    const setFocus = (i) => {
      options.forEach(o => o.classList.remove("bloscom-focused"));
      focusedIndex = (i + options.length) % options.length;
      options[focusedIndex].classList.add("bloscom-focused");
    };

    const choose = (result, label, color) => {
      card.querySelector(".bloscom-perm-options").remove();
      card.querySelector(".bloscom-kbd-hint")?.remove();
      card.querySelector(".bloscom-perm-action").innerHTML +=
        ` <span style="color:${color}">${label}</span>`;
      document.removeEventListener("keydown", onKey, true);
      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === "ArrowDown")  { e.preventDefault(); setFocus(focusedIndex + 1); }
      if (e.key === "ArrowUp")    { e.preventDefault(); setFocus(focusedIndex - 1); }
      if (e.key === "Enter")      { e.preventDefault(); options[focusedIndex].click(); }
      if (e.key === "Escape")     { e.preventDefault(); choose("cancel", "✕ Cancelled", "rgba(255,100,100,0.8)"); }
      if (e.key.toLowerCase() === "s") { e.preventDefault(); choose("skip", "— Skipped", "rgba(255,255,255,0.4)"); }
    };
    document.addEventListener("keydown", onKey, true);

    options[0].addEventListener("click", () => choose("allow",  "✓ Allowed",   "#86efac"));
    options[1].addEventListener("click", () => choose("skip",   "— Skipped",   "rgba(255,255,255,0.4)"));
    options[2].addEventListener("click", () => choose("cancel", "✕ Cancelled", "rgba(255,100,100,0.8)"));
  });
}

// ── Helpers ─────────────────────────────────────────────────────
function appendMessage(sender, text, isThinking = false) {
  const msgs = document.getElementById("bloscom-messages");
  if (!msgs) return null;
  const div = document.createElement("div");
  div.className = `bloscom-msg bloscom-${sender === "you" ? "user" : "ai"}`;
  if (isThinking) div.classList.add("bloscom-thinking");
  div.innerHTML = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

async function captureScreenshot() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "CAPTURE_TAB" });
    return response?.dataUrl || null;
  } catch { return null; }
}

function closeOverlay() {
  removeHighlight();
  document.getElementById("bloscom-overlay")?.remove();
  overlayOpen = false;
  chatHistory = [];
}

function makeDraggable(panel, handle) {
  let dragging = false, ox = 0, oy = 0;
  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    ox = e.clientX - panel.offsetLeft;
    oy = e.clientY - panel.offsetTop;
    panel.style.transition = "none";
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    panel.style.left   = (e.clientX - ox) + "px";
    panel.style.top    = (e.clientY - oy) + "px";
    panel.style.right  = "auto";
    panel.style.bottom = "auto";
  });
  document.addEventListener("mouseup", () => {
    dragging = false;
    panel.style.transition = "";
  });
}
} // end bloscom guard
