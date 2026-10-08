// Caregiver workspace shell: sign-in guard, which parent is being viewed, routing, and rendering.

import { el, icon, initialsOf, skeletons } from "./ui.js";
import { init, state, subscribe, setParent, startPolling, parentName, user } from "./store.js";
import { isParentRequest } from "./ui.js";
import { createOverview } from "./views/overview.js";
import { createTasks } from "./views/tasks.js";
import { createSchedule } from "./views/schedule.js";
import { createMedications } from "./views/medications.js";
import { createDocuments } from "./views/documents.js";
import { createChanges } from "./views/changes.js";
import { createNotes } from "./views/notes.js";

if (!user) {
  window.location.replace("/login");
} else if (user.role === "parent") {
  window.location.replace("/parent");
} else {
  start();
}

function start() {
  const $ = (id) => document.getElementById(id);

  // ---------- Views + routing ----------

  const views = {
    overview: createOverview($("view-overview")),
    tasks: createTasks($("view-tasks")),
    schedule: createSchedule($("view-schedule")),
    medications: createMedications($("view-medications")),
    documents: createDocuments($("view-documents")),
    changes: createChanges($("view-changes")),
    notes: createNotes($("view-notes")),
  };
  const currentRoute = () => (views[location.hash.slice(1)] ? location.hash.slice(1) : "overview");

  const unlinked = el("div", "unlinked");
  unlinked.hidden = true;
  $("main").prepend(unlinked);

  let routedOnce = false;

  function showRoute({ focusHeading }) {
    const name = currentRoute();
    document.querySelectorAll(".view").forEach((view) => {
      view.hidden = state.linked !== "yes" || view.dataset.view !== name;
    });
    document.querySelectorAll(".rail-link").forEach((link) => {
      if (link.dataset.route === name) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    document.title = `${views[name].title} | Y.P.I.A. Care`;
    if (state.linked === "yes") {
      views[name].render();
      if (focusHeading) {
        window.scrollTo(0, 0);
        $(`view-${name}`).querySelector("h1")?.focus({ preventScroll: true });
      }
    }
  }

  // ---------- Header: which parent, and which caregiver ----------

  function paintHeader() {
    const name = parentName();
    const loading = state.linked === "loading";
    $("parentName").textContent = loading ? "Loading…" : name || "No parent linked";
    $("parentAvatar").textContent = name ? initialsOf(name) : "–";
    const several = state.parents.length > 1;
    $("parentSwitch").disabled = !several;
    $("parentChevron").toggleAttribute("hidden", !several); // SVG elements have no .hidden property
    $("parentSwitch").setAttribute("aria-label", several ? `Viewing care for ${name}. Change parent` : `Viewing care for ${name || "no parent yet"}`);
  }

  const caregiverName = user.fullName || "Caregiver";
  $("profileName").textContent = caregiverName.trim().split(/\s+/)[0];
  $("profileAvatar").textContent = initialsOf(caregiverName) || "?";
  $("profileDialogAvatar").textContent = initialsOf(caregiverName) || "?";
  $("profileDialogName").textContent = caregiverName;
  $("profileDialogEmail").textContent = user.email || "";
  $("profileDialogEmail").hidden = !user.email;

  $("profileButton").addEventListener("click", () => $("profileDialog").showModal());
  $("logoutButton").addEventListener("click", () => {
    localStorage.removeItem("ypia_user");
    window.location.href = "/login";
  });

  $("parentSwitch").addEventListener("click", () => {
    const wrap = $("parentChoices");
    wrap.replaceChildren();
    state.parents.forEach((parent) => {
      const choice = el("button", "choice");
      choice.type = "button";
      choice.setAttribute("role", "radio");
      const selected = parent.id === state.parentId;
      choice.setAttribute("aria-checked", String(selected));
      const avatar = el("span", "avatar avatar--parent", initialsOf(parent.name));
      avatar.setAttribute("aria-hidden", "true");
      choice.append(avatar, document.createTextNode(parent.name));
      if (selected) choice.append(icon("check"));
      choice.addEventListener("click", () => {
        setParent(parent.id);
        $("parentDialog").close();
      });
      wrap.append(choice);
    });
    $("parentDialog").showModal();
    wrap.querySelector('[aria-checked="true"]')?.focus();
  });

  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => dialog.close()));
  });

  // ---------- Rendering ----------

  function paintNavCount() {
    const slice = state.slices.tasks;
    const count = slice.status === "ready" ? slice.data.filter((t) => t.status === "open" && isParentRequest(t)).length : 0;
    const badge = $("navTaskCount");
    badge.hidden = count === 0;
    badge.textContent = String(count);
    badge.setAttribute("aria-label", `${count} open request${count === 1 ? "" : "s"} from your parent`);
  }

  function paintUnlinked() {
    unlinked.replaceChildren();
    if (state.linked === "loading") {
      unlinked.hidden = false;
      unlinked.append(skeletons(4));
      return;
    }
    unlinked.hidden = state.linked === "yes";
    if (state.linked === "yes") return;
    if (state.linked === "error") {
      unlinked.append(el("h1", "", "Can't reach Y.P.I.A. right now"), el("p", "", state.linkError || "Check your connection and try again."));
      const retry = el("button", "btn btn-primary", "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => window.location.reload());
      unlinked.append(retry);
      return;
    }
    unlinked.append(
      el("h1", "", "No parent is linked to your account yet"),
      el("p", "", "To see someone's care here, sign up as a family member using your parent's Y.P.I.A. email address. Once linked, their schedule, medications, documents and requests appear in this workspace."),
      el("p", "", `You're signed in as ${caregiverName}.`)
    );
  }

  // Re-rendering rebuilds list DOM; put keyboard focus back on the same control afterwards.
  function renderAll() {
    const focusKey = document.activeElement?.dataset?.focusKey;
    paintHeader();
    paintUnlinked();
    paintNavCount();
    showRoute({ focusHeading: false });
    if (focusKey) document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }

  subscribe(renderAll);
  window.addEventListener("hashchange", () => {
    showRoute({ focusHeading: routedOnce });
  });

  paintHeader();
  showRoute({ focusHeading: false });
  routedOnce = true;

  init().then(() => {
    if (state.linked === "yes") startPolling();
  });
}
