// Notes: what the parent enjoys and how they like their day. Y.P.I.A. also draws on these notes
// when the parent talks with it. Saving and file upload behave as they always have.

import { state, parentFirstName, reload } from "../store.js";
import { api } from "../api.js";
import { el, errorState, icon, showToast, skeletons } from "../ui.js";

export function createNotes(root) {
  let editing = false;

  const head = el("div", "page-head");
  const headText = el("div");
  const title = el("h1", "page-title", "Notes");
  title.tabIndex = -1;
  const sub = el("p", "page-sub");
  headText.append(title, sub);
  head.append(headText);

  const bodyWrap = el("section", "section");
  const display = el("p", "");
  display.style.whiteSpace = "pre-wrap";
  display.style.maxWidth = "46rem";
  const emptyText = el("p", "state", "");

  const editForm = el("form", "");
  editForm.noValidate = true;
  const field = el("div", "field");
  const label = el("label", "", "Notes");
  label.htmlFor = "notesText";
  const textarea = el("textarea", "input");
  textarea.id = "notesText";
  textarea.rows = 8;
  textarea.style.maxWidth = "46rem";
  field.append(label, textarea);
  const editActions = el("div", "head-actions");
  editActions.style.marginTop = "0.8rem";
  const cancel = el("button", "btn btn-secondary", "Cancel");
  cancel.type = "button";
  const save = el("button", "btn btn-primary", "Save notes");
  save.type = "submit";
  editActions.append(save, cancel);
  editForm.append(field, editActions);

  const viewActions = el("div", "head-actions");
  viewActions.style.marginTop = "1rem";
  const edit = el("button", "btn btn-primary", "");
  edit.type = "button";
  edit.append(icon("notebook-pen"), document.createTextNode("Edit notes"));
  const upload = el("button", "btn btn-secondary", "");
  upload.type = "button";
  upload.append(icon("upload"), document.createTextNode("Upload a text file"));
  const fileInput = el("input");
  Object.assign(fileInput, { type: "file", accept: ".txt,.json,.md,.csv,text/plain,application/json,text/markdown", hidden: true });
  fileInput.setAttribute("aria-hidden", "true");
  fileInput.tabIndex = -1;
  viewActions.append(edit, upload, fileInput);

  const status = el("p", "status-line");
  status.setAttribute("role", "status");
  root.append(head, bodyWrap, status);

  function setStatus(text, kind = "") {
    status.className = `status-line${kind ? ` is-${kind}` : ""}`;
    status.textContent = text;
  }

  edit.addEventListener("click", () => {
    editing = true;
    textarea.value = state.slices.profile.data?.background_notes || "";
    render();
    textarea.focus();
  });
  cancel.addEventListener("click", () => {
    editing = false;
    setStatus("");
    render();
    edit.focus();
  });

  editForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    setStatus("Saving…");
    try {
      await api.saveNotes(state.parentId, textarea.value);
      await reload(["profile"], { silent: true });
      editing = false;
      setStatus("Notes saved.", "ok");
      showToast("Notes saved.");
      render();
      edit.focus();
    } catch (error) {
      setStatus(`Couldn't save. ${error.message}`, "error");
    } finally {
      save.disabled = false;
    }
  });

  upload.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    upload.disabled = true;
    setStatus("Uploading and saving…");
    try {
      await api.uploadNotes(state.parentId, file);
      await reload(["profile"], { silent: true });
      setStatus("Uploaded and saved.", "ok");
      showToast("Notes uploaded.");
    } catch (error) {
      setStatus(error.message || "Upload failed. Try a .txt, .json or .md file.", "error");
    } finally {
      upload.disabled = false;
      fileInput.value = "";
    }
  });

  function render() {
    const first = parentFirstName();
    sub.textContent = `What ${first} enjoys, daily routines and background. Y.P.I.A. also uses these notes when ${first} talks with it.`;
    textarea.placeholder = `What ${first} enjoys, hobbies, food preferences, daily routine…`;
    const slice = state.slices.profile;
    if (slice.status === "idle" || slice.status === "loading") return bodyWrap.replaceChildren(skeletons(3));
    if (slice.status === "error") return bodyWrap.replaceChildren(errorState(`Couldn't load notes. ${slice.error}`, () => reload(["profile"])));
    if (editing) return bodyWrap.replaceChildren(editForm);
    const notes = (slice.data.background_notes || "").trim();
    if (notes) {
      display.textContent = notes;
      bodyWrap.replaceChildren(display, viewActions);
    } else {
      emptyText.textContent = `No notes yet. Add what ${first} enjoys, hobbies or preferences, or upload a text file.`;
      bodyWrap.replaceChildren(emptyText, viewActions);
    }
  }

  return { title: "Notes", render };
}
