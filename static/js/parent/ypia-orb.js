// Reusable Y.P.I.A conversational orb.
//
// Presentational only: it renders the orb, shows one of six states, and
// reports presses. It knows nothing about ElevenLabs or any page, so the voice
// layer (or a future animated/WebGL orb) drives it through this small API:
//
//   const orb = createYpiaOrb({ onPress, decorative: true, onChange });
//   container.append(orb.element);
//   orb.setState("listening");  // idle | connecting | listening | thinking | speaking | error
//   orb.setLevel(0.4);          // optional audio level 0..1 (ignored with reduced motion)
//
// Styling lives in /static/ypia-orb.css. Size it from outside with the
// --orb-size custom property.

export const ORB_STATES = ["idle", "connecting", "listening", "thinking", "speaking", "error"];

const DEFAULT_LABELS = {
  idle: "Start talking to Y.P.I.A",
  connecting: "Connecting to Y.P.I.A",
  listening: "Y.P.I.A is listening. Press to end the conversation",
  thinking: "Y.P.I.A is thinking. Press to end the conversation",
  speaking: "Y.P.I.A is speaking. Press to end the conversation",
  error: "Something went wrong. Press to try again",
};

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(markup, className) {
  const wrap = document.createElementNS(SVG_NS, "svg");
  wrap.setAttribute("class", className);
  wrap.setAttribute("aria-hidden", "true");
  wrap.setAttribute("focusable", "false");
  wrap.innerHTML = markup; // static markup defined in this file only
  return wrap;
}

function span(className) {
  const node = document.createElement("span");
  node.className = className;
  node.setAttribute("aria-hidden", "true");
  return node;
}

const LEAF = `
  <path d="M0 50 C2 26 24 10 46 16 C52 32 38 47 0 50Z" fill="url(#lg)" opacity=".8"/>
  <path d="M100 50 C99 28 80 8 56 6 C48 24 62 45 100 50Z" fill="url(#lg)" opacity=".9"/>
  <path d="M30 50 C40 36 50 26 54 12" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="1"/>
  <defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#c3e2b2"/><stop offset="1" stop-color="#4a9a55"/></linearGradient></defs>`;

const FACE = `
  <g class="face-happy" fill="none" stroke-linecap="round" stroke-width="3">
    <path d="M20 24 Q29 14 38 24"/><path d="M62 24 Q71 14 80 24"/>
    <path d="M38 40 Q50 52 62 40"/>
  </g>
  <g class="face-sad" fill="none" stroke-linecap="round" stroke-width="3">
    <path d="M20 22 Q29 30 38 22"/><path d="M62 22 Q71 30 80 22"/>
    <path d="M40 48 Q50 40 60 48"/>
  </g>`;

const SIDE_ARCS = `
  <path d="M22 10 Q8 40 22 70" fill="none" stroke-linecap="round"/>
  <path d="M12 2 Q-8 40 12 78" fill="none" stroke-linecap="round" opacity=".6"/>`;

const WING = `<path d="M0 30 C16 30 22 8 40 16 C34 24 34 36 40 44 C22 52 16 30 0 30Z"/>`;

// decorative: the orb is a visual only (aria-hidden, not a tab stop). A real, labelled
// control elsewhere on the page exposes the same action. Clicking the orb still calls onPress.
// onChange({ state, disabled }) fires whenever the state or busy flag changes.
export function createYpiaOrb({ onPress, onChange, decorative = false } = {}) {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const element = document.createElement("button");
  element.type = "button";
  element.className = "ypia-orb";
  if (decorative) {
    element.tabIndex = -1;
    element.setAttribute("aria-hidden", "true");
  }

  const aura = span("ypia-orb__aura");
  const arcsLeft = svg(SIDE_ARCS, "ypia-orb__arcs ypia-orb__arcs--left");
  const arcsRight = svg(SIDE_ARCS, "ypia-orb__arcs ypia-orb__arcs--right");
  const wingLeft = svg(WING, "ypia-orb__wing ypia-orb__wing--left");
  const wingRight = svg(WING, "ypia-orb__wing ypia-orb__wing--right");
  for (const node of [arcsLeft, arcsRight, wingLeft, wingRight]) node.setAttribute("viewBox", node.classList.contains("ypia-orb__wing") ? "0 0 40 60" : "0 0 24 80");

  const spinner = svg(
    `<circle cx="50" cy="50" r="48" fill="none" stroke-width="3" stroke-linecap="round" pathLength="100" stroke-dasharray="22 78"/>`,
    "ypia-orb__spinner"
  );
  spinner.setAttribute("viewBox", "0 0 100 100");

  const sphere = span("ypia-orb__sphere");
  const leaf = svg(LEAF, "ypia-orb__leaf");
  leaf.setAttribute("viewBox", "0 0 100 50");
  leaf.setAttribute("preserveAspectRatio", "none");
  const face = svg(FACE, "ypia-orb__face");
  face.setAttribute("viewBox", "0 0 100 60");
  sphere.append(leaf, span("ypia-orb__shine"), face);

  const bubbles = span("ypia-orb__bubbles");
  bubbles.append(span("b b1"), span("b b2"), span("b b3"));
  const badge = span("ypia-orb__badge");
  badge.textContent = "!";

  element.append(aura, arcsLeft, arcsRight, wingLeft, wingRight, spinner, sphere, bubbles, badge);

  let state = "idle";

  function setState(next, { label } = {}) {
    if (next === "processing") next = "thinking"; // accept the older name
    if (!ORB_STATES.includes(next)) return;
    state = next;
    element.dataset.state = next;
    if (!decorative) element.setAttribute("aria-label", label || DEFAULT_LABELS[next]);
    element.disabled = next === "connecting";
    if (next === "idle" || next === "error") element.style.removeProperty("--orb-level");
    notify();
  }

  function setLevel(level) {
    if (reducedMotion.matches) return;
    const clamped = Math.max(0, Math.min(1, Number(level) || 0));
    element.style.setProperty("--orb-level", clamped.toFixed(3));
  }

  function setBusy(busy) {
    element.disabled = busy;
    notify();
  }

  function notify() {
    if (onChange) onChange({ state, disabled: element.disabled });
  }

  element.addEventListener("click", () => {
    if (onPress) onPress(state);
  });

  setState("idle");

  return { element, setState, setLevel, setBusy, getState: () => state };
}
