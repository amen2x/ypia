// Every caregiver API call lives here, together with what the backend cannot tell us yet.
//
// KNOWN BACKEND LIMITATIONS (documented once, here, instead of being papered over in the UI):
//  1. GET /api/users/:id/parent returns only ONE linked parent and, when the caregiver has no
//     link at all, falls back to an arbitrary parent (`fallback: true`). It also auto-approves a
//     pending link. We call it once to keep that behaviour, ignore `fallback` results, and use
//     GET /api/caregiver/parents (approved links only) as the real list.
//  2. /api/parents/:id/schedule*, /api/parents/:id and /api/parents/:id/background* take a
//     parentId with no caregiver authorization. We only ever pass an id from the approved list.
//  3. No task priority is stored. Urgency shown in the UI is derived from explicit dates only.
//  4. Caregiver actions expose the linked appointment's title but not its id.
//  5. There is no refill, dose-taken or mood data on the server, so none is shown.
//  6. The caregiver document "preview" (POST /api/documents without a userId) reads a file with
//     Gemini and stores nothing. Documents only join the care record when the parent confirms.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, options) {
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new ApiError("Can't reach Y.P.I.A. right now. Check your connection and try again.", 0);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError((data && data.error) || `Something went wrong (${response.status})`, response.status);
  return data;
}

const query = (params) => new URLSearchParams(params).toString();
const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const enc = encodeURIComponent;

export const api = {
  // identity / linking
  linkedParent: (userId) => request(`/api/users/${enc(userId)}/parent`),
  parents: (userId) => request(`/api/caregiver/parents?${query({ userId })}`),
  parent: (parentId) => request(`/api/parents/${enc(parentId)}`),

  // schedule
  upcoming: (parentId) => request(`/api/parents/${enc(parentId)}/schedule`),
  past: (parentId) => request(`/api/parents/${enc(parentId)}/schedule/past`),
  scoreSchedule: (parentId) => request(`/api/parents/${enc(parentId)}/schedule/score`, { method: "POST" }),

  // confirmed care record
  appointments: (userId, parentId) => request(`/api/caregiver/appointments?${query({ userId, parentId })}`),
  medications: (userId, parentId) => request(`/api/caregiver/medications?${query({ userId, parentId })}`),
  changes: (userId, parentId) => request(`/api/caregiver/changes?${query({ userId, parentId })}`),
  documents: (userId) => request(`/api/caregiver/documents?${query({ userId })}`),

  // tasks and parent requests
  actions: (userId) => request(`/api/caregiver/actions?${query({ userId })}`),
  createAction: (body) => request("/api/caregiver/actions", json("POST", body)),
  setActionStatus: (actionId, userId, status) => request(`/api/caregiver/actions/${enc(actionId)}`, json("PATCH", { userId, status })),
  // Saves an explicit date (and optional start/end time) on a task; all null clears it.
  scheduleAction: (actionId, userId, { scheduledDate, scheduledTime, scheduledEndTime }) =>
    request(`/api/caregiver/actions/${enc(actionId)}/schedule`, json("PATCH", { userId, scheduledDate, scheduledTime: scheduledTime ?? null, scheduledEndTime: scheduledEndTime ?? null })),

  // notes about the parent (also what the voice assistant knows)
  saveNotes: (parentId, backgroundNotes) => request(`/api/parents/${enc(parentId)}/background`, json("PUT", { backgroundNotes })),
  uploadNotes: (parentId, file) => {
    const form = new FormData();
    form.append("file", file);
    return request(`/api/parents/${enc(parentId)}/background/upload`, { method: "PUT", body: form });
  },

  // read a document without saving it
  previewDocument: (file) => {
    const form = new FormData();
    form.append("document", file);
    return request("/api/documents", { method: "POST", body: form });
  },

  // weekly check-in streak (motivational only)
  streak: (userId) => request(`/api/streak?${query({ userId })}`),
  checkIn: (userId) => request("/api/streak/checkin", json("POST", { userId })),

  // Calendar export of ONE stored record (kind: appointment | action | schedule). The server builds the
  // event from the record's structured fields, so nothing here can export a date it guessed.
  calendarExportUrl: (kind, id, format, userId) => `/api/caregiver/calendar/${enc(kind)}/${enc(id)}?${query({ userId, format })}`,
};
