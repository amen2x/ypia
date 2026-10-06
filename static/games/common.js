// Shared helpers for the 3 game pages (trivia, sudoku, solitaire).
// Loaded with a plain <script> tag, so everything lives on window.Games.

(function () {
  const API = "";

  // The logged-in user, saved by the login page. Games are for parents only.
  function getPlayer() {
    let user = null;
    try {
      user = JSON.parse(localStorage.getItem("ypia_user") || "null");
    } catch {
      user = null;
    }
    if (!user || !user.id) return { error: "login" };
    if (user.role !== "parent") return { error: "parent-only" };
    const firstName = (user.fullName || "").trim().split(/\s+/)[0] || "there";
    return { id: user.id, firstName };
  }

  // Shows a friendly message instead of the game when nobody (or the wrong
  // kind of account) is logged in. Returns the player, or null.
  function requirePlayer(container) {
    const player = getPlayer();
    if (!player.error) return player;
    container.innerHTML = "";
    const box = document.createElement("div");
    box.className = "card center";
    const text = document.createElement("p");
    text.className = "big";
    text.textContent = player.error === "login"
      ? "Please log in to play."
      : "The games are for the parent's account.";
    const link = document.createElement("a");
    link.className = "button primary";
    link.href = "/login";
    link.textContent = "Go to log in";
    box.append(text, link);
    container.append(box);
    return null;
  }

  // Today's date from this computer's clock, like 2026-09-27.
  // (toISOString would give the UTC date, which is tomorrow in the evening.)
  function localDate(date = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  // Calls the backend. Throws an Error with a readable message if it fails.
  async function api(path, body) {
    let response;
    try {
      response = await fetch(API + path, body === undefined
        ? {}
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      throw new Error("Can't reach the game server. Is the backend running?");
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) throw new Error((data && data.error) || `Something went wrong (${response.status})`);
    return data;
  }

  // Reads text out loud with the browser's own voice, a little slower than normal.
  function speak(text) {
    if (!("speechSynthesis" in window)) return false;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
    return true;
  }

  function stopSpeaking() {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }

  // Builds a page element safely (text is never read as HTML).
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  }

  // "4 min 05 sec"
  function formatDuration(seconds) {
    const whole = Math.max(0, Math.round(seconds));
    const minutes = Math.floor(whole / 60);
    const rest = String(whole % 60).padStart(2, "0");
    return minutes > 0 ? `${minutes} min ${rest} sec` : `${whole} sec`;
  }

  // Tracks the time between moves for Sudoku and Solitaire.
  // Each move: { seconds since the previous move (or the start), ok }.
  function moveTracker() {
    let last = performance.now();
    let pausedAt = null;
    const moves = [];
    return {
      moves,
      record(ok) {
        const now = performance.now();
        moves.push({ seconds: Math.round(((now - last) / 1000) * 10) / 10, ok });
        last = now;
      },
      pause() { if (pausedAt === null) pausedAt = performance.now(); },
      resume() {
        if (pausedAt !== null) { last += performance.now() - pausedAt; pausedAt = null; }
      },
    };
  }

  // The parts Sudoku and Solitaire share: "Stop game", saving, and the end screen.
  //   session.finish(true)  -> she finished the puzzle
  //   session.finish(false) -> she stopped early
  function puzzleSession({ gameName, doneTitle, player, app, stopButton, backLink, tracker, getInfo, onRestart }) {
    const startedAt = new Date().toISOString();
    const playDate = localDate();
    const startTime = performance.now();
    let finished = false;
    let pausedScreen = null;

    function setPlaying(playing) {
      stopButton.hidden = !playing;
      backLink.hidden = playing;
    }
    setPlaying(true);

    stopButton.onclick = () => {
      if (finished || pausedScreen) return;
      tracker.pause();
      pausedScreen = [...app.childNodes];
      app.replaceChildren(
        el("h2", { class: "center", text: "Stop the game now?" }),
        el("p", { class: "center", text: tracker.moves.length > 0 ? "Your moves so far will be saved." : "You haven't made any moves yet." }),
        el("div", { class: "button-row" }, [
          el("button", { type: "button", class: "button", text: "Keep playing", onclick: () => {
            tracker.resume();
            app.replaceChildren(...pausedScreen);
            pausedScreen = null;
          } }),
          el("button", { type: "button", class: "button primary", text: "Yes, stop", onclick: () => {
            pausedScreen = null;
            finish(false);
          } }),
        ]),
      );
    };

    async function finish(completed) {
      if (finished) return;
      finished = true;
      setPlaying(false);
      const seconds = (performance.now() - startTime) / 1000;
      if (!completed && tracker.moves.length === 0) {
        window.location.href = "index.html"; // nothing to save
        return;
      }

      const payload = {
        userId: player.id,
        game: gameName,
        playDate,
        startedAt,
        finishedAt: new Date().toISOString(),
        completed,
        moves: tracker.moves,
        info: getInfo(),
      };

      async function save() {
        app.replaceChildren(el("p", { class: "big center", text: "Saving your game…" }));
        try {
          await api("/api/games/result", payload);
        } catch (error) {
          app.replaceChildren(
            el("p", { class: "big center error-text", text: `Your game couldn't be saved. ${error.message}` }),
            el("div", { class: "button-row" }, [
              el("button", { type: "button", class: "button primary", text: "Try again", onclick: save }),
              el("a", { class: "button", href: "index.html", text: "Back to games" }),
            ]),
          );
          return;
        }
        const mistakes = tracker.moves.filter((move) => !move.ok).length;
        app.replaceChildren(el("div", { class: "center" }, [
          el("h1", { text: completed ? doneTitle : "Thanks for playing!" }),
          el("p", { class: "big", text: completed ? "Your garden grew!" : "Your moves were saved." }),
          el("p", { class: "muted", text: `Time: ${formatDuration(seconds)} · Moves: ${tracker.moves.length} · Mistakes: ${mistakes}` }),
          el("div", { class: "button-row" }, [
            el("button", { type: "button", class: "button primary", text: "New game", onclick: onRestart }),
            el("a", { class: "button", href: "index.html", text: "Back to games" }),
          ]),
        ]));
      }
      await save();
    }

    return { finish, isFinished: () => finished };
  }

  window.Games = { api, getPlayer, requirePlayer, localDate, speak, stopSpeaking, el, formatDuration, moveTracker, puzzleSession };
})();
