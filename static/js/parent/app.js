// Parent app shell: auth guard, routing, greeting, profile, and wiring of the
// voice orb, documents flow and data views.

import { el, icon, getUser, firstNameOf, initialsOf } from "./dom.js";
import { createYpiaOrb } from "./ypia-orb.js";
import { loadProfile, saveProfile, cleanNickname, displayNameFor, imageFileToAvatar } from "./profile.js";
import { initDocuments, loadDocumentHistory } from "./documents.js";
import { renderNextUp, renderMedPeek, renderMedications, renderSchedule } from "./views.js";

const user = getUser();
if (!user) {
  window.location.replace("/login");
} else if (user.role !== "parent") {
  window.location.replace("/");
} else {
  start();
}

function start() {
  const $ = (id) => document.getElementById(id);
  let profile = loadProfile(user);
  const displayName = () => displayNameFor(user, profile);

  // ---------- Avatar + greeting ----------

  function paintAvatar(node) {
    node.replaceChildren();
    if (profile.avatar) {
      const img = document.createElement("img");
      img.src = profile.avatar;
      img.alt = "";
      node.append(img);
    } else {
      node.append(icon("user-round")); // default avatar until a photo is added
    }
  }

  function paintProfile() {
    document.querySelectorAll("[data-avatar]").forEach(paintAvatar);
    $("avatarName").textContent = displayName() === "there" ? "Profile" : displayName();
    updateGreeting();
  }

  function updateGreeting() {
    const hour = new Date().getHours();
    const period = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
    const name = displayName();
    $("greeting").textContent = name === "there" ? `Good ${period}` : `Good ${period}, ${name}`;
    $("todayLine").textContent = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(new Date());
  }

  // ---------- Profile dialog ----------

  const profileDialog = $("profileDialog");
  const nicknameInput = $("nicknameInput");
  const profileMessage = $("profileMessage");
  const photoInput = $("photoInput");

  function flashProfile(text, isError) {
    profileMessage.textContent = text;
    profileMessage.className = `toast${isError ? " toast-error" : ""}`;
    profileMessage.hidden = !text;
  }

  $("avatarButton").addEventListener("click", () => {
    nicknameInput.value = profile.nickname;
    $("nicknamePlaceholder").textContent = firstNameOf(user.fullName) || "your first name";
    $("profileFullName").textContent = user.fullName || "Parent account";
    $("profileEmail").textContent = user.email || "";
    $("profileEmail").hidden = !user.email;
    $("removePhotoButton").hidden = !profile.avatar;
    flashProfile("", false);
    profileDialog.showModal();
  });
  $("profileCloseButton").addEventListener("click", () => profileDialog.close());

  $("changePhotoButton").addEventListener("click", () => photoInput.click());
  photoInput.addEventListener("change", async () => {
    const file = photoInput.files?.[0];
    photoInput.value = "";
    if (!file) return;
    try {
      const avatar = await imageFileToAvatar(file);
      const next = { ...profile, avatar };
      if (!saveProfile(user, next)) {
        flashProfile("We couldn't save that photo on this device. Please try a smaller one.", true);
        return;
      }
      profile = next;
      $("removePhotoButton").hidden = false;
      paintProfile();
      flashProfile("Photo updated.", false);
    } catch (error) {
      flashProfile(error.message, true);
    }
  });

  $("removePhotoButton").addEventListener("click", () => {
    const next = { ...profile, avatar: "" };
    if (saveProfile(user, next)) {
      profile = next;
      $("removePhotoButton").hidden = true;
      paintProfile();
      flashProfile("Photo removed.", false);
    }
  });

  $("nicknameForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const next = { ...profile, nickname: cleanNickname(nicknameInput.value) };
    if (!saveProfile(user, next)) {
      flashProfile("We couldn't save that on this device.", true);
      return;
    }
    profile = next;
    paintProfile();
    flashProfile(profile.nickname ? `Great — I'll call you ${profile.nickname}.` : "Okay — I'll use your first name.", false);
  });

  $("logoutButton").addEventListener("click", () => {
    localStorage.removeItem("ypia_user");
    window.location.href = "/login";
  });

  // Close any dialog when its backdrop is clicked.
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog && dialog.id !== "reviewDialog") dialog.close();
    });
  });

  // ---------- Streak ----------

  async function loadStreak() {
    try {
      const response = await fetch(`/api/parent/streak?userId=${encodeURIComponent(user.id)}`);
      if (!response.ok) return;
      const data = await response.json();
      if (data.streak > 0) {
        $("streakCount").textContent = data.streak;
        $("streakDisplay").hidden = false;
      }
    } catch {
      // Non-fatal: streak just won't show if this fails.
    }
  }

  // ---------- Documents ----------

  const uploadToast = $("uploadToast");
  let toastTimer = null;
  function showUploadMessage(message, isError) {
    clearTimeout(toastTimer);
    uploadToast.textContent = message;
    uploadToast.className = `toast${isError ? " toast-error" : ""}`;
    uploadToast.hidden = !message;
    if (message && isError) toastTimer = setTimeout(() => { uploadToast.hidden = true; }, 7000);
  }

  function renderDocumentHistory() {
    const list = $("docHistory");
    const entries = loadDocumentHistory(user);
    list.replaceChildren();
    if (entries.length === 0) {
      list.append(el("p", "state-msg", "Documents you add on this device will be listed here."));
      return;
    }
    const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    for (const entry of entries) {
      const item = el("div", "history-item");
      item.append(el("strong", "", entry.label));
      const changes = entry.changes ? ` · ${entry.changes} update${entry.changes === 1 ? "" : "s"}` : "";
      item.append(el("span", "", `${fmt.format(new Date(entry.at))}${changes}`));
      list.append(item);
    }
  }

  const documents = initDocuments({
    user,
    getDisplayName: displayName,
    onUploadMessage: showUploadMessage,
    onConfirmed: () => {
      renderDocumentHistory();
      loaded.delete("medications");
      loaded.delete("schedule");
      renderNextUp($("nextUp"), user);
      renderMedPeek($("homeMeds"), user);
    },
  });
  document.querySelectorAll("[data-action='upload']").forEach((node) => {
    node.addEventListener("click", () => {
      if (location.hash !== "#documents") location.hash = "documents";
      documents.openPicker();
    });
  });

  // ---------- Voice orb ----------

  const pill = $("voicePill");
  const live = $("voiceLive");
  let interacted = false;
  let orbState = "idle";
  const press = () => {
    interacted = true;
    voice?.press();
  };

  // The pill is the one real, keyboard-accessible control. Its accessible name starts
  // with the visible text (so voice-control users can say it) and adds the action.
  function syncPill() {
    const state = orbState;
    const status = $("voiceStatus").textContent.trim();
    const action = state === "error" ? "Press to try again" : ["listening", "thinking", "speaking"].includes(state) ? "Press to end the conversation" : "";
    pill.setAttribute("aria-label", action ? `${status}. ${action}` : status);
  }

  // The orb is decorative (aria-hidden, not a tab stop) and triggers the same action on click.
  const orb = createYpiaOrb({
    decorative: true,
    onPress: press,
    onChange: ({ state, disabled }) => {
      orbState = state;
      pill.disabled = disabled;
      syncPill();
    },
  });
  $("orbSlot").append(orb.element);
  pill.addEventListener("click", press);

  // Announce state changes once the parent has used the control (not on page load).
  const announcer = new MutationObserver(() => {
    syncPill();
    if (!interacted) return;
    const hint = orbState === "error" ? $("voiceHint").textContent.trim() : "";
    live.textContent = [$("voiceStatus").textContent.trim(), hint].filter(Boolean).join(". ");
  });
  // Observe only the visible status + hint (never the live region itself, which would loop).
  for (const node of [$("voiceStatus"), $("voiceHint")]) {
    announcer.observe(node, { childList: true, characterData: true, subtree: true });
  }
  syncPill();
  let voice = null;
  import("./voice.js")
    .then(({ initVoice }) => {
      voice = initVoice({ orb, statusEl: $("voiceStatus"), hintEl: $("voiceHint"), cardEl: $("companion"), user });
    })
    .catch(() => {
      orb.setState("error", { label: "Voice is unavailable right now" });
      $("voiceStatus").textContent = "Voice isn't available right now";
      $("voiceHint").textContent = "Check your internet connection and refresh the page.";
      $("companion").classList.add("is-error");
    });

  // ---------- Schedule tabs ----------

  let scheduleRange = "today";
  const tabs = [...document.querySelectorAll("#scheduleTabs [role='tab']")];
  function selectTab(tab, focus) {
    tabs.forEach((t) => {
      t.setAttribute("aria-selected", String(t === tab));
      t.tabIndex = t === tab ? 0 : -1;
    });
    if (focus) tab.focus();
    scheduleRange = tab.dataset.range;
    renderSchedule($("scheduleList"), user, scheduleRange);
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(tab, false));
    tab.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      selectTab(tabs[(index + step + tabs.length) % tabs.length], true);
    });
  });

  // ---------- Games ----------

  function prepareGames() {
    // Same call the games page makes: let trivia start preparing in the background.
    fetch("/api/trivia/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id }),
    }).catch(() => {});
  }

  // ---------- Router ----------

  const ROUTES = {
    home: { title: "Home", load: () => { renderNextUp($("nextUp"), user); renderMedPeek($("homeMeds"), user); } },
    medications: { title: "Medications", load: () => renderMedications($("medList"), user) },
    schedule: { title: "Schedule", load: () => renderSchedule($("scheduleList"), user, scheduleRange) },
    documents: { title: "Documents", load: renderDocumentHistory },
    games: { title: "Games", load: prepareGames },
  };
  const loaded = new Set();

  const currentRoute = () => (ROUTES[location.hash.slice(1)] ? location.hash.slice(1) : "home");

  function route() {
    const name = currentRoute();
    document.querySelectorAll(".view").forEach((view) => { view.hidden = view.id !== `view-${name}`; });
    document.querySelectorAll(".nav-link").forEach((link) => {
      if (link.dataset.route === name) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    document.title = `${ROUTES[name].title} | Y.P.I.A`;

    // One companion for the whole app: large on Home, a small dock elsewhere.
    // Moving the same element keeps the orb state and any live call intact.
    const onHome = name === "home";
    $("main").classList.toggle("is-home", onHome);
    $("companion").classList.toggle("companion--dock", !onHome);
    $("companionDock").hidden = onHome;
    (onHome ? $("companionHome") : $("companionDock")).append($("companion"));
    if (!loaded.has(name)) {
      loaded.add(name);
      ROUTES[name].load();
    }
    window.scrollTo(0, 0);
    const heading = $(`view-${name}`).querySelector("h1");
    if (heading && routedOnce) heading.focus({ preventScroll: true });
    routedOnce = true;
  }
  let routedOnce = false;

  window.addEventListener("hashchange", route);

  // Refresh data when the parent comes back to the tab.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    loaded.clear();
    const name = currentRoute();
    loaded.add(name);
    ROUTES[name].load();
  });

  paintProfile();
  setInterval(updateGreeting, 60000);
  loadStreak();
  route();
}
