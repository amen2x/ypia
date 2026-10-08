// "Add to calendar" for Y.P.I.A. items.
//
// Every export is built by the server from the stored record's structured fields (appointment
// time, a task's scheduled date/time, a schedule event's start/end). This module never reads a
// date or time out of an item's wording, and exporting never creates or changes anything in
// Y.P.I.A. Items with no structured date offer "Schedule" instead, which saves a real date.

import { el, icon } from "../parent/dom.js";
import { api } from "./api.js";
import { reload, user } from "./store.js";
import { showToast } from "./toast.js";

// ---------- the Add to calendar menu ----------

let openMenu = null; // only one menu is open at a time

function closeMenu(menu, { restoreFocus = false } = {}) {
  if (!menu) return;
  menu.popup.hidden = true;
  menu.button.setAttribute("aria-expanded", "false");
  if (restoreFocus) menu.button.focus();
  if (openMenu === menu) openMenu = null;
}

document.addEventListener("click", (event) => {
  if (openMenu && !openMenu.wrap.contains(event.target)) closeMenu(openMenu);
});
document.addEventListener("focusin", (event) => {
  if (openMenu && !openMenu.wrap.contains(event.target)) closeMenu(openMenu);
});

// kind: "appointment" | "action" | "schedule"; id: the stored record's id.
// extraItems: optional extra menu entries [{ label, iconName, onSelect }].
export function calendarMenu({ kind, id, title, extraItems = [] }) {
  const wrap = el("div", "cal-menu");
  const button = el("button", "icon-btn");
  button.type = "button";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", `Add to calendar: ${title}`);
  button.title = "Add to calendar";
  button.dataset.focusKey = `cal-${kind}-${id}`;
  button.append(icon("calendar-plus"));

  const popup = el("ul", "cal-popup");
  popup.setAttribute("role", "menu");
  popup.setAttribute("aria-label", `Add to calendar: ${title}`);
  popup.hidden = true;

  const url = (format) => api.calendarExportUrl(kind, id, format, user.id);
  const entries = [
    { label: "Google Calendar", iconName: "calendar-days", href: url("google"), newTab: true },
    { label: "Download calendar file (.ics)", iconName: "file-text", href: url("ics"), download: true },
  ];
  const items = [];

  for (const entry of entries) {
    const li = el("li");
    li.setAttribute("role", "none");
    const link = el("a", "cal-item");
    link.setAttribute("role", "menuitem");
    link.href = entry.href;
    if (entry.newTab) {
      link.target = "_blank";
      link.rel = "noopener";
    }
    if (entry.download) link.setAttribute("download", "");
    link.append(icon(entry.iconName), document.createTextNode(entry.label));
    link.addEventListener("click", () => closeMenu(menu));
    li.append(link);
    popup.append(li);
    items.push(link);
  }
  for (const extra of extraItems) {
    const li = el("li");
    li.setAttribute("role", "none");
    const action = el("button", "cal-item");
    action.type = "button";
    action.setAttribute("role", "menuitem");
    action.append(icon(extra.iconName), document.createTextNode(extra.label));
    action.addEventListener("click", () => {
      closeMenu(menu);
      extra.onSelect();
    });
    li.append(action);
    popup.append(li);
    items.push(action);
  }

  const menu = { wrap, button, popup };

  function open() {
    closeMenu(openMenu);
    popup.hidden = false;
    popup.classList.remove("cal-popup--up");
    // Open upward when there is no room below (above the phone tab bar, if there is one).
    const rail = document.querySelector(".cg-rail");
    const limit = rail && getComputedStyle(rail).position === "fixed" ? rail.getBoundingClientRect().top : window.innerHeight;
    if (popup.getBoundingClientRect().bottom > limit && button.getBoundingClientRect().top > popup.offsetHeight + 8) popup.classList.add("cal-popup--up");
    button.setAttribute("aria-expanded", "true");
    openMenu = menu;
    items[0]?.focus({ preventScroll: true });
  }

  button.addEventListener("click", () => (popup.hidden ? open() : closeMenu(menu)));
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (popup.hidden) open();
    }
  });
  popup.addEventListener("keydown", (event) => {
    const index = items.indexOf(document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(menu, { restoreFocus: true });
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(index + 1) % items.length].focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length].focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0].focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1].focus();
    } else if (event.key === " " && document.activeElement?.tagName === "A") {
      event.preventDefault(); // links do not activate on Space by default; menu items should
      document.activeElement.click();
    }
  });

  wrap.append(button, popup);
  return wrap;
}

// ---------- Schedule: give an unscheduled task a real, saved date ----------

export function scheduleButton(task, { label = "Schedule" } = {}) {
  const button = el("button", "btn btn-secondary btn-sm");
  button.type = "button";
  button.dataset.focusKey = `sched-${task.id}`;
  button.setAttribute("aria-label", `${label}: ${task.text}`);
  button.append(icon("calendar-plus"), document.createTextNode(label));
  button.addEventListener("click", () => openScheduleDialog(task, button));
  return button;
}

export function openScheduleDialog(task, opener) {
  const dialog = document.getElementById("scheduleDialog");
  const form = document.getElementById("scheduleForm");
  const date = document.getElementById("scheduleDate");
  const start = document.getElementById("scheduleStart");
  const end = document.getElementById("scheduleEnd");
  const status = document.getElementById("scheduleStatus");
  const save = document.getElementById("scheduleSave");
  const clear = document.getElementById("scheduleClear");

  document.getElementById("scheduleTaskTitle").textContent = task.text;
  date.value = task.date || "";
  start.value = to24h(task.time);
  end.value = to24h(task.endTime);
  status.textContent = "";
  status.className = "status-line";
  clear.hidden = !task.date;

  async function persist(fields, doneMessage) {
    save.disabled = true;
    clear.disabled = true;
    status.className = "status-line";
    status.textContent = "Saving…";
    try {
      await api.scheduleAction(task.id, user.id, fields);
      await reload(["tasks"], { silent: true });
      dialog.close();
      showToast(doneMessage);
    } catch (error) {
      status.className = "status-line is-error";
      status.textContent = error.message || "Couldn't save the schedule.";
    } finally {
      save.disabled = false;
      clear.disabled = false;
    }
  }

  form.onsubmit = (event) => {
    event.preventDefault();
    status.className = "status-line is-error";
    if (!date.value) {
      status.textContent = "Choose a date.";
      date.focus();
      return;
    }
    if (end.value && !start.value) {
      status.textContent = "An end time needs a start time.";
      start.focus();
      return;
    }
    if (end.value && start.value && end.value < start.value) {
      status.textContent = "The end time can't be earlier than the start time.";
      end.focus();
      return;
    }
    persist(
      { scheduledDate: date.value, scheduledTime: start.value || null, scheduledEndTime: end.value || null },
      "Scheduled. You can now add it to your calendar."
    );
  };
  clear.onclick = () => persist({ scheduledDate: null, scheduledTime: null, scheduledEndTime: null }, "Date removed.");

  dialog.addEventListener("close", () => opener?.isConnected && opener.focus(), { once: true });
  dialog.showModal();
  date.focus();
}

// "10:30 AM" / "10:30" -> "10:30" for <input type="time">
function to24h(raw) {
  if (!raw) return "";
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(String(raw).trim());
  if (!m) return "";
  let h = Number(m[1]);
  if (m[3]) h = (h % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0);
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

// ---------- which control a task gets ----------

// Scheduled (its own date, or its linked appointment's) -> Add to calendar.
// Not scheduled -> Schedule. Done tasks get nothing.
export function taskCalendarControl(task) {
  if (task.status === "done") return null;
  if (!task.date) return scheduleButton(task);
  const linked = Boolean(task.appointmentTitle);
  return calendarMenu({
    kind: "action",
    id: task.id,
    title: task.text,
    // A task linked to an appointment follows that appointment's time, so it cannot be rescheduled here.
    extraItems: linked ? [] : [{ label: "Change date or time", iconName: "pencil", onSelect: () => openScheduleDialog(task, null) }],
  });
}
