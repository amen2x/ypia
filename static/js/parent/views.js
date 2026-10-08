// Data views for the parent app: Next up, Medications, Schedule.
// All data comes from the existing /api/parent/* endpoints. Nothing is mocked:
// loading, empty and error states are shown as they really are.

import { el, icon } from "./dom.js";

const timezone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago";
  } catch {
    return "America/Chicago";
  }
})();

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

export function fetchSchedule(userId, range) {
  return getJson(
    `/api/parent/schedule?userId=${encodeURIComponent(userId)}&range=${encodeURIComponent(range)}&timezone=${encodeURIComponent(timezone)}`
  );
}

function fetchMedications(userId) {
  return getJson(`/api/parent/current-medications?userId=${encodeURIComponent(userId)}`);
}

function fetchNextAppointment(userId) {
  return getJson(`/api/parent/next-appointment?userId=${encodeURIComponent(userId)}`);
}

// ---- formatting ----

const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" });
const shortDayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function relativeDayLabel(date) {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (sameDay(date, now)) return "Today";
  if (sameDay(date, tomorrow)) return "Tomorrow";
  return shortDayFmt.format(date);
}

function meta(iconName, text) {
  const node = el("span");
  node.append(icon(iconName), document.createTextNode(text));
  return node;
}

function stateMessage(text, isError) {
  return el("p", `state-msg${isError ? " is-error" : ""}`, text);
}

// Loading placeholders shaped like the real rows (dot, time, title, detail).
function skeletons(count) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i += 1) {
    const row = el("div", "skeleton");
    row.setAttribute("aria-hidden", "true");
    const time = el("div", "sk-col");
    time.append(el("span", "sk-bar sk-time"), el("span", "sk-bar sk-sub sk-day"));
    const body = el("div", "sk-col");
    body.append(el("span", "sk-bar sk-title"), el("span", "sk-bar sk-sub"));
    row.append(el("span", "sk-dot"), time, body);
    frag.append(row);
  }
  return frag;
}

// ---- Next up (home) ----

export async function renderNextUp(container, user) {
  container.replaceChildren(skeletons(2));
  try {
    const { events } = await fetchSchedule(user.id, "upcoming");
    const upcoming = (events || []).slice(0, 3);
    if (upcoming.length > 0) {
      const list = el("div", "next-list");
      upcoming.forEach((event, index) => {
        const start = new Date(event.startTime);
        const item = el("a", `next-item${index === 0 ? " is-first" : ""}${relativeDayLabel(start) === "Today" ? " is-today" : ""}`);
        item.href = "#schedule";
        const time = el("div", "next-time", timeFmt.format(start));
        time.append(el("small", "", relativeDayLabel(start)));
        const body = el("div");
        body.append(el("p", "next-title", event.title));
        const place = event.location || event.withWhom;
        if (place) {
          const line = el("p", "next-meta");
          line.append(icon(event.location ? "map-pin" : "user-round"), document.createTextNode(place));
          body.append(line);
        }
        item.append(time, body, icon("chevron-right", "row-chevron"));
        list.append(item);
      });
      container.replaceChildren(list);
      return;
    }

    // Nothing on the schedule: fall back to the appointments table, which is
    // what the voice assistant's get_next_appointment tool reads.
    const { appointment } = await fetchNextAppointment(user.id);
    if (appointment) {
      const item = el("a", "next-item is-first");
      item.href = "#schedule";
      const time = el("div", "next-time", appointment.time);
      time.append(el("small", "", appointment.date));
      const body = el("div");
      body.append(el("p", "next-title", appointment.title || "Appointment"));
      if (appointment.location) {
        const line = el("p", "next-meta");
        line.append(icon("map-pin"), document.createTextNode(appointment.location));
        body.append(line);
      }
      item.append(time, body, icon("chevron-right", "row-chevron"));
      container.replaceChildren(el("div", "next-list"));
      container.firstChild.append(item);
      return;
    }

    container.replaceChildren(stateMessage("Nothing coming up. Enjoy your day!"));
  } catch {
    container.replaceChildren(stateMessage("We couldn't load your schedule just now. Please try again in a moment.", true));
  }
}

// ---- Medicines preview (home) ----

export async function renderMedPeek(container, user) {
  container.replaceChildren(skeletons(2));
  try {
    const { medications } = await fetchMedications(user.id);
    if (!medications || medications.length === 0) {
      container.replaceChildren(stateMessage("No medicines recorded yet. Add a prescription and it will show up here."));
      return;
    }
    const list = el("ul", "med-peek");
    medications.slice(0, 4).forEach((med, index) => {
      const item = el("li");
      const link = el("a", "med-row");
      link.href = "#medications";
      const badge = el("span", `med-badge${index % 2 === 1 ? " is-clay" : ""}`);
      badge.append(icon("pill"));
      const text = el("span", "med-row-text");
      text.append(el("span", "med-peek-name", med.name));
      if (med.strength) text.append(el("span", "med-peek-dose", med.strength));
      link.append(badge, text);
      if (med.instructions) link.append(el("span", "med-row-how", med.instructions));
      link.append(icon("chevron-right", "row-chevron"));
      item.append(link);
      list.append(item);
    });
    if (medications.length > 4) {
      list.append(el("li", "med-peek-more", `and ${medications.length - 4} more`));
    }
    container.replaceChildren(list);
  } catch {
    container.replaceChildren(stateMessage("We couldn't load your medicines just now. Please try again in a moment.", true));
  }
}

// ---- Medications ----

export async function renderMedications(container, user) {
  container.replaceChildren(skeletons(3));
  try {
    const { medications } = await fetchMedications(user.id);
    if (!medications || medications.length === 0) {
      const empty = el("div", "card empty-card");
      const badge = el("div", "quick-icon");
      badge.append(icon("pill"));
      empty.append(
        badge,
        el("h2", "card-title", "No medications yet"),
        el("p", "", "When you add a prescription or visit summary, your medications will show up here.")
      );
      container.replaceChildren(empty);
      return;
    }

    const list = el("div", "med-list");
    for (const med of medications) {
      const card = el("article", "card med-card");
      const badge = el("div", "med-icon");
      badge.append(icon("pill", "icon-lg"));
      const body = el("div");
      body.append(el("h2", "med-name", med.name));
      if (med.strength) body.append(el("span", "med-strength", med.strength));
      if (med.instructions) body.append(el("p", "med-how", med.instructions));
      card.append(badge, body);
      list.append(card);
    }
    container.replaceChildren(list);
  } catch {
    container.replaceChildren(stateMessage("We couldn't load your medications just now. Please try again in a moment.", true));
  }
}

// ---- Schedule ----

const ATTENDANCE_CHIPS = {
  attended: { text: "Attended", className: "chip chip-attended" },
  missed: { text: "Missed", className: "chip chip-missed" },
};

function renderEvent(event) {
  const start = new Date(event.startTime);
  const end = new Date(event.endTime);
  const card = el("article", "card event-card");

  const time = el("div", "event-time", timeFmt.format(start));
  if (!Number.isNaN(end.getTime()) && end > start) time.append(el("small", "", `until ${timeFmt.format(end)}`));

  const body = el("div");
  const title = el("h3", "event-title", event.title);
  const chip = ATTENDANCE_CHIPS[event.attendanceStatus] || ATTENDANCE_CHIPS[event.status];
  if (chip) title.append(el("span", chip.className, chip.text));
  body.append(title);

  const details = el("div", "event-meta");
  if (event.location) details.append(meta("map-pin", event.location));
  if (event.withWhom) details.append(meta("user-round", event.withWhom));
  if (event.category) details.append(meta("info", event.category));
  if (details.childNodes.length > 0) body.append(details);
  if (event.description) body.append(el("p", "event-meta", event.description));

  card.append(time, body);
  return card;
}

export async function renderSchedule(container, user, range) {
  container.replaceChildren(skeletons(3));
  try {
    const { events } = await fetchSchedule(user.id, range);
    if (!events || events.length === 0) {
      const empty = el("div", "card empty-card");
      const badge = el("div", "quick-icon");
      badge.append(icon("calendar-days"));
      const messages = {
        today: "Nothing is planned for today.",
        tomorrow: "Nothing is planned for tomorrow.",
        week: "Nothing is planned for the next 7 days.",
        upcoming: "There's nothing coming up.",
      };
      empty.append(badge, el("h2", "card-title", messages[range] || "Nothing planned."), el("p", "", "New appointments and plans will appear here."));
      container.replaceChildren(empty);
      return;
    }

    // Group by local day.
    const groups = [];
    for (const event of events) {
      const date = new Date(event.startTime);
      const last = groups[groups.length - 1];
      if (last && sameDay(last.date, date)) last.events.push(event);
      else groups.push({ date, events: [event] });
    }

    const frag = document.createDocumentFragment();
    for (const group of groups) {
      const section = el("section", "day-group");
      const prefix = relativeDayLabel(group.date);
      section.append(el("h2", "day-label", ["Today", "Tomorrow"].includes(prefix) ? `${prefix} · ${dayFmt.format(group.date)}` : dayFmt.format(group.date)));
      const list = el("div", "event-list");
      group.events.forEach((event) => list.append(renderEvent(event)));
      section.append(list);
      frag.append(section);
    }
    container.replaceChildren(frag);
  } catch {
    container.replaceChildren(stateMessage("We couldn't load your schedule just now. Please try again in a moment.", true));
  }
}
