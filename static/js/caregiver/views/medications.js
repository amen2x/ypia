// Medications: only what the parent has confirmed. Nothing is inferred from a single document.

import { state, parentFirstName, reload } from "../store.js";
import { chip, el, emptyState, errorState, icon, skeletons } from "../ui.js";
import { fmtDate } from "../format.js";

export function createMedications(root) {
  const head = el("div", "page-head");
  const headText = el("div");
  const title = el("h1", "page-title", "Medications");
  title.tabIndex = -1;
  const sub = el("p", "page-sub");
  headText.append(title, sub);
  head.append(headText);

  const note = el("div", "note");
  const body = el("div");
  note.append(icon("info"), body);
  const listWrap = el("div");
  root.append(head, note, listWrap);

  function medRow(med) {
    const row = el("li", `med${med.status === "stopped" ? " is-stopped" : ""}`);
    const name = el("div");
    name.append(el("p", "med-name", med.name));
    if (med.strength) name.append(el("p", "med-dose", med.strength));
    const how = el("div");
    how.append(el("p", "med-how", med.instructions || "No instructions on file"));
    const prov = el("div");
    const confirmed = med.confirmedAt ? `Confirmed ${fmtDate(new Date(med.confirmedAt))}` : "Confirmed";
    prov.append(med.status === "stopped" ? chip("muted", "square", "Stopped") : chip("ok", "check", "Confirmed"));
    prov.append(el("p", "med-prov", med.sourceDocumentName ? `${confirmed} · from ${med.sourceDocumentName}` : confirmed));
    row.append(name, how, prov);
    return row;
  }

  function render() {
    const first = parentFirstName();
    sub.textContent = `The medications ${first} has confirmed in the Y.P.I.A. app.`;
    body.replaceChildren();
    body.append(
      el("strong", "", "This list changes only when "),
      document.createTextNode(`${first} confirms a document. A medication isn't added because it appears in one document, and it isn't marked stopped because it's missing from another: it shows as stopped only when a confirmed document says so. Y.P.I.A. doesn't track doses taken or refills.`)
    );

    const slice = state.slices.medications;
    if (slice.status === "idle" || slice.status === "loading") return listWrap.replaceChildren(skeletons(4));
    if (slice.status === "error") return listWrap.replaceChildren(errorState(`Couldn't load medications. ${slice.error}`, () => reload(["medications"])));

    const active = slice.data.filter((m) => m.status === "active");
    const stopped = slice.data.filter((m) => m.status === "stopped");
    const frag = document.createDocumentFragment();
    if (active.length === 0) {
      frag.append(emptyState("pill", "No confirmed medications yet", `They appear once ${first} confirms a prescription or visit summary in the app.`));
    } else {
      const list = el("ul", "med-list");
      active.forEach((med) => list.append(medRow(med)));
      const wrap = el("div", "section");
      wrap.append(el("h2", "subhead", `Current · ${active.length}`), list);
      frag.append(wrap);
    }
    if (stopped.length > 0) {
      const list = el("ul", "med-list");
      stopped.forEach((med) => list.append(medRow(med)));
      const wrap = el("div", "section");
      wrap.append(el("h2", "subhead", `Stopped · ${stopped.length}`), list);
      frag.append(wrap);
    }
    listWrap.replaceChildren(frag);
  }

  return { title: "Medications", render };
}
