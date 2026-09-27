// Trivia: 10 questions, one at a time. Times each answer (she never sees
// a timer), saves the game, then asks the 2-tap survey.

const app = document.getElementById("app");
const stopButton = document.getElementById("stopButton");
const backLink = document.getElementById("backLink");
const LETTERS = ["A", "B", "C", "D"];

let game = null;      // the game being played
let pausedAt = null;  // when "Stop game" was pressed (answer time doesn't count while paused)

// Small helper to build page elements safely (text is never read as HTML).
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function showScreen(...children) {
  Games.stopSpeaking();
  app.replaceChildren(...children);
}

function showMessage(text) {
  showScreen(el("p", { class: "big center", text }));
}

function showError(message, retry) {
  showScreen(
    el("p", { class: "big center error-text", text: message }),
    el("div", { class: "button-row" }, [
      el("button", { type: "button", class: "button primary", text: "Try again", onclick: retry }),
      el("a", { class: "button", href: "index.html", text: "Back to games" }),
    ]),
  );
}

function setPlaying(playing) {
  stopButton.hidden = !playing;
  backLink.hidden = playing;
}

// ---------------------------------------------------------------------
// 1. Start: get 10 questions from the backend
// ---------------------------------------------------------------------

async function start() {
  const player = Games.requirePlayer(app);
  if (!player) return;
  setPlaying(false);
  showMessage("Getting your questions ready…");

  try {
    const data = await Games.api("/api/trivia/new", { userId: player.id });
    game = {
      player,
      questions: data.questions,
      index: 0,
      answers: [],
      playDate: Games.localDate(),
      startedAt: new Date().toISOString(),
      shownAt: 0,
      result: null,
    };
    setPlaying(true);
    showQuestion();
  } catch (error) {
    showError(error.message, start);
  }
}

// ---------------------------------------------------------------------
// 2. One question
// ---------------------------------------------------------------------

function topicLabel(question) {
  if (question.kind === "memory") return "About you";
  if (question.kind === "recall") return "Memory";
  return question.topic;
}

function readAloud(question) {
  const choices = question.choices.map((choice, i) => `${LETTERS[i]}: ${choice}`).join(". ");
  Games.speak(`${question.question} ${choices}.`);
}

function showQuestion() {
  const question = game.questions[game.index];
  const feedback = el("p", { class: "feedback", role: "status" });
  const nextButton = el("button", {
    type: "button",
    class: "button primary",
    text: game.index === game.questions.length - 1 ? "See my score" : "Next question",
    onclick: nextQuestion,
  });
  nextButton.hidden = true;

  const choiceButtons = question.choices.map((choice, i) =>
    el("button", { type: "button", class: "choice", onclick: () => answer(i) }, [
      el("span", { class: "mark", text: LETTERS[i] }),
      choice,
    ]),
  );

  function answer(chosenIndex) {
    if (choiceButtons[0].disabled) return; // already answered (double tap)
    const seconds = Math.round(((performance.now() - game.shownAt) / 1000) * 10) / 10;
    const isRight = chosenIndex === question.answerIndex;

    choiceButtons.forEach((button) => { button.disabled = true; });
    choiceButtons[question.answerIndex].classList.add("right");
    choiceButtons[question.answerIndex].querySelector(".mark").textContent = "✓";
    if (!isRight) {
      choiceButtons[chosenIndex].classList.add("wrong");
      choiceButtons[chosenIndex].querySelector(".mark").textContent = "✗";
    }

    game.answers.push({
      n: question.n,
      kind: question.kind,
      topic: question.topic,
      question: question.question,
      choices: question.choices,
      answerIndex: question.answerIndex,
      chosenIndex,
      seconds,
    });

    feedback.className = `feedback ${isRight ? "right" : "wrong"}`;
    feedback.textContent = isRight ? "That's right!" : `Good try. The answer is ${question.choices[question.answerIndex]}.`;
    nextButton.hidden = false;
    nextButton.focus();
  }

  const hearButton = el("button", {
    type: "button",
    class: "button",
    text: "🔊 Hear question",
    onclick: () => readAloud(question),
  });
  hearButton.hidden = !("speechSynthesis" in window);

  showScreen(
    el("div", { class: "progress-row" }, [
      el("span", { class: "progress", text: `Question ${game.index + 1} of ${game.questions.length}` }),
      el("span", { class: "topic", text: topicLabel(question) }),
    ]),
    el("p", { class: "question", text: question.question }),
    hearButton,
    el("div", { class: "choices" }, choiceButtons),
    feedback,
    el("div", { class: "button-row" }, [nextButton]),
  );
  game.shownAt = performance.now();
}

function nextQuestion() {
  game.index += 1;
  if (game.index < game.questions.length) showQuestion();
  else finish(true);
}

// ---------------------------------------------------------------------
// 3. Stopping early
// ---------------------------------------------------------------------

stopButton.addEventListener("click", () => {
  if (!game || pausedAt !== null) return;
  pausedAt = performance.now();
  Games.stopSpeaking();
  const questionScreen = [...app.childNodes];
  const answered = game.answers.length;

  showScreen(
    el("h2", { class: "center", text: "Stop the game now?" }),
    el("p", {
      class: "center",
      text: answered > 0 ? "Your answers so far will be saved." : "You haven't answered any questions yet.",
    }),
    el("div", { class: "button-row" }, [
      el("button", {
        type: "button",
        class: "button",
        text: "Keep playing",
        onclick: () => {
          game.shownAt += performance.now() - pausedAt; // don't count the pause
          pausedAt = null;
          app.replaceChildren(...questionScreen);
        },
      }),
      el("button", {
        type: "button",
        class: "button primary",
        text: "Yes, stop",
        onclick: () => {
          pausedAt = null;
          finish(false);
        },
      }),
    ]),
  );
});

// ---------------------------------------------------------------------
// 4. Save the game, show the score, ask the survey
// ---------------------------------------------------------------------

async function finish(completed) {
  setPlaying(false);
  if (game.answers.length === 0) {
    window.location.href = "index.html"; // nothing to save
    return;
  }

  const payload = {
    userId: game.player.id,
    game: "trivia",
    playDate: game.playDate,
    startedAt: game.startedAt,
    finishedAt: new Date().toISOString(),
    completed,
    answers: game.answers,
  };

  async function save() {
    showMessage("Saving your game…");
    try {
      game.result = await Games.api("/api/games/result", payload);
      showScore(completed);
    } catch (error) {
      showError(`Your game couldn't be saved. ${error.message}`, save);
    }
  }
  await save();
}

function showScore(completed) {
  const right = game.answers.filter((a) => a.chosenIndex === a.answerIndex).length;
  const total = game.answers.length;

  // Survey choices: the topics from this game, plus "Something new".
  const topics = [...new Set(game.answers.filter((a) => a.kind === "interest").map((a) => a.topic))];
  let enjoyed = null;
  let moreAbout;       // undefined = not picked yet, null = "Something new"
  const surveyError = el("p", { class: "error-text center" });

  function pickOne(group, button) {
    group.forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
  }

  const enjoyButtons = [
    el("button", { type: "button", class: "chip", "aria-pressed": "false", text: "👍 Yes", onclick: (e) => { enjoyed = true; pickOne(enjoyButtons, e.currentTarget); sendButton.disabled = false; } }),
    el("button", { type: "button", class: "chip", "aria-pressed": "false", text: "👎 Not really", onclick: (e) => { enjoyed = false; pickOne(enjoyButtons, e.currentTarget); sendButton.disabled = false; } }),
  ];
  const topicButtons = [...topics, null].map((topic) =>
    el("button", {
      type: "button",
      class: "chip",
      "aria-pressed": "false",
      text: topic ?? "Something new",
      onclick: (e) => { moreAbout = topic; pickOne(topicButtons, e.currentTarget); },
    }),
  );

  const sendButton = el("button", { type: "button", class: "button primary", text: "Send", onclick: sendSurvey });
  sendButton.disabled = true;

  async function sendSurvey() {
    sendButton.disabled = true;
    surveyError.textContent = "";
    try {
      await Games.api("/api/trivia/survey", {
        userId: game.player.id,
        gameResultId: game.result.id,
        enjoyed,
        moreAbout: moreAbout ?? null,
      });
      showThanks();
    } catch (error) {
      if (/already saved/i.test(error.message)) { showThanks(); return; }
      surveyError.textContent = `That didn't send. ${error.message}`;
      sendButton.disabled = false;
    }
  }

  showScreen(
    el("div", { class: "center" }, [
      el("h1", { text: completed ? `You got ${right} of ${total}!` : `You answered ${total} question${total === 1 ? "" : "s"}.` }),
      el("p", { class: "big", text: completed ? "Your garden grew! 🌱" : "Thanks for playing! 🌱" }),
      el("hr", { style: "border:none;border-top:2px solid var(--line);margin:24px 0" }),
      el("h2", { text: "Did you enjoy this game?" }),
      el("div", { class: "chips" }, enjoyButtons),
      el("h2", { text: "Want more questions about…", style: "margin-top:28px" }),
      el("div", { class: "chips" }, topicButtons),
      surveyError,
      el("div", { class: "button-row" }, [
        sendButton,
        el("button", { type: "button", class: "button", text: "Skip", onclick: showThanks }),
      ]),
    ]),
  );
}

function showThanks() {
  showScreen(
    el("div", { class: "center" }, [
      el("h1", { text: "Thank you!" }),
      el("p", { class: "big", text: "See you tomorrow for more." }),
      el("div", { class: "button-row" }, [
        el("button", { type: "button", class: "button primary", text: "Play again", onclick: start }),
        el("a", { class: "button", href: "index.html", text: "Back to games" }),
      ]),
    ]),
  );
}

start();
