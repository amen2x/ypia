// ElevenLabs voice conversation for the parent home page.
//
// This is the original voice logic from parent.html, moved here unchanged in
// behaviour: same signed-url request, same dynamic variables, same client
// tools and API calls, same register/sync of the conversation. Only the UI it
// drives changed: it now updates the reusable Y.P.I.A orb and a status line.

import { Conversation } from "https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.25.0/+esm";
import { createConversationSync } from "/static/js/voice-conversation-sync.mjs";

const COPY = {
  idle: { status: "Tap to start talking", hint: "You can say things like “What’s my next appointment?” or “Show my medications.”" },
  connecting: { status: "Getting ready…", hint: "One moment." },
  listening: { status: "I’m listening…", hint: "Just speak. Tap again when you’re done." },
  thinking: { status: "Let me think…", hint: "" },
  speaking: { status: "Speaking…", hint: "Tap to stop." },
};

// Local development only: show a technical hint (names and codes, never secrets) under the friendly message.
const DEV = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);

// What we tell the parent, and (in development) what to check. Nothing here can contain a secret.
const FAILURES = {
  app_unreachable: { status: "Can\u2019t reach Y.P.I.A.", hint: "Check your internet connection, then tap to try again.", dev: "The page could not reach its own server (is Flask running on port 5000?)." },
  backend_unavailable: { status: "Y.P.I.A.\u2019s server isn\u2019t running", hint: "Please let your caregiver know, then tap to try again.", dev: "Flask is up but the backend is not answering (is Express running on port 3000? start it from the backend folder)." },
  not_configured: { status: "Voice isn\u2019t set up yet", hint: "Please let your caregiver know.", dev: "ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID is missing on the backend (check backend/.env and that npm start ran from backend/)." },
  elevenlabs_auth: { status: "The voice service isn\u2019t accepting this app", hint: "Please let your caregiver know.", dev: "ElevenLabs credentials/configuration appear invalid or rejected." },
  elevenlabs_agent: { status: "The voice assistant isn\u2019t available", hint: "Please let your caregiver know.", dev: "ElevenLabs could not find or accept the configured agent id." },
  elevenlabs_rate_limited: { status: "The voice service is busy", hint: "Wait a moment, then tap to try again.", dev: "ElevenLabs rate limit or quota reached." },
  elevenlabs_unavailable: { status: "The voice service had a problem", hint: "Wait a moment, then tap to try again.", dev: "ElevenLabs returned a server error." },
  elevenlabs_unreachable: { status: "Couldn\u2019t reach the voice service", hint: "Check your internet connection, then tap to try again.", dev: "The backend could not reach api.elevenlabs.io." },
  no_signed_url: { status: "Couldn\u2019t start the voice session", hint: "Wait a moment, then tap to try again.", dev: "ElevenLabs answered without a session link." },
  bad_response: { status: "Couldn\u2019t start the voice session", hint: "Wait a moment, then tap to try again.", dev: "The signed-url response was missing a signedUrl field holding a websocket address." },
  connect_failed: { status: "Couldn\u2019t connect", hint: "Check your internet connection, then tap to try again.", dev: "The ElevenLabs SDK could not open its WebSocket connection." },
  server_error: { status: "Couldn\u2019t connect", hint: "Wait a moment, then tap to try again.", dev: "The signed-url request failed with an unexpected server error." },
  no_microphone: { status: "No microphone found", hint: "Plug in or turn on a microphone, then tap to try again.", dev: "getUserMedia: no audio input device." },
  microphone_failed: { status: "Couldn\u2019t use the microphone", hint: "Close other apps that might be using it, then tap to try again.", dev: "getUserMedia failed for a reason other than permission." },
};

// The ElevenLabs agent's create_caregiver_action schema marks every field as required, so for "no date"
// it sends an empty string (or a placeholder word) instead of leaving the field out. Those are not dates:
// treat them as "not provided". Anything else, including values of the wrong type, is passed through
// untouched so the server still validates it. A real date is never guessed here.
const NOT_PROVIDED = new Set(["none", "null", "undefined", "n/a", "na", "unknown", "unspecified", "not specified", "not provided", "no date", "no time", "-", "\u2014"]);

function omitPlaceholder(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "" || NOT_PROVIDED.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

// What the agent is told when a request could not be saved. It always says plainly that nothing was
// sent, so the agent cannot truthfully tell the parent otherwise.
function requestFailureMessage(status) {
  const base = "so the request was NOT sent. Do not tell the parent it was sent.";
  if (status === 400) return `Y.P.I.A. could not use the details of that request, ${base}`;
  if (status === 404) return `Y.P.I.A. could not find this parent's account, ${base}`;
  return `Y.P.I.A. could not save that request right now, ${base}`;
}

class VoiceSetupError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

// Strips anything that could be a URL or token before an error is logged.
const safeError = (error) =>
  `${error?.name || "Error"}: ${String(error?.message || error || "").replace(/\b(?:wss?|https?):\/\/\S+/gi, "<url>").replace(/[A-Za-z0-9_\-]{32,}/g, "<redacted>").slice(0, 140)}`;

async function requestSignedUrl() {
  let response;
  try {
    response = await fetch("/api/elevenlabs/signed-url");
  } catch {
    throw new VoiceSetupError("app_unreachable");
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 503 || (body && typeof body.error === "string" && body.error.startsWith("Backend proxy error"))) {
      throw new VoiceSetupError("backend_unavailable");
    }
    throw new VoiceSetupError(body && FAILURES[body.code] ? body.code : "server_error");
  }
  if (!body || typeof body.signedUrl !== "string" || !/^wss?:\/\//.test(body.signedUrl)) throw new VoiceSetupError("bad_response");
  return body.signedUrl;
}

export function initVoice({ orb, statusEl, hintEl, cardEl, user }) {
  let conversation = null;
  let activeConversationId = null;
  let activeSession = null;
  let currentMode = "listening";
  let orbAnimationFrame = null;
  const syncConversation = createConversationSync();
  // Requests already sent (or being sent) in this page session, so an agent retry never creates a second one.
  const sentRequests = new Map();

  function show(state, status, hint) {
    const copy = COPY[state];
    orb.setState(state);
    statusEl.textContent = status ?? copy?.status ?? "";
    hintEl.textContent = hint ?? copy?.hint ?? "";
    cardEl.classList.toggle("is-error", state === "error");
  }

  // One place that turns a failure kind into the error state (and, locally, a technical hint).
  function showFailure(kind, error) {
    const failure = FAILURES[kind] || FAILURES.server_error;
    if (DEV) console.warn(`[voice] ${kind}${error && !(error instanceof VoiceSetupError) ? ` - ${safeError(error)}` : ""}`);
    show("error", failure.status, DEV ? `${failure.hint} (${failure.dev})` : failure.hint);
  }

  function animateOrb() {
    let volume = 0;
    if (conversation) {
      try {
        volume = currentMode === "speaking" ? conversation.getOutputVolume() : conversation.getInputVolume();
      } catch {
        volume = 0;
      }
    }
    orb.setLevel(volume);
    orbAnimationFrame = requestAnimationFrame(animateOrb);
  }

  function startOrbAnimation() {
    if (orbAnimationFrame) return;
    orbAnimationFrame = requestAnimationFrame(animateOrb);
  }

  function stopOrbAnimation() {
    if (orbAnimationFrame) {
      cancelAnimationFrame(orbAnimationFrame);
      orbAnimationFrame = null;
    }
    orb.setLevel(0);
  }

  function reset() {
    conversation = null;
    activeConversationId = null;
    stopOrbAnimation();
    show("idle");
  }

  async function registerConversation(userId, conversationId) {
    try {
      await fetch("/api/parent/voice-conversations/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, conversationId }),
      });
    } catch {
      // Non-fatal: the conversation can still be synced later if this retries.
    }
  }

  function finishConversation(session) {
    if (session.finished) return;
    session.finished = true;
    if (activeSession === session) {
      activeSession = null;
      reset();
    }

    const endedConversationId = session.id;
    if (user?.id && endedConversationId) {
      // A short call can end before registration finishes. UI cleanup never waits.
      void session.registration.then(() => syncConversation(user.id, endedConversationId));
    }
  }

  async function startConversation() {
    if (activeSession) return;
    const session = { id: null, connection: null, registration: Promise.resolve(), ending: false, finished: false };
    activeSession = session;
    show("connecting");

    try {
      const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      permissionStream.getTracks().forEach((track) => track.stop());
    } catch (error) {
      finishConversation(session);
      if (DEV) console.warn("[voice] microphone:", safeError(error));
      if (error?.name === "NotFoundError" || error?.name === "OverconstrainedError") showFailure("no_microphone");
      else if (error?.name === "NotAllowedError" || error?.name === "SecurityError") show("error", "Microphone access denied", "Please allow the microphone in your browser, then tap to try again.");
      else showFailure("microphone_failed");
      return;
    }

    try {
      const signedUrl = await requestSignedUrl();

      session.connection = await Conversation.startSession({
        signedUrl,
        dynamicVariables: {
          user_id: user?.id ?? "",
          parent_name: user?.fullName ?? "",
        },
        clientTools: {
          get_next_appointment: async () => {
            if (!user?.id) {
              return { status: "error", message: "No logged-in parent found." };
            }

            try {
              const apiResponse = await fetch(
                `/api/parent/next-appointment?userId=${encodeURIComponent(user.id)}`
              );
              if (!apiResponse.ok) {
                return { status: "error", message: "Could not retrieve appointment information right now." };
              }

              const data = await apiResponse.json();
              if (!data.appointment) {
                return { status: "none", message: "No upcoming appointment is currently recorded." };
              }

              return { status: "ok", appointment: data.appointment };
            } catch {
              return { status: "error", message: "Could not retrieve appointment information right now." };
            }
          },
          get_current_medications: async () => {
            if (!user?.id) {
              return { status: "error", message: "No logged-in parent found." };
            }

            try {
              const apiResponse = await fetch(
                `/api/parent/current-medications?userId=${encodeURIComponent(user.id)}`
              );
              if (!apiResponse.ok) {
                return { status: "error", message: "Could not retrieve medication information right now." };
              }

              const data = await apiResponse.json();
              if (!data.medications || data.medications.length === 0) {
                return { status: "none", message: "No active medications are currently recorded." };
              }

              return { status: "ok", medications: data.medications };
            } catch {
              return { status: "error", message: "Could not retrieve medication information right now." };
            }
          },
          get_latest_changes: async () => {
            if (!user?.id) {
              return { status: "error", message: "No logged-in parent found." };
            }

            try {
              const apiResponse = await fetch(
                `/api/parent/latest-changes?userId=${encodeURIComponent(user.id)}`
              );
              if (!apiResponse.ok) {
                return { status: "error", message: "Could not retrieve recent changes right now." };
              }

              const data = await apiResponse.json();
              if (data.status === "not_enough_history") {
                return { status: "none", message: "There isn't enough document history yet to compare changes." };
              }
              if (data.status === "malformed_history") {
                return { status: "error", message: "Recent records could not be compared right now." };
              }
              if (data.status === "no_changes" || !data.changes || data.changes.length === 0) {
                return { status: "none", message: "No changes were found between your two most recent records." };
              }

              return { status: "ok", changes: data.changes };
            } catch {
              return { status: "error", message: "Could not retrieve recent changes right now." };
            }
          },
          get_parent_background: async () => {
            if (!user?.id) {
              return { status: "error", message: "No logged-in parent found." };
            }

            try {
              const apiResponse = await fetch(
                `/api/parent/background?userId=${encodeURIComponent(user.id)}`
              );
              if (!apiResponse.ok) {
                return { status: "error", message: "Could not retrieve background information right now." };
              }

              const data = await apiResponse.json();
              const memories = Array.isArray(data.memories) ? data.memories : [];
              if (data.status !== "ok" || (!data.background && memories.length === 0)) {
                return { status: "none", message: "Y.P.I.A does not currently have background information for you." };
              }

              return { status: "ok", name: data.name, background: data.background, memories };
            } catch {
              return { status: "error", message: "Could not retrieve background information right now." };
            }
          },
          get_parent_schedule: async ({ range } = {}) => {
            if (!user?.id) {
              return { status: "error", message: "No logged-in parent found." };
            }

            const allowedRanges = ["today", "tomorrow", "week", "upcoming"];
            if (!allowedRanges.includes(range)) {
              return { status: "error", message: "range must be one of: today, tomorrow, week, upcoming." };
            }

            let timezone = "America/Chicago";
            try {
              timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || timezone;
            } catch {
              // Keep the fallback.
            }

            try {
              const apiResponse = await fetch(
                `/api/parent/schedule?userId=${encodeURIComponent(user.id)}&range=${encodeURIComponent(range)}&timezone=${encodeURIComponent(timezone)}`
              );
              if (!apiResponse.ok) {
                return { status: "error", message: "Could not retrieve schedule information right now." };
              }

              const data = await apiResponse.json();
              if (!data.events || data.events.length === 0) {
                return { status: "none", message: "No schedule events were found for that time range.", range };
              }

              return { status: "ok", range, events: data.events };
            } catch {
              return { status: "error", message: "Could not retrieve schedule information right now." };
            }
          },
          create_caregiver_action: async ({ text, appointmentId, scheduledDate, scheduledTime, scheduledEndTime } = {}) => {
            if (!user?.id) {
              return { status: "error", message: "No logged-in parent was found, so the request was NOT sent. Do not tell the parent it was sent." };
            }
            if (!text || typeof text !== "string" || !text.trim()) {
              return { status: "error", message: "No request text was provided, so the request was NOT sent. Do not tell the parent it was sent." };
            }

            const payload = {
              userId: user.id,
              text: text.trim(),
              conversationId: activeConversationId,
              appointmentId: typeof appointmentId === "string" ? omitPlaceholder(appointmentId) : null,
              scheduledDate: omitPlaceholder(scheduledDate),
              scheduledTime: omitPlaceholder(scheduledTime),
              scheduledEndTime: omitPlaceholder(scheduledEndTime),
            };

            // The same request twice (an agent retry, or a second call while the first is in flight) is one request.
            // Only inside a conversation: with no conversation id two identical requests are not known to be a retry.
            const key = JSON.stringify([payload.conversationId, payload.text.toLowerCase(), payload.appointmentId, payload.scheduledDate, payload.scheduledTime, payload.scheduledEndTime]);
            if (payload.conversationId && sentRequests.has(key)) {
              const earlier = await sentRequests.get(key);
              return earlier.status === "ok"
                ? { ...earlier, duplicate: true, message: "That exact request was already sent, so nothing new was created." }
                : earlier;
            }

            const attempt = (async () => {
              try {
                const apiResponse = await fetch("/api/parent/caregiver-actions", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload),
                });
                const data = await apiResponse.json().catch(() => null);
                if (!apiResponse.ok) return { status: "error", message: requestFailureMessage(apiResponse.status) };
                const action = data && data.action ? data.action : {};
                return {
                  status: "ok",
                  message: "The request was saved and the caregiver can now see it in Y.P.I.A.",
                  actionId: action.id,
                  duplicate: data?.status === "duplicate",
                  scheduled: Boolean(action.scheduled),
                  appointmentLinked: Boolean(action.appointmentLinked),
                };
              } catch {
                return { status: "error", message: requestFailureMessage(0) };
              }
            })();
            if (payload.conversationId) sentRequests.set(key, attempt);
            const result = await attempt;
            if (result.status !== "ok") sentRequests.delete(key); // a failed attempt may be tried again
            return result;
          },
        },
        onConnect: ({ conversationId }) => {
          if (activeSession !== session || session.finished) return;
          session.id = conversationId;
          activeConversationId = conversationId;
          currentMode = "listening";
          show("listening");
          startOrbAnimation();
          if (user?.id && conversationId) {
            session.registration = registerConversation(user.id, conversationId);
          }
        },
        onDisconnect: () => finishConversation(session),
        onModeChange: ({ mode }) => {
          if (activeSession !== session) return;
          currentMode = mode;
          show(mode === "speaking" ? "speaking" : "listening");
        },
        // The SDK has no explicit "thinking" signal. Once the parent's words
        // have been transcribed and the agent has not started speaking yet,
        // we're waiting on the agent: show the thinking state until it speaks.
        onMessage: ({ source } = {}) => {
          if (activeSession !== session || session.finished) return;
          if (source === "user" && currentMode !== "speaking") show("thinking");
        },
        onError: (message) => {
          if (activeSession !== session) return;
          if (DEV) console.warn("[voice] SDK error:", safeError(message));
          show("error", "Something went wrong", "Tap to end this call, then try again.");
        },
      });

      if (activeSession === session && !session.finished) {
        conversation = session.connection;
        orb.setBusy(false);
      }
    } catch (error) {
      if (activeSession === session) {
        finishConversation(session);
        showFailure(error instanceof VoiceSetupError ? error.kind : "connect_failed", error);
      }
    }
  }

  async function endConversation() {
    const session = activeSession;
    if (!session || session.ending) return;
    session.ending = true;
    orb.setBusy(true);
    try {
      await session.connection?.endSession();
    } catch {
      // Still restore the UI and attempt sync for the captured conversation.
    } finally {
      finishConversation(session);
    }
  }

  function press() {
    if (conversation) {
      endConversation();
    } else {
      startConversation();
    }
  }

  show("idle");
  return { press };
}
