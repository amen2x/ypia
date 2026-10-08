// Document upload -> Gemini extraction -> review -> confirm.
//
// The request flow is the original one from parent.html, unchanged:
//   POST /api/documents (multipart: document, userId)  -> { documentId, review }
//   POST /api/documents/:id/confirm { userId, editedData } -> { status, summary }
// Only the presentation changed (native <dialog> panels, large touch targets).

import { el } from "./dom.js";

const MEDICATION_STATUS_OPTIONS = [
  { value: "started", label: "Newly started" },
  { value: "active", label: "Currently active" },
  { value: "changed", label: "Dose or frequency changed" },
  { value: "stopped", label: "Discontinued" },
  { value: "unknown", label: "Not specified in document" },
];

const REVIEW_SECTIONS = [
  {
    key: "medications",
    title: "Medications",
    fields: [
      { name: "name", label: "Medication" },
      { name: "dose", label: "Dose" },
      { name: "frequency", label: "Frequency" },
      { name: "status", label: "Status", type: "select", options: MEDICATION_STATUS_OPTIONS },
    ],
    summary: (item) => {
      const statusLabel = MEDICATION_STATUS_OPTIONS.find((o) => o.value === item.status)?.label || item.status;
      const parts = [item.dose, item.frequency].filter(Boolean).join(", ");
      return { primary: item.name || "(unnamed medication)", secondary: [parts, statusLabel].filter(Boolean).join(" · ") };
    },
  },
  {
    key: "appointments",
    title: "Appointments / Follow-up",
    fields: [
      { name: "type", label: "Type" },
      { name: "provider", label: "Provider" },
      { name: "date", label: "Date" },
      { name: "time", label: "Time" },
      { name: "location", label: "Location" },
    ],
    summary: (item) => ({
      primary: [item.type || "Appointment", item.provider ? `with ${item.provider}` : ""].filter(Boolean).join(" "),
      secondary: [item.date, item.time, item.location].filter(Boolean).join(" · "),
    }),
  },
  {
    key: "followUps",
    title: "Other Instructions",
    fields: [
      { name: "description", label: "Description" },
      { name: "timeframe", label: "Timeframe" },
    ],
    summary: (item) => ({ primary: item.description || "(no description)", secondary: item.timeframe || "" }),
  },
];

const HISTORY_LIMIT = 8;

function historyKey(userId) {
  return `ypia_doc_history_${userId}`;
}

// Documents confirmed from this device. There is no parent-facing "list my
// documents" endpoint, so this is a local record of what the parent added here.
export function loadDocumentHistory(user) {
  if (!user?.id) return [];
  try {
    const list = JSON.parse(localStorage.getItem(historyKey(user.id)) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function rememberDocument(user, entry) {
  if (!user?.id) return;
  try {
    const next = [entry, ...loadDocumentHistory(user)].slice(0, HISTORY_LIMIT);
    localStorage.setItem(historyKey(user.id), JSON.stringify(next));
  } catch {
    // Non-fatal: the history list is a convenience only.
  }
}

export function initDocuments({ user, getDisplayName, onUploadMessage, onConfirmed }) {
  let draft = null; // { documentId, documentType, documentTypeLabel, medications:[], appointments:[], followUps:[], instructions:[] }

  const uploadInput = document.createElement("input");
  uploadInput.type = "file";
  uploadInput.accept = ".jpg,.jpeg,.png,.pdf";
  uploadInput.hidden = true;
  uploadInput.setAttribute("aria-hidden", "true");
  uploadInput.tabIndex = -1;
  document.body.append(uploadInput);

  const reviewDialog = document.getElementById("reviewDialog");
  const reviewSubtitle = document.getElementById("reviewSubtitle");
  const reviewEmptyNote = document.getElementById("reviewEmptyNote");
  const reviewSections = document.getElementById("reviewSections");
  const reviewError = document.getElementById("reviewError");
  const reviewCancelButton = document.getElementById("reviewCancelButton");
  const reviewConfirmButton = document.getElementById("reviewConfirmButton");

  const successDialog = document.getElementById("successDialog");
  const successTitle = document.getElementById("successTitle");
  const successChanges = document.getElementById("successChanges");
  const successCloseButton = document.getElementById("successCloseButton");

  function openPicker() {
    uploadInput.click();
  }

  uploadInput.addEventListener("change", async () => {
    const file = uploadInput.files?.[0];
    if (!file || !user?.id) return;

    onUploadMessage("Reading your document… this can take a moment.", false);
    const formData = new FormData();
    formData.append("document", file);
    formData.append("userId", user.id);

    try {
      const response = await fetch("/api/documents", {
        method: "POST",
        body: formData,
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        onUploadMessage((data && data.error) || "We couldn't process this document. Try another PDF or image.", true);
        return;
      }

      if (!data.documentId) {
        onUploadMessage("We couldn't process this document. Try another PDF or image.", true);
        return;
      }

      onUploadMessage("", false);
      openReview(data.documentId, data.review);
    } catch {
      onUploadMessage("Something went wrong. Please try again.", true);
    } finally {
      uploadInput.value = "";
    }
  });

  function openReview(documentId, review) {
    draft = {
      documentId,
      documentType: review.documentType,
      documentTypeLabel: review.documentTypeLabel,
      medications: review.medications.map((m) => ({ name: m.name, dose: m.dose || "", frequency: m.frequency || "", status: m.status })),
      appointments: review.appointments.map((a) => ({ ...a, type: a.type || "", provider: a.provider || "", date: a.date || "", time: a.time || "", location: a.location || "" })),
      followUps: review.followUps.map((f) => ({ description: f.description, timeframe: f.timeframe || "" })),
      instructions: [...review.instructions],
    };
    reviewSubtitle.textContent = `From your ${review.documentTypeLabel.toLowerCase()}. Review the details below before adding them.`;
    reviewEmptyNote.hidden = !review.isEmpty;
    reviewError.hidden = true;
    reviewError.textContent = "";
    reviewConfirmButton.disabled = false;
    reviewConfirmButton.textContent = "Confirm & add";
    renderReviewSections();
    reviewDialog.showModal();
  }

  function closeReview() {
    if (reviewDialog.open) reviewDialog.close();
    draft = null;
  }

  function itemField(container, item, field) {
    const wrap = el("label", "review-field");
    wrap.append(el("span", "review-field-label", field.label));
    let input;
    if (field.type === "select") {
      input = document.createElement("select");
      for (const option of field.options) {
        const opt = document.createElement("option");
        opt.value = option.value;
        opt.textContent = option.label;
        if (item[field.name] === option.value) opt.selected = true;
        input.append(opt);
      }
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.value = item[field.name] || "";
    }
    input.className = "review-input";
    input.addEventListener("input", () => {
      item[field.name] = input.value;
    });
    input.addEventListener("change", () => {
      item[field.name] = input.value;
    });
    wrap.append(input);
    container.append(wrap);
  }

  function actionButton(label, className, handler) {
    const button = el("button", className, label);
    button.type = "button";
    button.addEventListener("click", handler);
    return button;
  }

  function renderItemRow(section, item) {
    const row = el("div", "review-item");
    if (item._editing) {
      const fieldsWrap = el("div", "review-fields");
      for (const field of section.fields) itemField(fieldsWrap, item, field);
      row.append(fieldsWrap);

      const actions = el("div", "review-item-actions");
      actions.append(actionButton("Done", "review-link-button", () => {
        item._editing = false;
        renderReviewSections();
      }));
      row.append(actions);
    } else {
      const summary = section.summary(item);
      const text = el("div", "review-item-text");
      text.append(el("p", "review-item-primary", summary.primary));
      if (summary.secondary) text.append(el("p", "review-item-secondary", summary.secondary));
      row.append(text);

      const actions = el("div", "review-item-actions");
      actions.append(
        actionButton("Edit", "review-link-button", () => {
          item._editing = true;
          renderReviewSections();
        }),
        actionButton("Remove", "review-link-button review-link-remove", () => {
          draft[section.key] = draft[section.key].filter((candidate) => candidate !== item);
          renderReviewSections();
        })
      );
      row.append(actions);
    }
    return row;
  }

  function renderInstructionsSection() {
    const items = draft.instructions;
    if (items.length === 0) return null;

    const section = el("div", "review-section");
    section.append(el("h3", "review-section-title", "Notes From the Document"));
    items.forEach((text, index) => {
      const row = el("div", "review-item");
      row.append(el("p", "review-item-primary", text));
      const actions = el("div", "review-item-actions");
      actions.append(actionButton("Remove", "review-link-button review-link-remove", () => {
        draft.instructions = draft.instructions.filter((_, i) => i !== index);
        renderReviewSections();
      }));
      row.append(actions);
      section.append(row);
    });
    return section;
  }

  function renderReviewSections() {
    reviewSections.replaceChildren();
    for (const section of REVIEW_SECTIONS) {
      const items = draft[section.key];
      if (items.length === 0) continue;
      const sectionEl = el("div", "review-section");
      sectionEl.append(el("h3", "review-section-title", section.title));
      items.forEach((item) => sectionEl.append(renderItemRow(section, item)));
      reviewSections.append(sectionEl);
    }
    const instructionsSection = renderInstructionsSection();
    if (instructionsSection) reviewSections.append(instructionsSection);
  }

  reviewCancelButton.addEventListener("click", closeReview);
  // Esc / backdrop close: make sure the draft is discarded like Cancel does.
  reviewDialog.addEventListener("close", () => {
    draft = null;
  });

  reviewConfirmButton.addEventListener("click", async () => {
    if (!draft || !user?.id) return;
    reviewConfirmButton.disabled = true;
    reviewConfirmButton.textContent = "Saving…";
    reviewError.hidden = true;

    const editedData = {
      documentType: draft.documentType,
      medications: draft.medications.map(({ name, dose, frequency, status }) => ({
        name, dose: dose || null, frequency: frequency || null, status,
      })),
      appointments: draft.appointments.map(({ type, provider, date, time, location }) => ({
        type: type || null, provider: provider || null, date: date || null, time: time || null, location: location || null,
      })),
      followUps: draft.followUps.map(({ description, timeframe }) => ({ description, timeframe: timeframe || null })),
      instructions: draft.instructions,
    };
    const documentId = draft.documentId;
    const documentTypeLabel = draft.documentTypeLabel;

    function failed(message) {
      reviewError.textContent = message;
      reviewError.hidden = false;
      reviewConfirmButton.disabled = false;
      reviewConfirmButton.textContent = "Confirm & add";
    }

    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, editedData }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        failed((data && data.error) || "We couldn't save this information. Please try again.");
        return;
      }

      closeReview();
      openSuccess(data);
      if (data?.status !== "already_confirmed") {
        rememberDocument(user, {
          label: documentTypeLabel || "Document",
          at: new Date().toISOString(),
          changes: Array.isArray(data?.summary) ? data.summary.length : 0,
        });
      }
      onConfirmed();
    } catch {
      failed("Something went wrong. Please try again.");
    }
  });

  function openSuccess(result) {
    const name = getDisplayName();
    successTitle.textContent =
      result.status === "already_confirmed"
        ? "This document was already added."
        : `Added to ${name === "there" ? "your" : name + "'s"} care information.`;

    successChanges.replaceChildren();
    if (result.summary && result.summary.length > 0) {
      const section = el("div", "review-section");
      section.append(el("h3", "review-section-title", "What Changed"));
      for (const change of result.summary) {
        section.append(el("p", "review-item-primary", change.summary));
      }
      successChanges.append(section);
    } else if (result.status !== "already_confirmed") {
      successChanges.append(el("p", "review-empty-note", "Nothing new to update this time — your records already reflect this."));
    }

    successDialog.showModal();
  }

  successCloseButton.addEventListener("click", () => successDialog.close());

  return { openPicker };
}
