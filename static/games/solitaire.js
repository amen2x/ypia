// Solitaire (Klondike, turn one card at a time).
// Tap a card, then tap where it should go. Tap the deck for a new card.
// Every try is a "move": we time it and note if the card was allowed there.

const app = document.getElementById("app");
const stopButton = document.getElementById("stopButton");
const backLink = document.getElementById("backLink");
const { el } = Games;

const SUITS = ["♠", "♥", "♦", "♣"];
const SUIT_NAMES = ["spades", "hearts", "diamonds", "clubs"];
const RANKS = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const RANK_NAMES = ["", "Ace", "2", "3", "4", "5", "6", "7", "8", "9", "10", "Jack", "Queen", "King"];

const isRed = (card) => card.suit === 1 || card.suit === 2;
const cardName = (card) => `${RANK_NAMES[card.rank]} of ${SUIT_NAMES[card.suit]}`;

function shuffledDeck() {
  const deck = [];
  for (let suit = 0; suit < 4; suit += 1) for (let rank = 1; rank <= 13; rank += 1) deck.push({ suit, rank, up: false });
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ---------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------

function canGoOnFoundation(card, foundation) {
  const top = foundation[foundation.length - 1];
  return top ? card.suit === top.suit && card.rank === top.rank + 1 : card.rank === 1;
}

function canGoOnTableau(card, pile) {
  const top = pile[pile.length - 1];
  return top ? top.up && isRed(top) !== isRed(card) && card.rank === top.rank - 1 : card.rank === 13;
}

// ---------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------

function start() {
  const player = Games.requirePlayer(app);
  if (!player) return;

  const deck = shuffledDeck();
  const state = {
    tableau: Array.from({ length: 7 }, (_, i) => deck.splice(0, i + 1)),
    stock: deck, // the rest, face down
    waste: [],
    foundations: [[], [], [], []],
  };
  state.tableau.forEach((pile) => { pile[pile.length - 1].up = true; });

  const tracker = Games.moveTracker();
  let selected = null;   // { from: "waste" } | { from: "foundation", pile } | { from: "tableau", pile, index }
  let message = "Tap a card, then tap where it should go.";
  let messageKind = "";
  let shakeTarget = null;

  const cardsHome = () => state.foundations.reduce((sum, pile) => sum + pile.length, 0);

  const session = Games.puzzleSession({
    gameName: "solitaire",
    doneTitle: "You won the game!",
    player, app, stopButton, backLink, tracker,
    getInfo: () => ({ draw: 1, cardsHome: cardsHome() }),
    onRestart: start,
  });

  // The cards that would move with the current selection.
  function selectedCards() {
    if (!selected) return [];
    if (selected.from === "waste") return state.waste.slice(-1);
    if (selected.from === "foundation") return state.foundations[selected.pile].slice(-1);
    return state.tableau[selected.pile].slice(selected.index);
  }

  function removeSelected() {
    if (selected.from === "waste") return state.waste.splice(-1);
    if (selected.from === "foundation") return state.foundations[selected.pile].splice(-1);
    const pile = state.tableau[selected.pile];
    const moved = pile.splice(selected.index);
    if (pile.length > 0) pile[pile.length - 1].up = true; // turn over the card underneath
    return moved;
  }

  function say(text, kind = "") {
    message = text;
    messageKind = kind;
  }

  // Tapping the deck: turn over one card, or put the used cards back.
  function tapStock() {
    if (session.isFinished()) return;
    selected = null;
    if (state.stock.length > 0) {
      const card = state.stock.pop();
      card.up = true;
      state.waste.push(card);
      tracker.record(true);
      say("Tap a card, then tap where it should go.");
    } else if (state.waste.length > 0) {
      state.stock = state.waste.reverse().map((card) => ({ ...card, up: false }));
      state.waste = [];
      tracker.record(true);
      say("The deck is ready again.");
    }
    render();
  }

  function select(selection) {
    if (session.isFinished()) return;
    const same = selected && selected.from === selection.from && selected.pile === selection.pile && selected.index === selection.index;
    selected = same ? null : selection;
    say(selected ? "Now tap where it should go." : "Tap a card, then tap where it should go.");
    render();
  }

  // Try to move the selected card(s) to a foundation or tableau pile.
  function moveTo(target) {
    if (session.isFinished() || !selected) return;
    const cards = selectedCards();
    const first = cards[0];
    let allowed = false;

    if (target.to === "foundation") {
      allowed = cards.length === 1 && canGoOnFoundation(first, state.foundations[target.pile]);
    } else {
      const fromSamePile = selected.from === "tableau" && selected.pile === target.pile;
      allowed = !fromSamePile && canGoOnTableau(first, state.tableau[target.pile]);
    }

    if (allowed) {
      const moved = removeSelected();
      (target.to === "foundation" ? state.foundations : state.tableau)[target.pile].push(...moved);
      tracker.record(true);
      say(target.to === "foundation" ? "Nice! Onto the pile it goes." : "Good move.", "right");
      selected = null;
      render();
      if (cardsHome() === 52) setTimeout(() => session.finish(true), 600);
    } else {
      tracker.record(false);
      const why = target.to === "foundation"
        ? "Those piles start with an Ace and go up in the same suit."
        : state.tableau[target.pile].length === 0
          ? "Only a King can go in an empty space."
          : "It needs to be one lower and the other color.";
      say(`That card can't go there. ${why}`, "wrong");
      shakeTarget = selected;
      selected = null;
      render();
    }
  }

  // ----- drawing the table -----

  function cardButton(card, { label, onclick, selectedNow, shake }) {
    if (!card.up) {
      return el("button", { type: "button", class: "card-face down", "aria-label": "Face-down card", onclick });
    }
    return el("button", {
      type: "button",
      class: `card-face${isRed(card) ? " red" : ""}${selectedNow ? " selected" : ""}${shake ? " shake" : ""}`,
      "aria-label": label || cardName(card),
      onclick,
    }, [
      el("span", { class: "corner", text: `${RANKS[card.rank]}${SUITS[card.suit]}` }),
      el("span", { class: "middle", "aria-hidden": "true", text: SUITS[card.suit] }),
    ]);
  }

  function isSelected(from, pile, index) {
    return selected && selected.from === from && selected.pile === pile && (from !== "tableau" || index >= selected.index);
  }
  function isShaking(from, pile, index) {
    return shakeTarget && shakeTarget.from === from && shakeTarget.pile === pile && (from !== "tableau" || index >= shakeTarget.index);
  }

  function render() {
    if (session.isFinished()) return;
    const board = el("div", { class: "sol-board" });

    // Top row: deck, turned-over card, (gap), 4 home piles.
    const top = el("div", { class: "sol-row" });

    const stockSlot = el("button", {
      type: "button",
      class: "slot",
      "aria-label": state.stock.length > 0 ? `Deck, ${state.stock.length} cards. Tap to turn one over.` : "Deck is empty. Tap to start it again.",
      onclick: tapStock,
    }, state.stock.length > 0
      ? [el("span", { class: "card-face down", style: "top:0" })]
      : [el("span", { class: "hint", "aria-hidden": "true", text: state.waste.length > 0 ? "↻" : "" })]);
    top.append(stockSlot);

    const wasteSlot = el("div", { class: "slot", style: "cursor:default" });
    const wasteTop = state.waste[state.waste.length - 1];
    if (wasteTop) {
      const button = cardButton(wasteTop, {
        onclick: () => select({ from: "waste" }),
        selectedNow: isSelected("waste"),
        shake: isShaking("waste"),
      });
      button.style.top = "0";
      wasteSlot.append(button);
    }
    top.append(wasteSlot, el("div"));

    state.foundations.forEach((pile, f) => {
      const slot = el("button", {
        type: "button",
        class: "slot",
        "aria-label": pile.length ? `Home pile, top card ${cardName(pile[pile.length - 1])}` : "Empty home pile. Aces go here.",
        onclick: () => (selected ? moveTo({ to: "foundation", pile: f }) : null),
      }, [el("span", { class: "hint", "aria-hidden": "true", text: "A" })]);
      const topCard = pile[pile.length - 1];
      if (topCard) {
        const button = cardButton(topCard, {
          onclick: (event) => {
            event.stopPropagation();
            if (selected) moveTo({ to: "foundation", pile: f });
            else select({ from: "foundation", pile: f });
          },
          selectedNow: isSelected("foundation", f),
          shake: isShaking("foundation", f),
        });
        button.style.top = "0";
        slot.append(button);
      }
      top.append(slot);
    });

    // Bottom row: 7 piles.
    const bottom = el("div", { class: "sol-row" });
    state.tableau.forEach((pile, t) => {
      const column = el("div", { class: "pile", "data-pile": String(t) });
      const emptySlot = el("button", {
        type: "button",
        class: "slot",
        "aria-label": "Empty space. Only a King can go here.",
        onclick: () => (selected ? moveTo({ to: "tableau", pile: t }) : null),
      }, [el("span", { class: "hint", "aria-hidden": "true", text: "K" })]);
      column.append(emptySlot);

      pile.forEach((card, index) => {
        const button = cardButton(card, {
          onclick: (event) => {
            event.stopPropagation();
            if (selected && !isSelected("tableau", t, index)) moveTo({ to: "tableau", pile: t });
            else if (card.up) select({ from: "tableau", pile: t, index });
          },
          selectedNow: isSelected("tableau", t, index),
          shake: isShaking("tableau", t, index),
        });
        button.dataset.index = String(index);
        column.append(button);
      });
      bottom.append(column);
    });

    board.append(top, bottom);
    shakeTarget = null;

    app.replaceChildren(
      el("p", { class: "sol-help", text: "Build 4 piles from Ace to King, one per suit. In the bottom rows, place cards one lower and the other color." }),
      el("div", { class: "solitaire" }, [board]),
      el("p", { class: `feedback center ${messageKind}`, role: "status", text: message }),
      el("p", { class: "center muted small", text: `Cards home: ${cardsHome()} of 52` }),
    );
    layoutPiles();
  }

  // Fan the cards down each pile: small gaps for face-down cards, bigger for face-up.
  function layoutPiles() {
    app.querySelectorAll(".pile").forEach((column) => {
      const width = column.clientWidth;
      const cardHeight = width * 1.4;
      let y = 0;
      let lastTop = 0;
      column.querySelectorAll(".card-face").forEach((card) => {
        card.style.top = `${y}px`;
        lastTop = y;
        y += card.classList.contains("down") ? cardHeight * 0.14 : cardHeight * 0.3;
      });
      column.style.height = `${lastTop + cardHeight}px`;
    });
  }

  window.onresize = () => { if (!session.isFinished() && app.querySelector(".pile")) layoutPiles(); };
  render();

  // For testing in the browser console only.
  window.__solitaire = { state, render, moveTo, select, tapStock };
}

start();
