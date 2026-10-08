// Tasks: requests from the parent (created through Y.P.I.A.) and the caregiver's own tasks.

import { state, createTask, parentFirstName, reload, user } from "../store.js";
import { busyTasks, toggleTask } from "../actions.js";
import { attentionRank, el, emptyState, errorState, isParentRequest, skeletons, taskRow } from "../ui.js";
import { dayDiff, todayISO } from "../format.js";

export function createTasks(root) {
  let filter = "open"; // "open" | "done"

  const head = el("div", "page-head");
  const headText = el("div");
  const title = el("h1", "page-title", "Tasks");
  title.tabIndex = -1;
  const sub = el("p", "page-sub");
  headText.append(title, sub);
  head.append(headText);

  // New task form. Date and time are optional and explicit; nothing is parsed out of the text.
  const form = el("form", "task-form");
  form.noValidate = true;
  const textField = el("div", "field");
  const textLabel = el("label", "", "New task");
  textLabel.htmlFor = "taskText";
  const textInput = el("input", "input");
  Object.assign(textInput, { id: "taskText", type: "text", maxLength: 500, autocomplete: "off", placeholder: "e.g. Book a ride for Thursday's appointment" });
  textField.append(textLabel, textInput);
  const dateField = el("div", "field");
  const dateLabel = el("label", "", "Date (optional)");
  dateLabel.htmlFor = "taskDate";
  const dateInput = el("input", "input");
  Object.assign(dateInput, { id: "taskDate", type: "date" });
  dateField.append(dateLabel, dateInput);
  const timeField = el("div", "field");
  const timeLabel = el("label", "", "Time (optional)");
  timeLabel.htmlFor = "taskTime";
  const timeInput = el("input", "input");
  Object.assign(timeInput, { id: "taskTime", type: "time" });
  timeField.append(timeLabel, timeInput);
  const submit = el("button", "btn btn-primary", "Add task");
  submit.type = "submit";
  const help = el("p", "form-help", "Add a date to get a calendar button for the task. Tasks you add are saved to Y.P.I.A. for everyone linked to this parent.");
  const formStatus = el("p", "status-line");
  formStatus.setAttribute("role", "status");
  form.append(textField, dateField, timeField, submit, help, formStatus);

  const progress = el("div", "progress");
  const tabs = el("div", "tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Show tasks");
  const tabOpen = el("button", "tab");
  const tabDone = el("button", "tab");
  [[tabOpen, "open"], [tabDone, "done"]].forEach(([button, value]) => {
    button.type = "button";
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => {
      filter = value;
      render();
    });
  });
  tabs.append(tabOpen, tabDone);
  const listWrap = el("div");
  listWrap.setAttribute("role", "tabpanel");

  root.append(head, form, progress, tabs, listWrap);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = textInput.value.trim();
    formStatus.className = "status-line is-error";
    if (!text) {
      formStatus.textContent = "Please describe the task.";
      textInput.focus();
      return;
    }
    if (timeInput.value && !dateInput.value) {
      formStatus.textContent = "A time needs a date. Choose a date, or clear the time.";
      dateInput.focus();
      return;
    }
    submit.disabled = true;
    formStatus.className = "status-line";
    formStatus.textContent = "Saving…";
    try {
      await createTask({ text, date: dateInput.value, time: timeInput.value });
      textInput.value = "";
      dateInput.value = "";
      timeInput.value = "";
      formStatus.className = "status-line is-ok";
      formStatus.textContent = "Task added.";
      filter = "open";
    } catch (error) {
      formStatus.className = "status-line is-error";
      formStatus.textContent = `Couldn't add the task. ${error.message}`;
    } finally {
      submit.disabled = false;
    }
  });

  function openOrder(a, b) {
    const ra = attentionRank(a);
    const rb = attentionRank(b);
    return (ra ?? 9) - (rb ?? 9) || (a.date || "9999").localeCompare(b.date || "9999") || String(b.createdAt).localeCompare(String(a.createdAt));
  }

  function render() {
    const first = parentFirstName();
    sub.textContent = `Requests from ${first} come in through Y.P.I.A. and appear first. Add your own tasks below.`;
    const slice = state.slices.tasks;
    if (slice.status === "idle" || slice.status === "loading") {
      progress.replaceChildren();
      tabOpen.textContent = "Open";
      tabDone.textContent = "Done";
      return listWrap.replaceChildren(skeletons(4));
    }
    if (slice.status === "error") {
      progress.replaceChildren();
      return listWrap.replaceChildren(errorState(`Couldn't load tasks. ${slice.error}`, () => reload(["tasks"])));
    }

    const tasks = slice.data;
    const open = tasks.filter((t) => t.status === "open").sort(openOrder);
    const doneAll = tasks.filter((t) => t.status === "done");
    const done = doneAll.slice().sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
    const requests = open.filter(isParentRequest).length;

    tabOpen.replaceChildren(document.createTextNode("Open"), el("span", "count", String(open.length)));
    tabDone.replaceChildren(document.createTextNode("Done"), el("span", "count", String(done.length)));
    [[tabOpen, "open"], [tabDone, "done"]].forEach(([button, value]) => {
      button.setAttribute("aria-selected", String(filter === value));
      button.tabIndex = filter === value ? 0 : -1;
    });

    // Completion over the last 30 days (explicit counts, not a score).
    const recentDone = doneAll.filter((t) => t.completedAt && dayDiff(String(t.completedAt).slice(0, 10)) >= -30).length;
    const total = recentDone + open.length;
    progress.replaceChildren();
    if (total > 0) {
      const bar = el("div", "progress-bar");
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", String(total));
      bar.setAttribute("aria-valuenow", String(recentDone));
      bar.setAttribute("aria-label", "Tasks completed in the last 30 days");
      const fill = el("span");
      fill.style.width = `${Math.round((recentDone / total) * 100)}%`;
      bar.append(fill);
      progress.append(el("span", "", `${recentDone} of ${total} done in the last 30 days`), bar);
      if (requests > 0) progress.append(el("span", "", `· ${requests} open request${requests === 1 ? "" : "s"} from ${first}`));
    }

    const rows = filter === "open" ? open : done;
    if (rows.length === 0) {
      return listWrap.replaceChildren(filter === "open"
        ? emptyState("circle-check-big", "You're all caught up", `No open tasks or requests from ${first}.`)
        : emptyState("list-checks", "Nothing completed yet", "Tasks you finish appear here."));
    }
    const list = el("ul", "tasks");
    rows.forEach((task) => list.append(taskRow(task, { parentFirst: first, onToggle: toggleTask, busy: busyTasks.has(task.id) })));
    listWrap.replaceChildren(list);
  }

  // Keep the date picker from suggesting the past is the default.
  dateInput.min = todayISO();
  void user;

  return { title: "Tasks", render };
}
