// Scans page text and asks the background worker to judge each paragraph.
//
// The rule this file follows: never write to element.style, and never write a
// property the page might own. Flagging adds one class, dismissing removes it,
// and the page goes back to exactly how it was. All visuals live in slop.css.

const FLAG_CLASS = "ai-slop-flagged";
const MIN_LENGTH = 60;      // shorter than this is usually menu or date text
const MAX_LENGTH = 4000;    // keep the request inside the model's context window
const MAX_IN_FLIGHT = 3;    // Ollama is single-GPU; flooding it just adds latency

// Tracking which elements we have already judged used to be written into the DOM
// as data-slop-evaluated. A WeakSet keeps it out of the page entirely and lets
// the entries be collected when the nodes are removed.
const evaluated = new WeakSet();
// The page may have given the paragraph its own tooltip. Keep it so dismissing
// can hand it back rather than deleting it.
const borrowedTitle = new WeakMap();
// What the model said about each paragraph, kept so a label can be recorded
// alongside the verdict it disagrees or agrees with. Only paragraphs with an
// entry here get the Label pill.
const judged = new WeakMap();
const HOVER_DELAY_MS = 250;

const queue = [];
let inFlight = 0;

function pump() {
  while (inFlight < MAX_IN_FLIGHT && queue.length > 0) {
    const job = queue.shift();
    inFlight++;
    job().finally(() => {
      inFlight--;
      pump();
    });
  }
}

function ask(text) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: "checkSlop", text }, response => {
      if (chrome.runtime.lastError) {
        console.warn("[slop] communication error:", chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
}

function flag(element, reason) {
  if (element.classList.contains(FLAG_CLASS)) return;
  if (element.hasAttribute("title")) {
    borrowedTitle.set(element, element.getAttribute("title"));
  }
  element.setAttribute("title", reason);
  element.classList.add(FLAG_CLASS);
}

function unflag(element) {
  element.classList.remove(FLAG_CLASS);
  // classList.remove leaves an empty class attribute behind if it was the only
  // class, so take the attribute away as well rather than leaving class="".
  if (element.classList.length === 0) element.removeAttribute("class");

  if (borrowedTitle.has(element)) {
    element.setAttribute("title", borrowedTitle.get(element));
    borrowedTitle.delete(element);
  } else {
    element.removeAttribute("title");
  }
}

// Skip anything the user is editing or that is not prose, and anything already
// hidden, so we neither waste model calls nor decorate invisible nodes.
function shouldSkip(element) {
  if (element.closest("[contenteditable], textarea, code, pre, script, style, svg")) return true;
  if (element.offsetParent === null && getComputedStyle(element).position !== "fixed") return true;
  return false;
}

function scanPageForSlop() {
  for (const element of document.querySelectorAll("p")) {
    if (evaluated.has(element)) continue;
    evaluated.add(element);

    if (shouldSkip(element)) continue;

    const cleanText = element.innerText?.trim();
    if (!cleanText || cleanText.length < MIN_LENGTH) continue;

    const text = cleanText.slice(0, MAX_LENGTH);
    queue.push(async () => {
      const response = await ask(text);
      if (!response || response.error) return;
      if (!element.isConnected) return;
      judged.set(element, {
        text,
        verdict: response.verdict,
        confidence: response.confidence,
        flagged: Boolean(response.isSlop),
        model: response.model,
        prompt_sha256: response.prompt_sha256
      });
      if (!response.isSlop) return;
      flag(element, response.reason ?? "Flagged as AI slop by the local model. Click to dismiss.");
    });
  }
  pump();
}

// Records. The worker adds text_sha256, because crypto.subtle is missing on
// plain http pages and the worker always has it.
function recordId(kind) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return `${kind === "annotation" ? "ann" : "dis"}_${stamp}_${Math.random().toString(36).slice(2, 6)}`;
}

function buildRecord(kind, info, label, explanation) {
  return {
    id: recordId(kind),
    kind,
    label_quality: label,
    explanation,
    text: info.text,
    model: {
      name: info.model,
      verdict: info.verdict,
      confidence: info.confidence,
      flagged: info.flagged,
      prompt_sha256: info.prompt_sha256
    },
    page: { url: location.href, title: document.title },
    created_at: new Date().toISOString()
  };
}

function saveRecord(record) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: "saveRecord", record }, response => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error ?? "save failed"));
      resolve();
    });
  });
}

function openAnnotation(paragraph) {
  const info = judged.get(paragraph);
  if (!info) return;
  SlopAnnotator.open({
    element: paragraph,
    excerpt: info.text.slice(0, 90),
    model: { verdict: info.verdict, confidence: info.confidence },
    onSave: async (label, explanation) => {
      await saveRecord(buildRecord("annotation", info, label, explanation));
      // The reader called a flagged paragraph Real. Their word beats the model's,
      // and the annotation already says so, so no dismissal record is written.
      if (label === "HUMAN" && paragraph.classList.contains(FLAG_CLASS)) unflag(paragraph);
    }
  });
}

// Hover a judged paragraph for a moment and the Label pill appears at its top
// right corner. Both listeners are delegated and neither stops propagation.
let hoverTimer = null;
document.addEventListener("mouseover", event => {
  const paragraph = event.target.closest?.("p");
  if (!paragraph || !judged.has(paragraph)) return;
  if (SlopAnnotator.isOpen() || SlopAnnotator.isShowing(paragraph)) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => SlopAnnotator.showPill(paragraph, openAnnotation), HOVER_DELAY_MS);
});

document.addEventListener("mouseout", event => {
  const paragraph = event.target.closest?.("p");
  if (!paragraph || !judged.has(paragraph)) return;
  // Moving within the paragraph, or onto the pill itself, is not leaving.
  if (paragraph.contains(event.relatedTarget) || SlopAnnotator.isHost(event.relatedTarget)) return;
  clearTimeout(hoverTimer);
  SlopAnnotator.hidePill();
});

// One delegated listener rather than one per paragraph. It never calls
// preventDefault or stopPropagation, so the page's own click handling is
// untouched whether or not a paragraph is flagged.
document.addEventListener("click", event => {
  const element = event.target.closest?.(`.${FLAG_CLASS}`);
  if (!element) return;

  // A flagged paragraph can contain links and buttons the user meant to hit.
  if (event.target.closest('a, button, input, select, textarea, label, [role="button"]')) return;

  // Selecting text ends in a click. Do not treat that as a dismissal.
  if (String(window.getSelection?.() ?? "").length > 0) return;

  unflag(element);

  // A dismissal is a weak signal that the flag was wrong. Record it; triage
  // decides what it means.
  const info = judged.get(element);
  if (info) {
    saveRecord(buildRecord("dismissal", info, null, "")).catch(error => {
      console.warn("[slop] dismissal not saved:", error.message);
    });
  }
});

// Escape clears every flag on the page at once.
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  // The popover owns Escape while it is open. Its own handler also stops the
  // event, so this is a second guard rather than the only one.
  if (SlopAnnotator.isOpen()) return;
  document.querySelectorAll(`.${FLAG_CLASS}`).forEach(unflag);
});

if (document.readyState === "complete") {
  scanPageForSlop();
} else {
  window.addEventListener("load", scanPageForSlop);
}

// Catch text added by infinite scroll. The WeakSet check above makes a repeat
// scan cheap, because innerText is only read for paragraphs never seen before.
setInterval(scanPageForSlop, 4000);
