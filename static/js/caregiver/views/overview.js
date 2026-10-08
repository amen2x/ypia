// Overview: a care-coordination home screen that answers three questions and nothing else.
//   1. What needs my attention?   2. What's coming up?   3. What changed recently?
// Everything else (medications, documents, full task details, the check-in streak) is one click deeper.

import { api } from "../api.js";
import { state, parentName, parentFirstName, reload, user } from "../store.js";
import { busyTasks, toggleTask } from "../actions.js";
import { attentionRank, buildAgenda, el, emptyState, errorState, icon, isParentRequest, skeletons } from "../ui.js";
import { calendarMenu } from "../calendar.js";
import { dayDiff, fmtDate, fmtDayNum, fmtDow, fmtLongDate, fmtTime, shortWhen } from "../format.js";

const isLoading = (slice) => slice.status === "idle" || slice.status === "loading";
const MAX_ATTENTION = 3;
const MAX_AGENDA = 3;
const MAX_CHANGES = 3;

const CHANGE_LABELS = {
  medication_started: "Medication",
  medication_stopped: "Medication",
  medication_changed: "Medication",
  appointment_added: "Appointment",
  followup_added: "Follow-up",
  instruction_added: "Instruction",
};

export function createOverview(root) {
  // ---- header: the page title and the one primary action ----
  const head = el("div", "page-head");
  const headText = el("div");
  const title = el("h1", "page-title");
  title.tabIndex = -1;
  const subtitle = el("p", "page-sub");
  headText.append(title, subtitle);
  const addTask = el("a", "btn btn-primary", "");
  addTask.href = "#tasks";
  addTask.append(icon("list-checks"), document.createTextNode("Add task"));
  addTask.addEventListener("click", () => setTimeout(() => document.getElementById("taskText")?.focus(), 80));
  head.append(headText, addTask);

  const attention = el("section", "ov-section");
  const agenda = el("section", "ov-section");
  const changes = el("section", "ov-section");
  const summary = el("nav", "ov-summary");
  summary.setAttribute("aria-label", "Care record shortcuts");
  root.append(head, attention, agenda, changes, summary);

  function sectionHead(text, linkText, href) {
    const row = el("div", "ov-head");
    row.append(el("h2", "ov-title", text));
    if (href) {
      const link = el("a", "link-arrow", linkText);
      link.href = href;
      row.append(link);
    }
    return row;
  }

  // ---- 1. Needs your attention (at most three, each one line of title + one line of context) ----
  function taskRow(task, first) {
    const done = task.status === "done";
    const row = el("li", `ov-row${isParentRequest(task) ? " is-request" : ""}`);
    const check = el("button", "task-check");
    check.type = "button";
    check.setAttribute("role", "checkbox");
    check.setAttribute("aria-checked", String(done));
    check.setAttribute("aria-label", `Mark done: ${task.text}`);
    check.dataset.focusKey = `ov-task-${task.id}`;
    check.append(el("span", "box"));
    if (busyTasks.has(task.id)) check.disabled = true;
    check.addEventListener("click", () => toggleTask(task));

    const body = el("div", "ov-body");
    body.append(el("p", "ov-row-title", task.text));
    const meta = el("p", "ov-meta");
    const source = el("span", isParentRequest(task) ? "ov-source" : "", isParentRequest(task) ? `From ${first}` : "Your task");
    meta.append(source);
    const when = shortWhen(task.date, task.time);
    if (when) {
      const overdue = dayDiff(task.date) < 0;
      meta.append(document.createTextNode(" · "), el("span", overdue ? "ov-overdue" : "", overdue ? `Overdue ${when}` : when));
    }
    body.append(meta);
    row.append(check, body);
    return row;
  }

  function renderAttention() {
    const slice = state.slices.tasks;
    attention.replaceChildren(sectionHead("Needs your attention", "View all tasks →", "#tasks"));
    if (isLoading(slice)) return attention.append(skeletons(2));
    if (slice.status === "error") return attention.append(errorState(`Couldn't load tasks. ${slice.error}`, () => reload(["tasks"])));
    const first = parentFirstName();
    const needs = slice.data
      .map((task) => ({ task, rank: attentionRank(task) }))
      .filter((x) => x.rank !== null)
      .sort((a, b) => a.rank - b.rank || (a.task.date || "9999").localeCompare(b.task.date || "9999") || String(b.task.createdAt).localeCompare(String(a.task.createdAt)))
      .map((x) => x.task);
    if (needs.length === 0) return attention.append(emptyState("circle-check-big", "Nothing needs your attention", `Requests from ${first} and tasks that are due soon will appear here.`));
    const list = el("ul", "ov-list");
    needs.slice(0, MAX_ATTENTION).forEach((task) => list.append(taskRow(task, first)));
    attention.append(list);
    if (needs.length > MAX_ATTENTION) attention.append(el("p", "ov-more", `${needs.length - MAX_ATTENTION} more in Tasks`));
  }

  // ---- 2. Coming up (the next two or three, date + title + time) ----
  function renderAgenda() {
    const a = state.slices.upcoming;
    const b = state.slices.appointments;
    agenda.replaceChildren(sectionHead("Coming up", "Full schedule →", "#schedule"));
    if (isLoading(a) && isLoading(b)) return agenda.append(skeletons(2));
    if (a.status === "error" && b.status === "error") return agenda.append(errorState(`Couldn't load the schedule. ${a.error}`, () => reload(["upcoming", "appointments"])));
    const items = buildAgenda(a.data, b.data);
    if (items.length === 0) return agenda.append(emptyState("calendar-days", "Nothing scheduled", "Confirmed appointments and events will appear here."));
    const list = el("ul", "ov-list");
    items.slice(0, MAX_AGENDA).forEach((item, index) => {
      const row = el("li", `ov-row ov-event${index === 0 ? " is-next" : ""}`);
      const date = el("div", "ov-date");
      date.append(el("span", "ov-dow", fmtDow(item.start)), el("span", "ov-day", fmtDayNum(item.start)));
      const body = el("div", "ov-body");
      body.append(el("p", "ov-row-title", item.title));
      body.append(el("p", "ov-meta ov-oneline", [fmtTime(item.start, item.tz), item.location].filter(Boolean).join(" · ")));
      row.append(date, body);
      // One compact action: Add to calendar (Google Calendar or a .ics file).
      if (item.id) row.append(calendarMenu({ kind: item.kind === "appointment" ? "appointment" : "schedule", id: item.id, title: item.title }));
      list.append(row);
    });
    agenda.append(list);
  }

  // ---- 3. Recent changes (latest three confirmed, plus the one secondary action) ----
  function renderChanges() {
    const slice = state.slices.changes;
    changes.replaceChildren(sectionHead("Recent changes", "View all changes →", "#changes"));
    if (isLoading(slice)) return changes.append(skeletons(2));
    if (slice.status === "error") return changes.append(errorState(`Couldn't load changes. ${slice.error}`, () => reload(["changes"])));
    const data = slice.data;
    const first = parentFirstName();
    if (data.status === "ok" && data.changes.length > 0) {
      const list = el("ul", "ov-list");
      data.changes.slice(0, MAX_CHANGES).forEach((change) => {
        const row = el("li", "ov-row ov-change");
        row.append(el("span", "ov-kind", CHANGE_LABELS[change.type] || "Update"), el("span", "ov-change-text", change.summary));
        list.append(row);
      });
      changes.append(list);
    } else if (data.status === "no_changes") {
      changes.append(el("p", "ov-quiet", "Nothing differs between the last two documents confirmed."));
    } else if (data.status === "not_enough_history") {
      changes.append(el("p", "ov-quiet", `Changes appear once ${first} has confirmed two documents.`));
    } else {
      changes.append(el("p", "ov-quiet", "The last two records couldn't be compared."));
    }
    const talk = el("a", "ov-text-action", "Prepare talking points");
    talk.href = "#changes";
    changes.append(talk);
  }

  // ---- shortcuts to the detailed pages (+ the small, motivational check-in streak) ----
  let streak = null;
  let streakRequested = false;

  function ensureStreak() {
    if (streakRequested || !user?.id) return;
    streakRequested = true;
    api.streak(user.id).then((s) => { streak = s; renderSummary(); }).catch(() => {});
  }

  function renderSummary() {
    summary.replaceChildren();
    const ul = el("ul", "");
    const meds = state.slices.medications;
    const docs = state.slices.documents;
    const medCount = meds.status === "ready" ? meds.data.filter((m) => m.status === "active").length : null;
    const link = (text, href) => {
      const li = el("li");
      const a = el("a", "", text);
      a.href = href;
      li.append(a);
      return li;
    };
    ul.append(link(medCount === null ? "Medications →" : `${medCount} current medication${medCount === 1 ? "" : "s"} →`, "#medications"));
    ul.append(link(docs.status === "ready" ? `${docs.data.length} document${docs.data.length === 1 ? "" : "s"} →` : "Documents →", "#documents"));
    if (streak) {
      const li = el("li", "ov-streak");
      li.append(document.createTextNode(streak.streak > 0 ? `${streak.streak}-week check-in streak` : "No check-in streak yet"));
      if (!streak.checkedInThisWeek) {
        const log = el("button", "linklike", "Log this week's check-in");
        log.type = "button";
        log.addEventListener("click", async () => {
          log.disabled = true;
          try {
            streak = await api.checkIn(user.id);
          } catch {
            log.disabled = false;
            return;
          }
          renderSummary();
        });
        li.append(log);
      }
      ul.append(li);
    }
    summary.append(ul);
  }

  function render() {
    title.textContent = parentName() || "Overview";
    subtitle.textContent = fmtLongDate(new Date());
    renderAttention();
    renderAgenda();
    renderChanges();
    renderSummary();
    ensureStreak();
    void fmtDate;
  }

  return { title: "Overview", render };
}
