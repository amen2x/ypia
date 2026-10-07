// Date/time helpers. Dates that arrive as "YYYY-MM-DD" are explicit calendar dates (never
// inferred from text); instants arrive as ISO strings.

const SCHEDULE_TZ = "America/Chicago"; // the calendar export route interprets wall-clock times here

const pad = (n) => String(n).padStart(2, "0");
export const localISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayISO = () => localISO(new Date());

export function parseISODate(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function dayDiff(iso) {
  const target = parseISODate(iso);
  const today = parseISODate(todayISO());
  return Math.round((target - today) / 86400000);
}

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const longDateFmt = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" });
const weekdayDateFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });
const dowFmt = new Intl.DateTimeFormat("en-US", { weekday: "short" });

export const fmtDate = (d) => dateFmt.format(d);
export const fmtLongDate = (d) => longDateFmt.format(d);
export const fmtWeekdayDate = (d) => weekdayDateFmt.format(d);
export const fmtDow = (d) => dowFmt.format(d);
export const fmtDayNum = (d) => String(d.getDate());

export function fmtTime(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(date);
}

// Task times arrive as "10:30 AM" (linked appointment) or "10:30" (24h). Show one style.
export function timeLabel(raw) {
  if (!raw) return "";
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(String(raw).trim());
  if (!m) return String(raw);
  let h = Number(m[1]);
  const minutes = m[2];
  const suffix = m[3] ? m[3].toUpperCase() : h >= 12 ? "PM" : "AM";
  if (!m[3]) h = h % 12 || 12;
  return `${h}:${minutes} ${suffix}`;
}

export function timeAgo(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const minutes = Math.round((Date.now() - then.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return fmtDate(then);
}

// An instant as the wall-clock date/time the calendar export expects.
export function scheduleWallClock(instant) {
  const d = new Date(instant);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: SCHEDULE_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: SCHEDULE_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return { date, time };
}

// Urgency is derived from an explicit date only; nothing is stored or guessed.
export function dueInfo(task) {
  if (!task.date) return null;
  const diff = dayDiff(task.date);
  const when = task.time ? ` · ${timeLabel(task.time)}` : "";
  if (task.status === "done") return { kind: "none", label: `Due ${fmtDate(parseISODate(task.date))}`, icon: "calendar-days" };
  if (diff < 0) return { kind: "overdue", label: `Overdue · ${fmtDate(parseISODate(task.date))}`, icon: "circle-alert" };
  if (diff === 0) return { kind: "soon", label: `Due today${when}`, icon: "clock" };
  if (diff === 1) return { kind: "soon", label: `Due tomorrow${when}`, icon: "clock" };
  return { kind: "later", label: `Due ${fmtWeekdayDate(parseISODate(task.date))}${when}`, icon: "calendar-days" };
}

export function formatDocType(type) {
  if (!type) return "Document";
  return String(type).split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// A short, human "when" for a task's explicit date/time: "Today 10:30 AM", "Thu 10:30 AM", "Oct 15".
export function shortWhen(date, time) {
  if (!date) return "";
  const diff = dayDiff(date);
  const d = parseISODate(date);
  const t = time ? ` ${timeLabel(time)}` : "";
  if (diff < 0) return fmtDate(d);
  if (diff === 0) return `Today${t}`;
  if (diff === 1) return `Tomorrow${t}`;
  if (diff < 7) return `${fmtDow(d)}${t}`;
  return `${fmtDate(d)}${t}`;
}
