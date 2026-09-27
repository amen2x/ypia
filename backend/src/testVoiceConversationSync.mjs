import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createConversationSync } from "../../static/js/voice-conversation-sync.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function response(status, httpStatus = 200) {
  return {
    ok: httpStatus >= 200 && httpStatus < 300,
    status: httpStatus,
    json: async () => ({ status }),
  };
}

function syncHarness(responses) {
  const requests = [];
  const delays = [];
  const sync = createConversationSync({
    fetchImpl: async (url, options) => {
      requests.push({ url, ...options });
      const next = responses[requests.length - 1];
      if (next instanceof Error) throw next;
      assert.notEqual(next, undefined, "Unexpected extra sync request");
      return next;
    },
    wait: async (ms) => { delays.push(ms); },
  });
  return { sync, requests, delays };
}

for (const [statuses, expectedDelays] of [
  [["synced"], []],
  [["pending", "synced"], [3000]],
  [["pending", "pending", "synced"], [3000, 5000]],
]) {
  test(`sync ${statuses.join(" -> ")} stops at synced`, async () => {
    const harness = syncHarness(statuses.map((status) => response(status)));
    assert.equal(await harness.sync("synthetic-parent", "synthetic-conversation"), "synced");
    assert.equal(harness.requests.length, statuses.length);
    assert.deepEqual(harness.delays, expectedDelays);
    for (const request of harness.requests) {
      assert.equal(request.url, "http://localhost:3000/api/parent/voice-conversations/sync");
      assert.equal(request.method, "POST");
      assert.deepEqual(JSON.parse(request.body), {
        userId: "synthetic-parent", conversationId: "synthetic-conversation",
      });
    }
  });
}

test("pending stops after four requests with 3s/5s/8s waits", async () => {
  const harness = syncHarness(Array.from({ length: 4 }, () => response("pending")));
  assert.equal(await harness.sync("parent", "conversation"), "exhausted");
  assert.equal(harness.requests.length, 4);
  assert.deepEqual(harness.delays, [3000, 5000, 8000]);
});

for (const httpStatus of [400, 401, 403, 404, 500, 502]) {
  test(`HTTP ${httpStatus} is terminal even with a pending body`, async () => {
    const harness = syncHarness([response("pending", httpStatus)]);
    assert.equal(await harness.sync("parent", "conversation"), "stopped");
    assert.equal(harness.requests.length, 1);
    assert.deepEqual(harness.delays, []);
  });
}

for (const httpStatus of [200, 502]) {
  test(`unavailable at HTTP ${httpStatus} is terminal`, async () => {
    const harness = syncHarness([response("unavailable", httpStatus)]);
    assert.equal(await harness.sync("parent", "conversation"), "stopped");
    assert.equal(harness.requests.length, 1);
    assert.deepEqual(harness.delays, []);
  });
}

for (const [label, result] of [
  ["network failure", new Error("synthetic network failure")],
  ["invalid JSON", { ok: true, json: async () => { throw new SyntaxError("synthetic invalid JSON"); } }],
  ["missing status", { ok: true, json: async () => ({}) }],
  ["null response body", { ok: true, json: async () => null }],
  ["unknown status", response("unexpected")],
]) {
  test(`${label} is terminal`, async () => {
    const harness = syncHarness([result]);
    assert.equal(await harness.sync("parent", "conversation"), "stopped");
    assert.equal(harness.requests.length, 1);
    assert.deepEqual(harness.delays, []);
  });
}

test("duplicate starts share one loop, including after completion", async () => {
  const pending = deferred();
  const harness = syncHarness([pending.promise, response("synced")]);
  const first = harness.sync("parent", "conversation");
  assert.equal(harness.sync("parent", "conversation"), first);
  pending.resolve(response("pending"));
  assert.equal(await first, "synced");
  assert.equal(await harness.sync("parent", "conversation"), "already_finished");
  assert.equal(harness.requests.length, 2);
  assert.deepEqual(harness.delays, [3000]);
});

test("different conversation IDs have independent sync loops", async () => {
  const firstResponse = deferred();
  const harness = syncHarness([firstResponse.promise, response("synced"), response("synced")]);
  const first = harness.sync("parent", "first");
  assert.equal(await harness.sync("parent", "second"), "synced");
  firstResponse.resolve(response("pending"));
  assert.equal(await first, "synced");
  assert.deepEqual(harness.requests.map((request) => JSON.parse(request.body).conversationId),
    ["first", "second", "first"]);
});

const html = await readFile(new URL("../../templates/parent.html", import.meta.url), "utf8");
const voiceModule = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
assert.ok(voiceModule, "Expected the real parent voice module");
const voiceSource = voiceModule.replace(/^\s*import .*;\s*$/gm, "");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function voiceHarness({ registration, syncResponse, endSession, signedUrlFails = false } = {}) {
  const classes = new Set();
  const button = {
    disabled: false,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
    },
    style: { setProperty() {}, removeProperty() {} },
    addEventListener() {},
  };
  const status = { textContent: "Tap to talk" };
  const sessions = [];
  const syncRequests = [];
  const lifecycleEvents = [];
  const fetchMock = async (url, options) => {
    if (url.endsWith("/signed-url")) {
      lifecycleEvents.push("signed-url");
      return { ok: !signedUrlFails, json: async () => ({ signedUrl: "synthetic-url" }) };
    }
    if (url.endsWith("/register")) return registration?.promise ?? response("registered", 201);
    if (url.endsWith("/sync")) {
      syncRequests.push(JSON.parse(options.body));
      return syncResponse?.promise ?? response("synced");
    }
    throw new Error("Unexpected mocked endpoint");
  };
  const context = vm.createContext({
    document: { getElementById: (id) => id === "voiceButton" ? button : status },
    localStorage: { getItem: () => JSON.stringify({ id: "synthetic-parent", fullName: "Synthetic Parent", role: "parent" }) },
    window: { matchMedia: () => ({ matches: false }) },
    navigator: { mediaDevices: { getUserMedia: async () => {
      lifecycleEvents.push("microphone");
      return { getTracks: () => [
        { stop: () => lifecycleEvents.push("stop-track-1") },
        { stop: () => lifecycleEvents.push("stop-track-2") },
      ] };
    } } },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    fetch: fetchMock,
    createConversationSync: () => createConversationSync({ fetchImpl: fetchMock, wait: async () => {} }),
    Conversation: {
      startSession: async (callbacks) => {
        lifecycleEvents.push("sdk-start");
        const session = { callbacks, endCalls: 0, id: `synthetic-conversation-${sessions.length + 1}` };
        sessions.push(session);
        callbacks.onConnect({ conversationId: session.id });
        return {
          endSession: async () => {
            session.endCalls += 1;
            if (endSession) return endSession(session);
            callbacks.onDisconnect();
          },
        };
      },
    },
  });
  vm.runInContext(`${voiceSource}\nglobalThis.voiceTest = { startConversation, endConversation };`, context);
  return { ...context.voiceTest, button, status, classes, sessions, syncRequests, lifecycleEvents };
}

function assertIdle(harness) {
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.status.textContent, "Tap to talk");
  assert.equal(harness.classes.has("is-active"), false);
}

test("permission-check tracks stop before SDK startup", async () => {
  const harness = voiceHarness();
  await harness.startConversation();
  assert.deepEqual(harness.lifecycleEvents,
    ["microphone", "stop-track-1", "stop-track-2", "signed-url", "sdk-start"]);
  await harness.endConversation();
  await flush();
});

test("permission-check tracks are released even when signed-URL retrieval fails", async () => {
  const harness = voiceHarness({ signedUrlFails: true });
  await harness.startConversation();
  assert.deepEqual(harness.lifecycleEvents,
    ["microphone", "stop-track-1", "stop-track-2", "signed-url"]);
  assert.equal(harness.sessions.length, 0);
  assert.equal(harness.syncRequests.length, 0);
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.classes.has("is-connecting"), false);
  assert.equal(harness.status.textContent, "Connection failed. Tap to retry.");
});

for (const termination of ["explicit end", "disconnect"]) {
  test(`nonterminal errors retain the session until ${termination}`, async () => {
    const harness = voiceHarness();
    await harness.startConversation();
    const session = harness.sessions[0];
    session.callbacks.onError();
    await harness.startConversation();
    await flush();
    assert.equal(harness.sessions.length, 1);
    assert.equal(harness.syncRequests.length, 0);
    assert.equal(session.endCalls, 0);
    assert.equal(harness.classes.has("is-active"), true);
    assert.equal(harness.status.textContent, "Voice error. Tap to end and retry.");
    if (termination === "explicit end") await harness.endConversation();
    else session.callbacks.onDisconnect();
    session.callbacks.onDisconnect();
    await flush();
    assertIdle(harness);
    assert.equal(session.endCalls, termination === "explicit end" ? 1 : 0);
    assert.equal(harness.syncRequests.length, 1);
  });
}

test("explicit end and SDK disconnect share one sync and reset before sync completes", async () => {
  const syncResponse = deferred();
  const harness = voiceHarness({ syncResponse });
  await harness.startConversation();
  await harness.endConversation();
  await flush();
  assertIdle(harness);
  assert.equal(harness.sessions[0].endCalls, 1);
  assert.deepEqual(harness.syncRequests, [{ userId: "synthetic-parent", conversationId: "synthetic-conversation-1" }]);
  harness.sessions[0].callbacks.onDisconnect();
  syncResponse.resolve(response("synced"));
  await flush();
  assert.equal(harness.syncRequests.length, 1);
});

test("sync waits for registration without delaying UI reset", async () => {
  const registration = deferred();
  const harness = voiceHarness({ registration });
  await harness.startConversation();
  await harness.endConversation();
  await flush();
  assertIdle(harness);
  assert.equal(harness.syncRequests.length, 0);
  registration.resolve(response("registered", 201));
  await flush();
  assert.equal(harness.syncRequests.length, 1);
});

test("disconnect-only termination syncs the captured ID once", async () => {
  const harness = voiceHarness();
  await harness.startConversation();
  harness.sessions[0].callbacks.onDisconnect();
  harness.sessions[0].callbacks.onDisconnect();
  await flush();
  assertIdle(harness);
  assert.equal(harness.sessions[0].endCalls, 0);
  assert.deepEqual(harness.syncRequests, [{ userId: "synthetic-parent", conversationId: "synthetic-conversation-1" }]);
});

test("late callbacks and old sync completion leave a new session intact", async () => {
  const syncResponse = deferred();
  const harness = voiceHarness({ syncResponse });
  await harness.startConversation();
  const old = harness.sessions[0];
  await harness.endConversation();
  await harness.startConversation();
  old.callbacks.onDisconnect();
  old.callbacks.onError();
  old.callbacks.onModeChange({ mode: "speaking" });
  old.callbacks.onConnect({ conversationId: old.id });
  syncResponse.resolve(response("synced"));
  await flush();
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.status.textContent, "Tap to end");
  assert.equal(harness.classes.has("is-active"), true);
  assert.equal(harness.syncRequests.length, 1);
  await harness.endConversation();
  await flush();
  assert.equal(harness.sessions[1].endCalls, 1);
  assert.equal(harness.syncRequests[1].conversationId, "synthetic-conversation-2");
});

test("repeated end attempts invoke SDK endSession only once", async () => {
  const end = deferred();
  const harness = voiceHarness({ endSession: () => end.promise });
  await harness.startConversation();
  const ending = harness.endConversation();
  await harness.endConversation();
  assert.equal(harness.sessions[0].endCalls, 1);
  harness.sessions[0].callbacks.onDisconnect();
  assertIdle(harness);
  end.resolve();
  await ending;
  await flush();
  assert.equal(harness.syncRequests.length, 1);
});
