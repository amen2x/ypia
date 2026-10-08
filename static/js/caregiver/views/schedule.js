// Schedule: confirmed appointments and calendar events, with attendance for what's already happened.

import { state, parentFirstName, reload } from "../store.js";
import { api } from "../api.js";
import { buildAgenda, chip, el, emptyState, errorState, eventRow, icon, showToast, skeletons } from "../ui.js";
import { fmtDow, fmtDayNum, fmtLongDate, fmtTime, localISO } from "../format.js";

const isLoading = (slice) => slice.status === "idle" || slice.status === "loading";

function pointsText(event) {
  if (event.point_value == null) return "Activity points not reviewed yet";
  if (event.attendance_status === "attended") return `${event.points_earned ?? event.point_value} of ${event.point_value} activity points earned`;
  if (event.attendance_status === "missed") return `0 of ${event.point_value} activity points`;
  return `${event.point_value} activity points available`;
}

function pastRow(event) {
  const start = new Date(event.start_time);
  const end = new Date(event.end_time);
  const row = el("li", "event");
  const date = el("div", "event-date");
  date.append(el("span", "event-dow", fmtDow(start)), el("span", "event-day", fmtDayNum(start)));
  const main = el("div");
  main.append(el("p", "event-title", event.title));
  const meta = el("div", "event-meta");
  const time = el("span");
  time.append(icon("clock"), document.createTextNode(Number.isNaN(end.getTime()) || end <= start ? fmtTime(start) : `${fmtTime(start)} – ${fmtTime(end)}`));
  meta.append(time);
  if (event.location) {
    const place = el("span");
    place.append(icon("map-pin"), document.createTextNode(event.location));
    meta.append(place);
  }
  main.append(meta);
  const chips = el("div", "event-chips");
  if (event.attendance_status === "attended") chips.append(chip("ok", "check", "Attended"));
  else if (event.attendance_status === "missed") chips.append(chip("overdue", "x", "Missed"));
  else chips.append(chip("muted", null, "Attendance not recorded"));
  if (event.category) chips.append(chip("muted", null, event.category));
  main.append(chips, el("p", "event-points", pointsText(event)));
  row.append(date, main);
  return row;
}

export function createSchedule(root) {
  let tab = "upcoming";

  const head = el("div", "page-head");
  const headText = el("div");
  const title = el("h1", "page-title", "Schedule");
  title.tabIndex = -1;
  const sub = el("p", "page-sub");
  headText.append(title, sub);
  const headActions = el("div", "head-actions");
  head.append(headText, headActions);

  const scoreButton = el("button", "btn btn-secondary", "");
  scoreButton.type = "button";
  scoreButton.append(icon("refresh-cw"), document.createTextNode("Score recent activity"));
  const scoreStatus = el("p", "status-line");
  scoreStatus.setAttribute("role", "status");

  const tabs = el("div", "tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Schedule view");
  const upTab = el("button", "tab", "Upcoming");
  const pastTab = el("button", "tab", "Past");
  [[upTab, "upcoming"], [pastTab, "past"]].forEach(([button, value]) => {
    button.type = "button";
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => {
      tab = value;
      render();
    });
  });
  tabs.append(upTab, pastTab);

  const listWrap = el("div");
  listWrap.setAttribute("role", "tabpanel");
  const note = el("div", "note");
  note.append(icon("info"), el("p", "", "Activity points are a simple, motivational tally of the events attended each day. They are not a health measurement."));

  root.append(head, tabs, listWrap);

  scoreButton.addEventListener("click", async () => {
    if (!state.parentId) return;
    scoreButton.disabled = true;
    scoreStatus.className = "status-line";
    scoreStatus.textContent = "Reviewing each day's events…";
    try {
      const result = await api.scoreSchedule(state.parentId);
      scoreStatus.className = "status-line is-ok";
      scoreStatus.textContent = result.scoredEvents
        ? `Reviewed ${result.scoredEvents} event${result.scoredEvents === 1 ? "" : "s"}. Each day totals 100 points.`
        : "All events are already reviewed.";
      await reload(["upcoming", "past"], { silent: true });
    } catch (error) {
      scoreStatus.className = "status-line is-error";
      scoreStatus.textContent = error.message || "Couldn't review the events.";
      showToast(scoreStatus.textContent, true);
    } finally {
      scoreButton.disabled = false;
    }
  });

  function renderUpcoming() {
    const a = state.slices.upcoming;
    const b = state.slices.appointments;
    if (isLoading(a) && isLoading(b)) return listWrap.replaceChildren(skeletons(4));
    if (a.status === "error" && b.status === "error") return listWrap.replaceChildren(errorState(`Couldn't load the schedule. ${a.error}`, () => reload(["upcoming", "appointments"])));
    const t = state.slices.tasks;
    const items = buildAgenda(a.data, b.data, t.status === "ready" ? t.data : []);
    const frag = document.createDocumentFragment();
    if (items.length === 0) {
      frag.append(emptyState("calendar-days", "Nothing scheduled", `Appointments ${parentFirstName()} confirms and events you add appear here.`));
    } else {
      const today = localISO(new Date());
      const tomorrow = localISO(new Date(Date.now() + 86400000));
      const agenda = el("div", "agenda");
      let currentDay = "";
      let list = null;
      items.forEach((item, index) => {
        const day = localISO(item.start);
        if (day !== currentDay) {
          currentDay = day;
          const label = day === today ? "Today" : day === tomorrow ? "Tomorrow" : "";
          agenda.append(el("h2", "day-label", label ? `${label} · ${fmtLongDate(item.start)}` : fmtLongDate(item.start)));
          list = el("ul", "");
          agenda.append(list);
        }
        list.append(eventRow(item, { isNext: index === 0 }));
      });
      frag.append(agenda);
    }
    if (a.status === "error" || b.status === "error") frag.append(errorState(a.status === "error" ? "Some events couldn't be loaded." : "Confirmed appointments couldn't be loaded.", () => reload(["upcoming", "appointments"])));
    listWrap.replaceChildren(frag);
  }

  function renderPast() {
    const slice = state.slices.past;
    if (isLoading(slice)) return listWrap.replaceChildren(skeletons(4));
    if (slice.status === "error") return listWrap.replaceChildren(errorState(`Couldn't load past events. ${slice.error}`, () => reload(["past"])));
    const frag = document.createDocumentFragment();
    if (slice.data.length === 0) {
      frag.append(emptyState("history", "No past events yet", "Events appear here after they happen, with whether they were attended."));
    } else {
      const list = el("ul", "");
      slice.data.forEach((event) => list.append(pastRow(event)));
      frag.append(list, el("div", "", ""), note);
      note.style.marginTop = "1.25rem";
    }
    listWrap.replaceChildren(frag);
  }

  function render() {
    sub.textContent = `Appointments, events and scheduled tasks for ${parentFirstName()}. Use the calendar button to add one to Google Calendar or download a calendar file.`;
    headActions.replaceChildren(scoreStatus, scoreButton);
    upTab.setAttribute("aria-selected", String(tab === "upcoming"));
    pastTab.setAttribute("aria-selected", String(tab === "past"));
    upTab.tabIndex = tab === "upcoming" ? 0 : -1;
    pastTab.tabIndex = tab === "past" ? 0 : -1;
    scoreButton.hidden = false;
    if (tab === "upcoming") renderUpcoming();
    else renderPast();
  }

  return { title: "Schedule", render };
}
