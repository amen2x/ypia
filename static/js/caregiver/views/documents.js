// Documents: what the parent has shared, clearly separated into confirmed and awaiting confirmation.
// Extracted details are never presented as confirmed care information until the parent confirms.

import { state, parentFirstName, reload } from "../store.js";
import { api } from "../api.js";
import { chip, el, emptyState, errorState, icon, showToast, skeletons } from "../ui.js";
import { fmtDate, formatDocType } from "../format.js";

function list(title, items) {
  const frag = document.createDocumentFragment();
  if (!items.length) return frag;
  frag.append(el("h4", "", title));
  const ul = el("ul");
  items.forEach((text) => ul.append(el("li", "", text)));
  frag.append(ul);
  return frag;
}

function extractedSections(data) {
  const frag = document.createDocumentFragment();
  const d = data || {};
  frag.append(
    list("Medications", (d.medications || []).map((m) => [m.name, m.dose, m.frequency, m.status].filter(Boolean).join(" — "))),
    list("Appointments", (d.appointments || []).map((a) => [a.type, a.provider, a.date, a.time, a.location].filter(Boolean).join(" — "))),
    list("Follow-ups", (d.followUps || []).map((f) => (f.timeframe ? `${f.description} (${f.timeframe})` : f.description))),
    list("Instructions", d.instructions || [])
  );
  if (!frag.childNodes.length) frag.append(el("p", "state", "No structured details were found in this document."));
  return frag;
}

function banner(kind, text) {
  const node = el("div", kind === "wait" ? "note note--wait" : "note");
  node.append(icon(kind === "wait" ? "file-clock" : "file-check"), el("p", "", text));
  return node;
}

// A saved document: confirmed by the parent, or still an unreviewed reading of the file.
export function openDocument(doc) {
  const first = parentFirstName();
  const dialog = document.getElementById("docDialog");
  document.getElementById("docDialogTitle").textContent = `${formatDocType(doc.documentType)} · ${doc.documentName}`;
  const body = document.getElementById("docDialogBody");
  body.replaceChildren(
    doc.status === "confirmed"
      ? banner("ok", `${first} reviewed and confirmed these details${doc.reviewedAt ? ` on ${fmtDate(new Date(doc.reviewedAt))}` : ""}.`)
      : banner("wait", `Not confirmed yet. Y.P.I.A. read this from the file and it may contain mistakes. It isn't part of the care record until ${first} confirms it in the app.`),
    extractedSections(doc.extractedData)
  );
  dialog.showModal();
}

// A file read on the spot and not saved anywhere.
function openPreview(result, fileName) {
  const dialog = document.getElementById("docDialog");
  document.getElementById("docDialogTitle").textContent = `Preview · ${fileName}`;
  document.getElementById("docDialogBody").replaceChildren(
    banner("wait", `Not saved. This is a read-only preview of what Y.P.I.A. found in the file. Documents become part of the care record only after ${parentFirstName()} adds and confirms them in the app.`),
    extractedSections(result)
  );
  dialog.showModal();
}

export function createDocuments(root) {
  let filter = "all"; // "all" | "confirmed" | "pending"

  const head = el("div", "page-head");
  const headText = el("div");
  const title = el("h1", "page-title", "Documents");
  title.tabIndex = -1;
  const sub = el("p", "page-sub");
  headText.append(title, sub);
  head.append(headText);

  const tabs = el("div", "tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Filter documents");
  const tabButtons = {};
  [["all", "All"], ["confirmed", "Confirmed"], ["pending", "Awaiting confirmation"]].forEach(([value, label]) => {
    const button = el("button", "tab");
    button.type = "button";
    button.setAttribute("role", "tab");
    button.dataset.label = label;
    button.addEventListener("click", () => {
      filter = value;
      render();
    });
    tabButtons[value] = button;
    tabs.append(button);
  });

  const listWrap = el("div");
  listWrap.setAttribute("role", "tabpanel");

  // Read a file without saving anything.
  const previewSection = el("section", "section no-print");
  const previewHead = el("div", "section-head");
  previewHead.append(el("h2", "section-title", "Read a document without saving"));
  const drop = el("div", "drop");
  drop.append(el("p", "", "Take a quick look at a prescription or visit summary. It is read once and not saved. To add something to the care record, your parent confirms it in the Y.P.I.A. app."));
  const fileInput = el("input");
  Object.assign(fileInput, { type: "file", accept: ".jpg,.jpeg,.png,.pdf", hidden: true });
  fileInput.setAttribute("aria-hidden", "true");
  fileInput.tabIndex = -1;
  const readButton = el("button", "btn btn-secondary", "");
  readButton.type = "button";
  readButton.append(icon("upload"), document.createTextNode("Choose a file"));
  const previewStatus = el("p", "status-line");
  previewStatus.setAttribute("role", "status");
  drop.append(readButton, fileInput);
  previewSection.append(previewHead, drop, previewStatus);

  const listSection = el("section", "section");
  listSection.append(tabs, listWrap);
  root.append(head, listSection, previewSection);

  readButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    readButton.disabled = true;
    previewStatus.className = "status-line";
    previewStatus.textContent = "Reading the document… this can take a moment.";
    try {
      const result = await api.previewDocument(file);
      previewStatus.textContent = "";
      openPreview(result, file.name);
    } catch (error) {
      previewStatus.className = "status-line is-error";
      previewStatus.textContent = error.message || "We couldn't read that document. Try another PDF or image.";
      showToast(previewStatus.textContent, true);
    } finally {
      readButton.disabled = false;
      fileInput.value = "";
    }
  });

  function docRow(doc) {
    const confirmed = doc.status === "confirmed";
    const row = el("li", "doc");
    const text = el("div");
    const titleRow = el("div", "doc-title");
    titleRow.append(document.createTextNode(formatDocType(doc.documentType)), confirmed ? chip("ok", "check", "Confirmed") : chip("wait", "file-clock", "Awaiting confirmation"));
    const added = `Added ${fmtDate(new Date(doc.uploadedAt))}`;
    const reviewed = confirmed && doc.reviewedAt ? ` · confirmed ${fmtDate(new Date(doc.reviewedAt))}` : "";
    text.append(titleRow, el("p", "doc-sub", `${doc.documentName} · ${added}${reviewed}`));
    const view = el("button", "btn btn-secondary btn-sm", "View details");
    view.type = "button";
    view.dataset.focusKey = `doc-${doc.id}`;
    view.setAttribute("aria-label", `View details: ${formatDocType(doc.documentType)}, ${doc.documentName}`);
    view.addEventListener("click", () => openDocument(doc));
    row.append(text, view);
    return row;
  }

  function render() {
    const first = parentFirstName();
    sub.textContent = `Documents ${first} has shared. Details from a document are confirmed care information only after ${first} reviews them.`;
    const slice = state.slices.documents;
    if (slice.status === "idle" || slice.status === "loading") return listWrap.replaceChildren(skeletons(4));
    if (slice.status === "error") return listWrap.replaceChildren(errorState(`Couldn't load documents. ${slice.error}`, () => reload(["documents"])));

    const all = slice.data.slice().sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
    const counts = { all: all.length, confirmed: all.filter((d) => d.status === "confirmed").length };
    counts.pending = all.length - counts.confirmed;
    for (const [value, button] of Object.entries(tabButtons)) {
      button.replaceChildren(document.createTextNode(button.dataset.label), el("span", "count", String(counts[value])));
      button.setAttribute("aria-selected", String(filter === value));
      button.tabIndex = filter === value ? 0 : -1;
    }

    const rows = all.filter((d) => filter === "all" || (filter === "confirmed" ? d.status === "confirmed" : d.status !== "confirmed"));
    if (rows.length === 0) {
      return listWrap.replaceChildren(emptyState("file-text", filter === "all" ? "No documents yet" : "Nothing here", filter === "all" ? `Documents ${first} adds in the Y.P.I.A. app will appear here.` : "Try another filter."));
    }
    const ul = el("ul", "");
    rows.forEach((doc) => ul.append(docRow(doc)));
    listWrap.replaceChildren(ul);
  }

  return { title: "Documents", render };
}
