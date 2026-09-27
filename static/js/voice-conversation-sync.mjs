const RETRY_DELAYS_MS = [3000, 5000, 8000];

export function createConversationSync({
  fetchImpl = (...args) => fetch(...args),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const inFlight = new Map();
  // Keep only IDs after completion so late SDK callbacks cannot restart a review.
  const finished = new Set();

  async function run(userId, conversationId) {
    try {
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        const response = await fetchImpl("/api/parent/voice-conversations/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, conversationId }),
        });
        if (!response.ok) return "stopped";

        const data = await response.json();
        if (data?.status === "synced") return "synced";
        if (data?.status !== "pending") return "stopped";
        if (attempt === RETRY_DELAYS_MS.length) return "exhausted";

        await wait(RETRY_DELAYS_MS[attempt]);
      }
    } catch {
      // Network/invalid-response errors are terminal; only explicit pending retries.
      return "stopped";
    }
  }

  return function syncConversation(userId, conversationId) {
    if (inFlight.has(conversationId)) return inFlight.get(conversationId);
    if (finished.has(conversationId)) return Promise.resolve("already_finished");

    const job = run(userId, conversationId).finally(() => {
      inFlight.delete(conversationId);
      finished.add(conversationId);
    });
    inFlight.set(conversationId, job);
    return job;
  };
}
