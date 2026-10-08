// Shared building blocks for the caregiver views. Text is always set via textContent.

import { el, icon, initialsOf } from "../parent/dom.js";
import { dayDiff, dueInfo, fmtDayNum, fmtDow, fmtTime, taskStart, timeAgo } from "./format.js";
import { calendarMenu, taskCalendarControl } from "./calendar.js";

export { el, icon, initialsOf };
export { showToast } from "./toast.js";

export function chip(kind, iconName, text) {
  const node = el("span", `chip chip--${kind}`);
  if (iconName) node.append(icon(iconName));
  node.append(document.createTextNode(text));
  return node;
}

export function skeletons(count = 3) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i += 1) {
    const row = el("div", "skeleton");
    row.setAttribute("aria-hidden", "true");
    row.append(el("span", "sk-bar"), el("span", "sk-bar short"));
    frag.append(row);
  }
  return frag;
}

export function errorState(message, onRetry) {
  const box = el("div", "state state--error");
  box.setAttribute("role", "alert");
  box.append(icon("circle-alert"), el("span", "", message));
  if (onRetry) {
    const retry = el("button", "btn btn-secondary btn-sm", "Try again");
    retry.type = "button";
    retry.addEventListener("click", onRetry);
    box.append(retry);
  }
  return box;
}

export function emptyState(iconName, title, text) {
  const box = el("div", "empty");
  box.append(icon(iconName));
  const body = el("div");
  body.append(el("strong", "", title));
  if (text) body.append(el("span", "", text));
  box.append(body);
  return box;
}

export function sectionHead(title, { count, href, linkText } = {}) {
  const head = el("div", "section-head");
  const heading = el("h2", "section-title");
  heading.append(document.createTextNode(title));
  if (count !== undefined && count !== null) heading.append(el("span", "count", String(count)));
  head.append(heading);
  if (href) {
    const link = el("a", "link-arrow", linkText || "See all");
    link.href = href;
    link.append(icon("arrow-right"));
    head.append(link);
  }
  return head;
}

export function iconButton(iconName, label, onClick) {
  const button = el("button", "icon-btn");
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(icon(iconName));
  button.addEventListener("click", onClick);
  return button;
}

// ---------- Tasks and parent requests ----------

export const isParentRequest = (task) => task.source === "voice";

// A task needs attention when the parent asked for it, or its explicit date is overdue / imminent.
export function attentionRank(task) {
  if (task.status !== "open") return null;
  const due = dueInfo(task);
  if (due?.kind === "overdue") return 0;
  if (isParentRequest(task)) return 1;
  if (due?.kind === "soon") return 2;
  return null;
}

export function taskRow(task, { parentFirst, onToggle, busy }) {
  const done = task.status === "done";
  const request = isParentRequest(task);
  const item = el("li", `task${request ? " task--request" : ""}${done ? " is-done" : ""}`);
  item.dataset.taskId = task.id;

  const check = el("button", "task-check");
  check.type = "button";
  check.setAttribute("role", "checkbox");
  check.setAttribute("aria-checked", String(done));
  check.setAttribute("aria-label", `${done ? "Reopen" : "Mark done"}: ${task.text}`);
  check.dataset.focusKey = `task-${task.id}`;
  const box = el("span", "box");
  if (done) box.append(icon("check"));
  check.append(box);
  if (busy) check.disabled = true;
  check.addEventListener("click", () => onToggle(task));

  const body = el("div", "task-body");
  body.append(el("p", "task-title", task.text));
  const meta = el("div", "task-meta");
  meta.append(request ? chip("request", "mic", `Request from ${parentFirst}`) : chip("muted", "user-round", "Your task"));
  const due = dueInfo(task);
  if (due) meta.append(chip(due.kind === "none" || due.kind === "later" ? "muted" : due.kind, due.icon, due.label));
  else if (!done) meta.append(chip("muted", "calendar-days", "No date yet"));
  if (task.appointmentTitle) meta.append(chip("muted", "calendar-check", `Appointment: ${task.appointmentTitle}`));
  const when = done && task.completedAt ? `Done ${timeAgo(task.completedAt)}` : task.createdAt ? `Added ${timeAgo(task.createdAt)}` : "";
  if (when) meta.append(el("span", "", when));
  body.append(meta);

  const actions = el("div", "task-actions");
  const control = taskCalendarControl(task); // Add to calendar (scheduled) or Schedule (no date yet)
  if (control) actions.append(control);

  item.append(check, body, actions);
  return item;
}

// ---------- Agenda (appointments + schedule events) ----------

export function buildAgenda(events, appointments, tasks = []) {
  const items = [];
  for (const ev of events || []) {
    const start = new Date(ev.start_time);
    if (Number.isNaN(start.getTime())) continue;
    const end = new Date(ev.end_time);
    items.push({ kind: "event", id: ev.id, key: `e-${ev.id}`, title: ev.title, start, end: Number.isNaN(end.getTime()) ? null : end, location: ev.location, withWhom: ev.with_whom, category: ev.category });
  }
  for (const ap of appointments || []) {
    const start = new Date(ap.startsAt);
    if (Number.isNaN(start.getTime())) continue;
    items.push({ kind: "appointment", id: ap.id, key: `a-${ap.id}`, title: ap.title || "Appointment", start, end: null, tz: ap.timezone || undefined, location: ap.location, withWhom: ap.provider, status: ap.status });
  }
  // Open tasks that have an explicit date (their own, or their linked appointment's) belong on the schedule too.
  for (const task of tasks || []) {
    if (task.status !== "open" || !task.date) continue;
    if (dayDiff(task.date) < 0) continue; // overdue tasks live in Tasks, not in what is coming up
    const start = taskStart(task.date, task.time);
    const end = task.time && task.endTime ? taskStart(task.date, task.endTime) : null;
    items.push({ kind: "task", id: task.id, key: `t-${task.id}`, title: task.text, start, end, allDay: !task.time, location: null, withWhom: null, request: task.source === "voice" });
  }
  // The same visit can exist as a schedule event and a confirmed appointment; keep the confirmed one.
  const seen = new Map();
  for (const item of items) {
    const sig = `${item.title.trim().toLowerCase()}|${Math.round(item.start.getTime() / 60000)}`;
    if (!seen.has(sig) || item.kind === "appointment") seen.set(sig, item);
  }
  return [...seen.values()].sort((a, b) => a.start - b.start);
}

function metaLine(iconName, text) {
  const span = el("span");
  span.append(icon(iconName), document.createTextNode(text));
  return span;
}

const CALENDAR_KIND = { appointment: "appointment", event: "schedule", task: "action" };

export function eventRow(item, { isNext } = {}) {
  const row = el("li", `event${isNext ? " is-next" : ""}`);
  const date = el("div", "event-date");
  date.append(el("span", "event-dow", fmtDow(item.start)), el("span", "event-day", fmtDayNum(item.start)));

  const main = el("div");
  main.append(el("p", "event-title", item.title));
  const time = item.allDay ? "All day" : item.end && item.end > item.start ? `${fmtTime(item.start, item.tz)} – ${fmtTime(item.end, item.tz)}` : fmtTime(item.start, item.tz);
  const meta = el("div", "event-meta");
  meta.append(metaLine("clock", time));
  if (item.location) meta.append(metaLine("map-pin", item.location));
  if (item.withWhom) meta.append(metaLine("user-round", item.withWhom));
  main.append(meta);

  const chips = el("div", "event-chips");
  if (item.kind === "appointment") chips.append(item.status === "confirmed" || !item.status ? chip("ok", "file-check", "Confirmed appointment") : chip("muted", null, item.status));
  else if (item.kind === "task") chips.append(item.request ? chip("request", "mic", "Request") : chip("muted", "list-checks", "Task"));
  else if (item.category) chips.append(chip("muted", null, item.category));
  if (isNext) chips.append(chip("request", "clock", "Next up"));
  main.append(chips);

  const actions = el("div", "task-actions");
  actions.append(calendarMenu({ kind: CALENDAR_KIND[item.kind], id: item.id, title: item.title }));

  row.append(date, main, actions);
  return row;
}

// ---------- Care changes ----------

const CHANGE_KINDS = {
  medication_started: { label: "Medication", icon: "pill" },
  medication_stopped: { label: "Medication", icon: "pill" },
  medication_changed: { label: "Medication", icon: "pill" },
  appointment_added: { label: "Appointment", icon: "calendar-check" },
  followup_added: { label: "Follow-up", icon: "clipboard-list" },
  instruction_added: { label: "Instruction", icon: "info" },
};

export function changeRow(change) {
  const kind = CHANGE_KINDS[change.type] || { label: "Update", icon: "info" };
  const row = el("li", "change");
  row.append(icon(kind.icon));
  const text = el("div", "change-text");
  text.append(el("span", "change-kind", kind.label), document.createTextNode(change.summary));
  row.append(text);
  return row;
}
