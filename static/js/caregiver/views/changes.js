// Changes: what differs between the last two documents the parent confirmed, plus talking points
// assembled from confirmed records and open requests. No model call and no sample data.

import { state, parentFirstName, reload } from "../store.js";
import { buildAgenda, changeRow, chip, el, emptyState, errorState, icon, isParentRequest, showToast, skeletons } from "../ui.js";
import { dayDiff, fmtDate, fmtTime, fmtWeekdayDate, formatDocType, localISO } from "../format.js";

const isLoading = (slice) => slice.status === "idle" || slice.status === "loading";

// Each point: { title, detail }. Built only from data that is already on screen elsewhere.
export function buildTalkingPoints() {
  const first = parentFirstName();
  const points = [];

  const requests = (state.slices.tasks.data || []).filter((t) => t.status === "open" && isParentRequest(t));
  if (requests.length) {
    points.push({ title: `Open requests from ${first}`, detail: requests.map((r) => r.text).join("; ") });
  }

  const upcoming = buildAgenda(state.slices.upcoming.data, state.slices.appointments.data)
    .filter((item) => dayDiff(localISO(item.start)) <= 14 && (item.kind === "appointment" || /medical/i.test(item.category || "")))
    .slice(0, 3);
  if (upcoming.length) {
    points.push({
      title: "Upcoming appointments (next 2 weeks)",
      detail: upcoming.map((item) => `${item.title}, ${fmtWeekdayDate(item.start)} at ${fmtTime(item.start, item.tz)}${item.location ? ` (${item.location})` : ""}`).join("; "),
    });
  }

  const changes = state.slices.changes.data;
  if (changes?.status === "ok" && changes.changes.length) {
    points.push({ title: "Recent confirmed changes", detail: changes.changes.map((c) => c.summary).join("; ") });
  }

  const active = (state.slices.medications.data || []).filter((m) => m.status === "active");
  if (active.length) {
    points.push({ title: "Current confirmed medications", detail: active.map((m) => [m.name, m.strength].filter(Boolean).join(" ")).join("; ") });
  }

  const pending = (state.slices.documents.data || []).filter((d) => d.status !== "confirmed");
  if (pending.length) {
    points.push({ title: "Documents not yet confirmed", detail: `${pending.length} document${pending.length === 1 ? "" : "s"} shared but not yet confirmed by ${first}, so not included above.` });
  }
  return points;
}

export function createChanges(root) {
  const head = el("div", "page-head");
  const headText = el("div");
  const title = el("h1", "page-title", "Changes");
  title.tabIndex = -1;
  const sub = el("p", "page-sub");
  headText.append(title, sub);
  head.append(headText);

  const changesSection = el("section", "section");
  const talkSection = el("section", "section");
  const historySection = el("section", "section");
  root.append(head, changesSection, talkSection, historySection);

  function renderChanges() {
    const slice = state.slices.changes;
    changesSection.replaceChildren(el("div", "section-head", ""));
    changesSection.firstChild.append(el("h2", "section-title", "What changed"));
    if (isLoading(slice)) return changesSection.append(skeletons(3));
    if (slice.status === "error") return changesSection.append(errorState(`Couldn't load changes. ${slice.error}`, () => reload(["changes"])));
    const data = slice.data;
    const first = parentFirstName();
    if (data.status === "ok" && data.changes.length) {
      const ul = el("ul", "");
      data.changes.forEach((change) => ul.append(changeRow(change)));
      changesSection.append(ul);
      const sources = data.sources || [];
      if (sources.length === 2) {
        const when = (s) => (s.reviewedAt ? fmtDate(new Date(s.reviewedAt)) : "earlier");
        changesSection.append(el("p", "record-note", `Compared "${sources[1].documentName}" (confirmed ${when(sources[1])}) with "${sources[0].documentName}" (confirmed ${when(sources[0])}). Only documents ${first} confirmed are compared.`));
      }
    } else if (data.status === "no_changes") {
      changesSection.append(emptyState("circle-check-big", "No differences", `Nothing differs between the last two documents ${first} confirmed.`));
    } else if (data.status === "not_enough_history") {
      changesSection.append(emptyState("history", "Not enough history yet", `Changes appear once ${first} has confirmed two documents. So far: ${data.documentCount} confirmed.`));
    } else {
      changesSection.append(emptyState("circle-alert", "Couldn't compare the records", "The last two confirmed records weren't in a format that can be compared."));
    }
  }

  function renderTalking() {
    const points = buildTalkingPoints();
    talkSection.replaceChildren();
    const headRow = el("div", "section-head");
    headRow.append(el("h2", "section-title", "Talking points"));
    const actions = el("div", "head-actions no-print");
    const copy = el("button", "btn btn-secondary btn-sm", "");
    copy.type = "button";
    copy.append(icon("copy"), document.createTextNode("Copy"));
    const print = el("button", "btn btn-secondary btn-sm", "");
    print.type = "button";
    print.append(icon("printer"), document.createTextNode("Print"));
    actions.append(copy, print);
    headRow.append(actions);
    talkSection.append(headRow);
    talkSection.append(el("p", "record-note", "Built from confirmed records and open requests, for your next conversation or doctor visit."));

    if (points.length === 0) {
      talkSection.append(emptyState("clipboard-list", "Nothing to prepare yet", "Talking points appear once there are confirmed records, upcoming appointments or open requests."));
      copy.disabled = true;
      print.disabled = true;
    } else {
      const ol = el("ol", "talk-list");
      points.forEach((point) => {
        const li = el("li");
        const body = el("div");
        body.append(el("strong", "", point.title), el("p", "", point.detail));
        li.append(body);
        ol.append(li);
      });
      talkSection.append(ol);
    }

    copy.addEventListener("click", async () => {
      const text = [`Talking points for ${parentFirstName()} (${fmtDate(new Date())})`, ...points.map((p, i) => `${i + 1}. ${p.title}: ${p.detail}`)].join("\n");
      try {
        await navigator.clipboard.writeText(text);
        showToast("Talking points copied.");
      } catch {
        showToast("Couldn't copy automatically. Select the text and copy it instead.", true);
      }
    });
    print.addEventListener("click", () => window.print());
  }

  function renderHistory() {
    const slice = state.slices.documents;
    historySection.replaceChildren();
    const headRow = el("div", "section-head no-print");
    headRow.append(el("h2", "section-title", "Confirmed documents"));
    historySection.append(headRow);
    historySection.classList.add("no-print");
    if (isLoading(slice)) return historySection.append(skeletons(2));
    if (slice.status === "error") return historySection.append(errorState(`Couldn't load documents. ${slice.error}`, () => reload(["documents"])));
    const confirmed = slice.data.filter((d) => d.status === "confirmed").sort((a, b) => String(b.reviewedAt).localeCompare(String(a.reviewedAt)));
    if (confirmed.length === 0) return historySection.append(emptyState("file-check", "Nothing confirmed yet", `A document appears here after ${parentFirstName()} confirms it.`));
    const ul = el("ul", "");
    confirmed.forEach((doc) => {
      const li = el("li", "doc");
      const text = el("div");
      const row = el("div", "doc-title");
      row.append(document.createTextNode(formatDocType(doc.documentType)), chip("ok", "check", doc.reviewedAt ? `Confirmed ${fmtDate(new Date(doc.reviewedAt))}` : "Confirmed"));
      text.append(row, el("p", "doc-sub", doc.documentName));
      li.append(text);
      ul.append(li);
    });
    historySection.append(ul);
  }

  function render() {
    sub.textContent = `What's different between the last two documents ${parentFirstName()} confirmed, and talking points for your next visit.`;
    renderChanges();
    renderTalking();
    renderHistory();
  }

  return { title: "Changes", render };
}
