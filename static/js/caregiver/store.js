// Caregiver workspace state: who is signed in, which linked parent is being viewed, and one
// "slice" per kind of data (each with its own loading / ready / error state).

import { api } from "./api.js";
import { getUser } from "../parent/dom.js";

export const user = getUser();

const listeners = new Set();
const SLICE_NAMES = ["tasks", "upcoming", "past", "appointments", "medications", "changes", "documents", "profile"];

export const state = {
  linked: "loading", // "loading" | "yes" | "no" | "error"
  linkError: "",
  parents: [],
  parentId: null,
  slices: {},
};

function resetSlices() {
  for (const name of SLICE_NAMES) state.slices[name] = { status: "idle", data: null, error: "" };
}
resetSlices();

export const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const emit = () => listeners.forEach((fn) => fn(state));
// Re-render subscribers after a local-only change (e.g. a task is mid-save).
export const touch = emit;

export const currentParent = () => state.parents.find((p) => p.id === state.parentId) || null;
export const parentName = () => currentParent()?.name || "";
export const parentFirstName = () => parentName().trim().split(/\s+/)[0] || "your parent";

const preferenceKey = () => `ypia_active_parent_${user?.id}`;

const loaders = {
  // Tasks and documents come back for every linked parent; keep the selected one's.
  tasks: async () => ((await api.actions(user.id)).actions || []).filter((a) => a.parentId === state.parentId),
  documents: async () => ((await api.documents(user.id)).documents || []).filter((d) => d.parentId === state.parentId),
  upcoming: () => api.upcoming(state.parentId),
  past: () => api.past(state.parentId),
  appointments: async () => (await api.appointments(user.id, state.parentId)).appointments || [],
  medications: async () => (await api.medications(user.id, state.parentId)).medications || [],
  changes: () => api.changes(user.id, state.parentId),
  profile: () => api.parent(state.parentId),
};

async function loadSlice(name, { silent = false } = {}) {
  const slice = state.slices[name];
  const forParent = state.parentId;
  if (!forParent) return;

  if (!silent && slice.status !== "ready") {
    slice.status = "loading";
    emit();
  }

  try {
    const data = await loaders[name]();
    if (forParent !== state.parentId) return; // the parent was switched while this was in flight
    if (slice.status === "ready" && JSON.stringify(slice.data) === JSON.stringify(data)) return;
    slice.status = "ready";
    slice.data = data;
    slice.error = "";
    emit();
  } catch (error) {
    if (forParent !== state.parentId) return;
    if (silent && slice.status === "ready") return; // keep showing what we have on a background refresh
    slice.status = "error";
    slice.error = error.message || "Something went wrong.";
    emit();
  }
}

export const reload = (names, options) => Promise.all(names.map((name) => loadSlice(name, options)));
export const loadAll = () => reload(SLICE_NAMES);

export function setParent(parentId) {
  if (!state.parents.some((p) => p.id === parentId) || parentId === state.parentId) return;
  state.parentId = parentId;
  try {
    localStorage.setItem(preferenceKey(), parentId);
  } catch {
    // Preference is a convenience only.
  }
  resetSlices();
  emit();
  loadAll();
}

export async function init() {
  if (!user?.id) return;

  // Keep the existing behaviour of this call (it approves a pending link), but never trust its
  // `fallback` result: that is an arbitrary parent for an unlinked account.
  let linkedParents = [];
  let linkFailed = null;
  try {
    const link = await api.linkedParent(user.id);
    if (link && link.parentId && link.parent && !link.fallback) linkedParents = [{ id: link.parentId, name: link.parent.name }];
  } catch (error) {
    if (error.status === 0) linkFailed = error;
  }

  try {
    state.parents = ((await api.parents(user.id)).parents) || [];
  } catch (error) {
    if (error.status === 0) linkFailed = error;
    state.parents = [];
  }
  if (state.parents.length === 0) state.parents = linkedParents; // older backend without /api/caregiver/parents

  if (state.parents.length === 0 && linkFailed) {
    state.linked = "error";
    state.linkError = linkFailed.message;
    emit();
    return;
  }

  state.linked = state.parents.length > 0 ? "yes" : "no";
  let stored = null;
  try {
    stored = localStorage.getItem(preferenceKey());
  } catch {
    stored = null;
  }
  state.parentId = (state.parents.find((p) => p.id === stored) || state.parents[0] || {}).id || null;
  emit();
  if (state.parentId) loadAll();
}

export async function setTaskStatus(task, status) {
  await api.setActionStatus(task.id, user.id, status);
  await reload(["tasks"], { silent: true });
}

export async function createTask({ text, date, time }) {
  await api.createAction({
    userId: user.id,
    parentId: state.parentId,
    text,
    scheduledDate: date || null,
    scheduledTime: time || null,
  });
  await reload(["tasks"], { silent: true });
}

// Background refresh for things the parent can change while the caregiver has the page open.
export function startPolling() {
  const tick = () => {
    if (document.visibilityState === "hidden" || state.linked !== "yes") return;
    reload(["tasks", "documents"], { silent: true });
  };
  setInterval(tick, 15000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tick();
  });
}
