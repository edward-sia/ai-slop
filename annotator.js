// The one node the extension adds to a page: a fixed-position host with a shadow
// root holding the "Label" pill and the annotation popover. Being fixed, it sits
// outside the page's layout, so showing or hiding it never moves anything.
//
// content.js decides which paragraphs are judged and when to show the pill. This
// file only draws, positions and collects the form. It exposes one global,
// SlopAnnotator, because content scripts cannot import modules.

(() => {
  const TAG = "ai-slop-annotator";
  const POPOVER_WIDTH = 320;
  const GAP = 6;
  const EDGE = 8;
  const HINT = "Enter saves, Esc cancels";

  const STYLE = `
    :host { all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none; }
    * { box-sizing: border-box; }
    .pill, .popover {
      position: fixed; pointer-events: auto;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #1f1f1f; background: #fff; border: 1px solid #c9c9c9; border-radius: 8px;
    }
    .pill { padding: 3px 10px; border-radius: 999px; cursor: pointer; font-size: 12px; user-select: none; }
    .pill:hover { border-color: #888; }
    .popover { width: ${POPOVER_WIDTH}px; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; outline: none; }
    .excerpt, .model, .hint { color: #666; font-size: 12px; }
    .excerpt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .model b { color: #b26b00; font-weight: 500; }
    .seg { display: inline-flex; border: 1px solid #888; border-radius: 8px; overflow: hidden; align-self: flex-start; }
    .seg button { all: unset; box-sizing: border-box; padding: 6px 14px; cursor: pointer; font: inherit; color: inherit; }
    .seg button + button { border-left: 1px solid #888; }
    .seg button[aria-pressed="true"] { background: #e6f1fb; color: #0c447c; }
    input { all: unset; box-sizing: border-box; display: block; width: 100%; font: inherit; color: inherit; border: 1px solid #c9c9c9; border-radius: 8px; padding: 7px 10px; }
    input:focus { border-color: #378add; }
    .row { display: flex; align-items: center; gap: 8px; }
    .hint { flex: 1; font-size: 11px; }
    .btn { all: unset; box-sizing: border-box; font: inherit; cursor: pointer; border: 1px solid #c9c9c9; border-radius: 8px; padding: 6px 12px; }
    .btn:hover { border-color: #888; }
    .btn.save { background: #378add; border-color: #378add; color: #fff; }
    .btn.save:hover { background: #185fa5; border-color: #185fa5; }
    .saved { color: #1d9e75; font-size: 12px; }
    [hidden] { display: none !important; }
    @media (prefers-color-scheme: dark) {
      .pill, .popover { color: #eee; background: #1e1e1e; border-color: #555; }
      .excerpt, .model, .hint { color: #aaa; }
      .model b { color: #ffc046; }
      .seg button[aria-pressed="true"] { background: #0c447c; color: #e6f1fb; }
      input, .btn { border-color: #555; }
      .btn:hover { border-color: #888; }
      .btn.save { background: #378add; border-color: #378add; color: #fff; }
      .btn.save:hover { background: #85b7eb; border-color: #85b7eb; color: #042c53; }
    }
  `;

  let host = null;
  let pill = null;
  let popover = null;
  let anchor = null;        // the paragraph the pill or popover belongs to
  let pillClick = null;     // content.js's handler for a click on the pill
  let saveHandler = null;
  let cancelHandler = null;
  let pillHovered = false;
  let choice = null;

  function ensureHost() {
    if (host) return;
    host = document.createElement(TAG);
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    root.append(style);

    pill = document.createElement("div");
    pill.className = "pill";
    pill.textContent = "Label";
    pill.hidden = true;
    pill.addEventListener("mouseenter", () => { pillHovered = true; });
    pill.addEventListener("mouseleave", event => {
      pillHovered = false;
      // Going back into the paragraph keeps the pill; content.js hides it when
      // the pointer leaves the paragraph itself.
      if (!isOpen() && !(anchor && anchor.contains(event.relatedTarget))) hidePill();
    });
    pill.addEventListener("click", event => {
      event.stopPropagation();
      if (pillClick && anchor) pillClick(anchor);
    });
    root.append(pill);

    popover = document.createElement("div");
    popover.className = "popover";
    popover.tabIndex = -1;
    popover.hidden = true;
    popover.innerHTML = `
      <div class="excerpt"></div>
      <div class="model"></div>
      <div class="seg" role="group" aria-label="Label">
        <button type="button" data-label="SLOP" aria-pressed="false"><u>S</u>lop</button>
        <button type="button" data-label="HUMAN" aria-pressed="false"><u>R</u>eal</button>
      </div>
      <input type="text" placeholder="Why? One sentence" aria-label="Explanation">
      <div class="row">
        <span class="hint">${HINT}</span>
        <button type="button" class="btn cancel">Cancel</button>
        <button type="button" class="btn save">Save</button>
      </div>
      <div class="saved" hidden>Saved</div>
    `;
    // Keys typed into the popover belong to it. Stopping them here keeps the
    // page's own shortcuts and content.js's Escape handler from also firing.
    for (const type of ["keydown", "keyup", "keypress"]) popover.addEventListener(type, e => e.stopPropagation());
    popover.addEventListener("keydown", onKey);
    popover.addEventListener("click", event => {
      event.stopPropagation();
      const seg = event.target.closest("[data-label]");
      if (seg) { pick(seg.dataset.label); return; }
      if (event.target.closest(".cancel")) cancel();
      else if (event.target.closest(".save")) save();
    });
    root.append(popover);

    document.documentElement.append(host);
    window.addEventListener("scroll", onViewportChange, { capture: true, passive: true });
    window.addEventListener("resize", onViewportChange, { passive: true });
    // Events from inside the shadow root reach the document retargeted to the
    // host, so anything else is a click outside.
    document.addEventListener("mousedown", event => {
      if (isOpen() && event.target !== host) cancel();
    }, true);
  }

  const place = (el, left, top) => {
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  };

  function placePill() {
    const r = anchor.getBoundingClientRect();
    const w = pill.offsetWidth;
    const h = pill.offsetHeight;
    place(pill, Math.min(Math.max(EDGE, r.right - w), window.innerWidth - w - EDGE), Math.max(EDGE, r.top - h / 2));
    return r;
  }

  function position() {
    if (!anchor || !isOpen()) return;
    const r = placePill();
    if (r.bottom < 0 || r.top > window.innerHeight) { cancel(); return; }
    const pw = popover.offsetWidth;
    const ph = popover.offsetHeight;
    const pillRect = pill.getBoundingClientRect();
    const left = Math.min(Math.max(EDGE, r.right - pw), window.innerWidth - pw - EDGE);
    let top = pillRect.bottom + GAP;
    if (top + ph > window.innerHeight - EDGE) top = pillRect.top - ph - GAP;
    place(popover, left, Math.max(EDGE, top));
  }

  function onViewportChange() {
    if (isOpen()) position();
    else if (pill && !pill.hidden) { pillHovered = false; pill.hidden = true; }
  }

  function isOpen() {
    return Boolean(popover) && !popover.hidden;
  }

  function isShowing(element) {
    return Boolean(pill) && !pill.hidden && anchor === element;
  }

  function showPill(element, onClick) {
    ensureHost();
    if (isOpen()) return;
    anchor = element;
    pillClick = onClick;
    pill.hidden = false;
    placePill();
  }

  function hidePill() {
    if (!pill || pillHovered || isOpen()) return;
    pill.hidden = true;
  }

  function open({ element, excerpt, model, onSave, onCancel }) {
    ensureHost();
    anchor = element;
    saveHandler = onSave;
    cancelHandler = onCancel ?? null;
    choice = null;
    for (const b of popover.querySelectorAll("[data-label]")) b.setAttribute("aria-pressed", "false");
    popover.querySelector(".excerpt").textContent = excerpt;
    const m = popover.querySelector(".model");
    m.textContent = "Model said ";
    const strong = document.createElement("b");
    strong.textContent = model.verdict === "SLOP" ? "Slop" : "Real";
    m.append(strong, `, ${model.confidence}`);
    popover.querySelector("input").value = "";
    popover.querySelector(".hint").textContent = HINT;
    popover.querySelector(".saved").hidden = true;
    pill.hidden = false;
    popover.hidden = false;
    position();
    popover.focus();
  }

  function pick(label) {
    choice = label;
    for (const b of popover.querySelectorAll("[data-label]")) {
      b.setAttribute("aria-pressed", String(b.dataset.label === label));
    }
    popover.querySelector("input").focus();
  }

  function save() {
    const hint = popover.querySelector(".hint");
    if (!choice) { hint.textContent = "Pick Slop or Real first"; return; }
    const explanation = popover.querySelector("input").value.trim();
    Promise.resolve(saveHandler(choice, explanation)).then(
      () => {
        popover.querySelector(".saved").hidden = false;
        setTimeout(close, 1000);
      },
      () => { hint.textContent = "Could not save"; }
    );
  }

  function cancel() {
    const handler = cancelHandler;
    close();
    if (handler) handler();
  }

  function close() {
    if (!popover) return;
    popover.hidden = true;
    pill.hidden = true;
    pillHovered = false;
    anchor = null;
    saveHandler = null;
    cancelHandler = null;
    choice = null;
  }

  function onKey(event) {
    if (event.key === "Escape") { cancel(); return; }
    if (event.key === "Enter") { event.preventDefault(); save(); return; }
    if (event.target.tagName === "INPUT") return;
    // pick() moves focus into the text field, and without preventDefault the
    // same keystroke would then type its letter there.
    if (event.key === "s" || event.key === "S") { event.preventDefault(); pick("SLOP"); }
    if (event.key === "r" || event.key === "R") { event.preventDefault(); pick("HUMAN"); }
  }

  window.SlopAnnotator = { showPill, hidePill, isShowing, open, close, isOpen, isHost: node => node === host };
})();
