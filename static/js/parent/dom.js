// Tiny DOM helpers shared by the parent app modules.
// Text is always set through textContent, never parsed as HTML.

const SPRITE = "/static/icons/sprite.svg";

export function icon(name, className = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `icon ${className}`.trim());
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `${SPRITE}#i-${name}`);
  svg.append(use);
  return svg;
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

export function getUser() {
  try {
    return JSON.parse(localStorage.getItem("ypia_user") || "null");
  } catch {
    return null;
  }
}

export function firstNameOf(fullName) {
  return (fullName || "").trim().split(/\s+/)[0] || "";
}

export function initialsOf(fullName) {
  const parts = (fullName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}
