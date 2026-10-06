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

export function initVoice({ orb, statusEl, hintEl, cardEl, user }) {
  let conversation = null;
  let activeConversationId = null;
  let activeSession = null;
  let currentMode = "listening";
  let orbAnimationFrame = null;
  const syncConversation = createConversationSync();

  function show(state, status, hint) {
    const copy = COPY[state];
    orb.setState(state);
    statusEl.textContent = status ?? copy?.status ?? "";
    hintEl.textContent = hint ?? copy?.hint ?? "";
    cardEl.classList.toggle("is-error", state === "error");
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
    } catch {
      finishConversation(session);
      show("error", "Microphone access denied", "Please allow the microphone in your browser, then tap to try again.");
      return;
    }

    try {
      const response = await fetch("/api/elevenlabs/signed-url");
      if (!response.ok) throw new Error("signed-url request failed");
      const { signedUrl } = await response.json();

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
              return { status: "error", message: "No logged-in parent found." };
            }
            if (!text || typeof text !== "string" || !text.trim()) {
              return { status: "error", message: "No request text was provided." };
            }

            try {
              const apiResponse = await fetch("/api/parent/caregiver-actions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  userId: user.id,
                  text: text.trim(),
                  conversationId: activeConversationId,
                  appointmentId: typeof appointmentId === "string" ? appointmentId : null,
                  scheduledDate: scheduledDate ?? null,
                  scheduledTime: scheduledTime ?? null,
                  scheduledEndTime: scheduledEndTime ?? null,
                }),
              });

              if (!apiResponse.ok) {
                return { status: "error", message: "Could not send that request to your caregiver right now." };
              }

              return { status: "ok" };
            } catch {
              return { status: "error", message: "Could not send that request to your caregiver right now." };
            }
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
        onError: () => {
          if (activeSession !== session) return;
          show("error", "Something went wrong", "Tap to end this call, then try again.");
        },
      });

      if (activeSession === session && !session.finished) {
        conversation = session.connection;
        orb.setBusy(false);
      }
    } catch {
      if (activeSession === session) {
        finishConversation(session);
        show("error", "Couldn't connect", "Check your internet connection, then tap to try again.");
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
