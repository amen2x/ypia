// A brief, announced confirmation or error message (also mirrored to the polite live region).

import { el } from "../parent/dom.js";

let toastTimer = null;

export function showToast(text, isError = false) {
  const live = document.getElementById("liveStatus");
  if (live) live.textContent = text;
  let box = document.getElementById("toast");
  if (!box) {
    box = el("div", "toast");
    box.id = "toast";
    box.setAttribute("aria-hidden", "true");
    document.body.append(box);
  }
  box.textContent = text;
  box.classList.toggle("is-error", isError);
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, isError ? 7000 : 3500);
}
