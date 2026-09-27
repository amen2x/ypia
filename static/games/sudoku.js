// Sudoku, 6 x 6 (numbers 1 to 6, boxes of 2 rows x 3 columns).
// Big squares, easy puzzle, always exactly one answer.
// She taps an empty square, then a number. A wrong number shows in red
// for a moment and clears. Every number she places is a "move":
// we time it and note if it was right.

const app = document.getElementById("app");
const stopButton = document.getElementById("stopButton");
const backLink = document.getElementById("backLink");
const { el } = Games;

const SIZE = 6;
const BOX_ROWS = 2;
const BOX_COLS = 3;
const BLANKS = 18; // squares she fills in (18 of 36)

// ---------------------------------------------------------------------
// Making a puzzle
// ---------------------------------------------------------------------

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// A finished, correct grid, mixed up so every game is different.
function makeSolution() {
  const base = [];
  for (let r = 0; r < SIZE; r += 1) {
    base.push([]);
    for (let c = 0; c < SIZE; c += 1) base[r].push(((r % BOX_ROWS) * BOX_COLS + Math.floor(r / BOX_ROWS) + c) % SIZE);
  }
  const digits = shuffle([1, 2, 3, 4, 5, 6]);
  // Swapping rows inside a band, bands, columns inside a stack, and stacks keeps it valid.
  const rows = shuffle([0, 1, 2]).flatMap((band) => shuffle([0, 1]).map((i) => band * BOX_ROWS + i));
  const cols = shuffle([0, 1]).flatMap((stack) => shuffle([0, 1, 2]).map((i) => stack * BOX_COLS + i));
  return rows.map((r) => cols.map((c) => digits[base[r][c]]));
}

function canPlace(grid, r, c, value) {
  for (let i = 0; i < SIZE; i += 1) {
    if (grid[r][i] === value || grid[i][c] === value) return false;
  }
  const r0 = r - (r % BOX_ROWS);
  const c0 = c - (c % BOX_COLS);
  for (let i = 0; i < BOX_ROWS; i += 1) {
    for (let j = 0; j < BOX_COLS; j += 1) if (grid[r0 + i][c0 + j] === value) return false;
  }
  return true;
}

// How many answers the puzzle has (stops counting at 2).
function countSolutions(grid) {
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      if (grid[r][c] !== 0) continue;
      let count = 0;
      for (let value = 1; value <= SIZE && count < 2; value += 1) {
        if (!canPlace(grid, r, c, value)) continue;
        grid[r][c] = value;
        count += countSolutions(grid);
        grid[r][c] = 0;
      }
      return count;
    }
  }
  return 1; // no empty squares left
}

// Empties squares one by one, keeping only puzzles with exactly one answer.
function makePuzzle() {
  const solution = makeSolution();
  const puzzle = solution.map((row) => [...row]);
  let blanks = 0;
  for (const cell of shuffle([...Array(SIZE * SIZE).keys()])) {
    if (blanks === BLANKS) break;
    const r = Math.floor(cell / SIZE);
    const c = cell % SIZE;
    const keep = puzzle[r][c];
    puzzle[r][c] = 0;
    if (countSolutions(puzzle.map((row) => [...row])) === 1) blanks += 1;
    else puzzle[r][c] = keep;
  }
  return { solution, puzzle, blanks };
}

// ---------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------

function start() {
  const player = Games.requirePlayer(app);
  if (!player) return;

  const { solution, puzzle, blanks } = makePuzzle();
  const board = puzzle.map((row) => [...row]);
  const tracker = Games.moveTracker();
  let selected = null; // [row, col]
  let left = blanks;

  const session = Games.puzzleSession({
    gameName: "sudoku",
    doneTitle: "You solved the puzzle!",
    player, app, stopButton, backLink, tracker,
    getInfo: () => ({ size: SIZE, blanks, filled: blanks - left }),
    onRestart: start,
  });

  const message = el("p", { class: "feedback center", role: "status", text: "Tap an empty square, then a number." });
  const cells = [];
  const grid = el("div", { class: "sudoku", role: "grid", "aria-label": "Sudoku puzzle" });

  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      const given = puzzle[r][c] !== 0;
      const cell = el("button", {
        type: "button",
        class: `cell${given ? " given" : ""}${c % BOX_COLS === BOX_COLS - 1 && c < SIZE - 1 ? " box-right" : ""}${r % BOX_ROWS === BOX_ROWS - 1 && r < SIZE - 1 ? " box-bottom" : ""}`,
        "aria-label": given ? `Row ${r + 1}, column ${c + 1}: ${puzzle[r][c]}` : `Row ${r + 1}, column ${c + 1}: empty`,
        text: given ? String(puzzle[r][c]) : "",
        onclick: () => select(r, c),
      });
      if (given) cell.disabled = true;
      cells.push(cell);
      grid.append(cell);
    }
  }

  const cellAt = (r, c) => cells[r * SIZE + c];

  function select(r, c) {
    if (board[r][c] !== 0) return;
    if (selected) cellAt(...selected).classList.remove("selected");
    selected = [r, c];
    cellAt(r, c).classList.add("selected");
    message.className = "feedback center";
    message.textContent = "Now tap a number.";
  }

  function place(value) {
    if (session.isFinished()) return;
    if (!selected) {
      message.className = "feedback center";
      message.textContent = "First tap an empty square.";
      return;
    }
    const [r, c] = selected;
    const cell = cellAt(r, c);
    if (cell.classList.contains("flash")) return; // wait for the red number to clear
    const ok = solution[r][c] === value;
    tracker.record(ok);

    if (ok) {
      board[r][c] = value;
      left -= 1;
      cell.textContent = String(value);
      cell.classList.remove("selected");
      cell.classList.add("placed");
      cell.disabled = true;
      cell.setAttribute("aria-label", `Row ${r + 1}, column ${c + 1}: ${value}`);
      selected = null;
      message.className = "feedback center right";
      message.textContent = left > 0 ? `Yes! ${left} square${left === 1 ? "" : "s"} left.` : "All done!";
      if (left === 0) setTimeout(() => session.finish(true), 700);
    } else {
      cell.textContent = String(value);
      cell.classList.add("flash");
      message.className = "feedback center wrong";
      message.textContent = "Not quite. Try another number.";
      setTimeout(() => {
        cell.textContent = "";
        cell.classList.remove("flash");
      }, 900);
    }
  }

  const pad = el("div", { class: "number-pad" },
    Array.from({ length: SIZE }, (_, i) =>
      el("button", { type: "button", class: "number", text: String(i + 1), onclick: () => place(i + 1) })),
  );

  // Number keys work too, but only while the puzzle is on screen.
  document.onkeydown = (event) => {
    const value = Number(event.key);
    if (value >= 1 && value <= SIZE && grid.isConnected) place(value);
  };

  app.replaceChildren(
    el("p", { class: "center muted small", text: "Each row, each column and each box has the numbers 1 to 6 once." }),
    grid,
    message,
    pad,
  );
}

start();
