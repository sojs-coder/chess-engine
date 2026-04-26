const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const STORAGE_KEY = "mat_arena_player_id";
const STORAGE_NAME_KEY = "mat_arena_player_name";
const POLL_INTERVAL_MS = 750;
const CLOCK_TICK_MS = 250;
const LOW_TIME_THRESHOLD_MS = 30_000;

const PIECE_SYMBOLS = {
    wK: "♔",
    wQ: "♕",
    wR: "♖",
    wB: "♗",
    wN: "♘",
    wP: "♙",
    bK: "♚",
    bQ: "♛",
    bR: "♜",
    bB: "♝",
    bN: "♞",
    bP: "♟",
};

const state = {
    snapshot: null,
    snapshotReceivedAt: 0,
    selectedSquare: null,
    busy: false,
    pollInFlight: false,
    notice: null,
};

let pollTimer = 0;
let clockTimer = 0;

const refs = {
    feedback: document.querySelector("#feedback"),
    registrationPanel: document.querySelector("#registration-panel"),
    registrationForm: document.querySelector("#registration-form"),
    playerNameInput: document.querySelector("#player-name"),
    registerButton: document.querySelector("#register-button"),
    gamePanel: document.querySelector("#game-panel"),
    statusHeading: document.querySelector("#status-heading"),
    statusText: document.querySelector("#status-text"),
    movePrompt: document.querySelector("#move-prompt"),
    thinkingIndicator: document.querySelector("#thinking-indicator"),
    board: document.querySelector("#board"),
    filesTop: document.querySelector("#files-top"),
    filesBottom: document.querySelector("#files-bottom"),
    ranksLeft: document.querySelector("#ranks-left"),
    ranksRight: document.querySelector("#ranks-right"),
    playerDisplay: document.querySelector("#player-display"),
    playerId: document.querySelector("#player-id"),
    playerColor: document.querySelector("#player-color"),
    botDisplay: document.querySelector("#bot-display"),
    playerClockRow: document.querySelector("#player-clock-row"),
    playerClockLabel: document.querySelector("#player-clock-label"),
    playerClock: document.querySelector("#player-clock"),
    botClockRow: document.querySelector("#bot-clock-row"),
    botClockLabel: document.querySelector("#bot-clock-label"),
    botClock: document.querySelector("#bot-clock"),
    resetButton: document.querySelector("#reset-button"),
    moveList: document.querySelector("#move-list"),
    moveCount: document.querySelector("#move-count"),
};

bootstrap();

async function bootstrap() {
    refs.registrationForm.addEventListener("submit", handleRegister);
    refs.resetButton.addEventListener("click", handleReset);

    const savedName = window.localStorage.getItem(STORAGE_NAME_KEY);
    if (savedName) {
        refs.playerNameInput.value = savedName;
    }

    startClockTicker();
    render();
    await restoreSession();
}

function startClockTicker() {
    if (clockTimer) return;

    clockTimer = window.setInterval(() => {
        if (!state.snapshot) return;
        renderClocks(state.snapshot);
    }, CLOCK_TICK_MS);
}

async function restoreSession() {
    const playerId = window.localStorage.getItem(STORAGE_KEY);
    if (!playerId) return;

    setBusy(true);

    try {
        const snapshot = await fetchJson(`/api/game?playerId=${encodeURIComponent(playerId)}`);
        applySnapshot(snapshot, { clearSelection: true });
        showMessage(`Reconnected as ${snapshot.playerName}.`, "info");
    } catch (error) {
        clearActiveSession();
        showMessage(error.message || "Previous session expired. Register again.", "info");
    } finally {
        setBusy(false);
        render();
    }
}

async function handleRegister(event) {
    event.preventDefault();
    if (state.busy) return;

    const formData = new FormData(refs.registrationForm);
    const name = String(formData.get("name") || "").trim();
    const preferredColor = String(formData.get("preferredColor") || "white");

    setBusy(true);

    try {
        const snapshot = await fetchJson("/api/register", {
            method: "POST",
            body: JSON.stringify({
                name,
                preferredColor,
            }),
        });

        applySnapshot(snapshot, { clearSelection: true });
        persistSession(snapshot);
        showMessage(
            `${snapshot.playerName} registered on ${capitalize(snapshot.playerColor)}.`,
            "success"
        );
    } catch (error) {
        showMessage(error.message || "Registration failed.", "error");
    } finally {
        setBusy(false);
        render();
    }
}

async function handleReset() {
    if (!state.snapshot || state.busy) return;

    setBusy(true);

    try {
        const snapshot = await fetchJson("/api/reset", {
            method: "POST",
            body: JSON.stringify({ playerId: state.snapshot.playerId }),
        });

        applySnapshot(snapshot, { clearSelection: true });
        showMessage("Fresh board ready.", "success");
    } catch (error) {
        showMessage(error.message || "Could not reset the game.", "error");
    } finally {
        setBusy(false);
        render();
    }
}

async function submitMove(from, to) {
    if (!state.snapshot || state.busy) return;

    setBusy(true);

    try {
        const snapshot = await fetchJson("/api/move", {
            method: "POST",
            body: JSON.stringify({
                playerId: state.snapshot.playerId,
                from,
                to,
            }),
        });

        applySnapshot(snapshot, { clearSelection: true });
        showMessage(
            snapshot.botThinking
                ? `Played ${from}-${to}. ${snapshot.botName} is Thinking.`
                : `Played ${from}-${to}.`,
            "success"
        );
    } catch (error) {
        showMessage(error.message || "Move failed.", "error");
    } finally {
        setBusy(false);
        render();
    }
}

async function refreshSnapshot({ announceBotMove = false, silentErrors = false } = {}) {
    if (!state.snapshot || state.busy || state.pollInFlight) return;

    state.pollInFlight = true;

    try {
        const previousSnapshot = state.snapshot;
        const snapshot = await fetchJson(
            `/api/game?playerId=${encodeURIComponent(previousSnapshot.playerId)}`
        );

        applySnapshot(snapshot);

        if (announceBotMove) {
            announceBotMoveIfNeeded(previousSnapshot, snapshot);
        }
    } catch (error) {
        if (shouldClearSession(error)) {
            clearActiveSession();
        }

        if (!silentErrors) {
            showMessage(error.message || "Could not refresh the board.", "error");
        }
    } finally {
        state.pollInFlight = false;
        render();
    }
}

function applySnapshot(snapshot, { clearSelection = false } = {}) {
    state.snapshot = snapshot;
    state.snapshotReceivedAt = Date.now();

    if (clearSelection || !snapshot.isPlayerTurn) {
        state.selectedSquare = null;
    }

    syncPolling();
}

function syncPolling() {
    if (pollTimer) {
        window.clearInterval(pollTimer);
        pollTimer = 0;
    }

    if (!state.snapshot || state.snapshot.phase !== "playing") {
        return;
    }

    pollTimer = window.setInterval(() => {
        void refreshSnapshot({ announceBotMove: true, silentErrors: true });
    }, POLL_INTERVAL_MS);
}

function announceBotMoveIfNeeded(previousSnapshot, nextSnapshot) {
    const previousBotPly = previousSnapshot?.lastBotMove?.ply ?? 0;
    const nextBotMove = nextSnapshot.lastBotMove;

    if (!nextBotMove || nextBotMove.ply === previousBotPly) {
        return;
    }

    const newestMove = nextSnapshot.moves.at(-1);
    if (newestMove?.actor === "bot") {
        showMessage(`${nextSnapshot.botName} played ${nextBotMove.notation}.`, "info");
    }
}

function render() {
    const hasSnapshot = Boolean(state.snapshot);

    document.body.classList.toggle("game-active", hasSnapshot);
    refs.registrationPanel.classList.toggle("hidden", hasSnapshot);
    refs.gamePanel.classList.toggle("hidden", !hasSnapshot);

    refs.registerButton.disabled = state.busy;
    refs.resetButton.disabled = state.busy || !hasSnapshot;

    renderNotice();

    if (!hasSnapshot) {
        refs.statusHeading.textContent = "Waiting for match data";
        refs.statusText.textContent = "Register to begin.";
        refs.movePrompt.textContent = "Click a piece, then a destination square. Promotions auto-queen.";
        refs.thinkingIndicator.className = "thinking-indicator";
        refs.moveList.innerHTML = "";
        refs.moveCount.textContent = "0 plies";
        renderClockPlaceholders();
        return;
    }

    const snapshot = state.snapshot;

    refs.statusHeading.textContent = buildHeading(snapshot);
    refs.statusText.textContent = snapshot.status;
    refs.movePrompt.textContent = buildPrompt(snapshot);
    refs.playerDisplay.textContent = snapshot.playerName;
    refs.playerId.textContent = snapshot.playerId;
    refs.playerColor.textContent = capitalize(snapshot.playerColor);
    refs.botDisplay.textContent = snapshot.botName;
    refs.playerClockLabel.textContent = snapshot.playerName;
    refs.botClockLabel.textContent = snapshot.botName;

    renderThinking(snapshot);
    renderAxes(snapshot.playerColor);
    renderBoard(snapshot);
    renderMoveList(snapshot.moves);
    renderClocks(snapshot);
}

function renderNotice() {
    const notice = state.notice;
    refs.feedback.textContent = notice?.text || "";
    refs.feedback.className = `feedback${notice ? ` is-visible ${notice.tone}` : ""}`;
}

function renderThinking(snapshot) {
    const isVisible = snapshot.phase === "playing" && snapshot.botThinking;
    refs.thinkingIndicator.textContent = `${snapshot.botName} is Thinking`;
    refs.thinkingIndicator.className = `thinking-indicator${isVisible ? " is-visible" : ""}`;
}

function renderAxes(playerColor) {
    const files = playerColor === "white" ? FILES : [...FILES].reverse();
    const ranks = playerColor === "white"
        ? ["8", "7", "6", "5", "4", "3", "2", "1"]
        : ["1", "2", "3", "4", "5", "6", "7", "8"];

    refs.filesTop.replaceChildren(...files.map(createAxisLabel));
    refs.filesBottom.replaceChildren(...files.map(createAxisLabel));
    refs.ranksLeft.replaceChildren(...ranks.map(createAxisLabel));
    refs.ranksRight.replaceChildren(...ranks.map(createAxisLabel));
}

function renderBoard(snapshot) {
    const fileOrder = snapshot.playerColor === "white"
        ? [0, 1, 2, 3, 4, 5, 6, 7]
        : [7, 6, 5, 4, 3, 2, 1, 0];
    const rankOrder = snapshot.playerColor === "white"
        ? [8, 7, 6, 5, 4, 3, 2, 1]
        : [1, 2, 3, 4, 5, 6, 7, 8];
    const legalMap = snapshot.legalTargetsByFrom || {};
    const selectedTargets = new Set(
        state.selectedSquare ? legalMap[state.selectedSquare] || [] : []
    );
    const lastMove = snapshot.moves.at(-1);
    const lastMoveSquares = new Set(lastMove ? [lastMove.from, lastMove.to] : []);
    const isBoardInteractive =
        !state.busy &&
        snapshot.phase === "playing" &&
        snapshot.isPlayerTurn;

    refs.board.classList.toggle("is-busy", state.busy || snapshot.botThinking);
    refs.board.innerHTML = "";

    for (const rank of rankOrder) {
        for (const fileIndex of fileOrder) {
            const squareName = `${FILES[fileIndex]}${rank}`;
            const rowIndex = 8 - rank;
            const pieceCode = snapshot.board[rowIndex][fileIndex];
            const square = document.createElement("button");

            square.type = "button";
            square.dataset.square = squareName;
            square.className = [
                "square",
                (fileIndex + rank) % 2 === 0 ? "light" : "dark",
                state.selectedSquare === squareName ? "selected" : "",
                selectedTargets.has(squareName) ? "legal" : "",
                lastMoveSquares.has(squareName) ? "last-move" : "",
            ].filter(Boolean).join(" ");

            square.disabled = !isBoardInteractive;
            square.setAttribute("aria-label", describeSquare(squareName, pieceCode));
            square.addEventListener("click", () => handleSquareClick(squareName));

            if (pieceCode) {
                const piece = document.createElement("span");
                piece.className = `piece ${pieceCode[0] === "w" ? "piece-white" : "piece-black"}`;
                piece.textContent = PIECE_SYMBOLS[pieceCode];
                square.append(piece);
            }

            refs.board.append(square);
        }
    }
}

function renderMoveList(moves) {
    refs.moveCount.textContent = `${moves.length} ${moves.length === 1 ? "ply" : "plies"}`;

    if (!moves.length) {
        refs.moveList.innerHTML = '<div class="move-list-empty">No moves yet. Register and open the game.</div>';
        return;
    }

    const rows = [];
    for (let index = 0; index < moves.length; index += 2) {
        rows.push({
            turn: Math.floor(index / 2) + 1,
            white: moves[index] || null,
            black: moves[index + 1] || null,
        });
    }

    refs.moveList.replaceChildren(
        ...rows.map((row) => {
            const element = document.createElement("article");
            element.className = "move-row";
            element.innerHTML = `
                <div class="move-turn">${row.turn}.</div>
                <div class="move-cell">
                    <span>White</span>
                    <strong>${row.white ? row.white.notation : "..."}</strong>
                </div>
                <div class="move-cell">
                    <span>Black</span>
                    <strong>${row.black ? row.black.notation : "..."}</strong>
                </div>
            `;
            return element;
        })
    );
}

function renderClocks(snapshot) {
    const { playerMs, botMs } = getDisplayedClockValues(snapshot);
    const playerActive = snapshot.phase === "playing" && snapshot.activeColor === snapshot.playerColor;
    const botActive = snapshot.phase === "playing" && snapshot.activeColor === snapshot.botColor;

    refs.playerClock.textContent = formatClock(playerMs);
    refs.botClock.textContent = formatClock(botMs);
    refs.playerClockRow.className = buildClockRowClass(playerActive, playerMs);
    refs.botClockRow.className = buildClockRowClass(botActive, botMs);
}

function renderClockPlaceholders() {
    refs.playerClockLabel.textContent = "Player";
    refs.botClockLabel.textContent = "Mat Bot";
    refs.playerClock.textContent = "05:00";
    refs.botClock.textContent = "05:00";
    refs.playerClockRow.className = "clock-row";
    refs.botClockRow.className = "clock-row";
}

function getDisplayedClockValues(snapshot) {
    let playerMs = snapshot.playerTimeRemainingMs;
    let botMs = snapshot.botTimeRemainingMs;

    if (snapshot.phase === "playing") {
        const elapsedSinceSnapshot = Math.max(0, Date.now() - state.snapshotReceivedAt);
        if (snapshot.activeColor === snapshot.playerColor) {
            playerMs = Math.max(0, playerMs - elapsedSinceSnapshot);
        } else if (snapshot.activeColor === snapshot.botColor) {
            botMs = Math.max(0, botMs - elapsedSinceSnapshot);
        }
    }

    return { playerMs, botMs };
}

function buildClockRowClass(isActive, timeMs) {
    return [
        "clock-row",
        isActive ? "active" : "",
        timeMs <= LOW_TIME_THRESHOLD_MS ? "low-time" : "",
    ].filter(Boolean).join(" ");
}

function formatClock(timeMs) {
    const totalSeconds = Math.max(0, Math.ceil(timeMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function handleSquareClick(squareName) {
    const snapshot = state.snapshot;
    if (!snapshot || state.busy) return;

    if (snapshot.phase !== "playing") {
        showMessage(snapshot.status, "info");
        render();
        return;
    }

    if (!snapshot.isPlayerTurn) {
        showMessage(snapshot.status, "info");
        render();
        return;
    }

    const legalMap = snapshot.legalTargetsByFrom || {};

    if (!state.selectedSquare) {
        if (legalMap[squareName]) {
            state.selectedSquare = squareName;
        }
        render();
        return;
    }

    if (squareName === state.selectedSquare) {
        state.selectedSquare = null;
        render();
        return;
    }

    const selectedTargets = new Set(legalMap[state.selectedSquare] || []);
    if (selectedTargets.has(squareName)) {
        void submitMove(state.selectedSquare, squareName);
        return;
    }

    if (legalMap[squareName]) {
        state.selectedSquare = squareName;
    } else {
        state.selectedSquare = null;
    }

    render();
}

function showMessage(text, tone) {
    state.notice = { text, tone };
}

function setBusy(nextBusy) {
    state.busy = nextBusy;
    refs.registerButton.disabled = nextBusy;
    refs.resetButton.disabled = nextBusy || !state.snapshot;
}

function persistSession(snapshot) {
    window.localStorage.setItem(STORAGE_KEY, snapshot.playerId);
    window.localStorage.setItem(STORAGE_NAME_KEY, snapshot.playerName);
}

function clearSession() {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(STORAGE_NAME_KEY);
}

function clearActiveSession() {
    clearSession();
    state.snapshot = null;
    state.snapshotReceivedAt = 0;
    state.selectedSquare = null;
    syncPolling();
}

function shouldClearSession(error) {
    return typeof error.message === "string" && error.message.includes("No active player registration");
}

async function fetchJson(url, options = {}) {
    const init = { ...options };
    init.headers = new Headers(options.headers || {});

    if (init.body && !init.headers.has("content-type")) {
        init.headers.set("content-type", "application/json");
    }

    const response = await fetch(url, init);
    const rawText = await response.text();
    const data = rawText ? safeJsonParse(rawText) : null;

    if (!response.ok) {
        const message = data && typeof data === "object" && "error" in data
            ? data.error
            : rawText || "Request failed.";
        throw new Error(message);
    }

    return data;
}

function safeJsonParse(rawText) {
    try {
        return JSON.parse(rawText);
    } catch {
        throw new Error(rawText);
    }
}

function buildHeading(snapshot) {
    if (snapshot.phase === "checkmate") return "Checkmate";
    if (snapshot.phase === "stalemate") return "Stalemate";
    if (snapshot.phase === "timeout") return "Time";
    return snapshot.botThinking ? `${snapshot.botName} Thinking` : "Your Move";
}

function buildPrompt(snapshot) {
    if (snapshot.phase === "checkmate" || snapshot.phase === "stalemate" || snapshot.phase === "timeout") {
        return "Use New Game for another round. Promotions auto-queen.";
    }

    if (snapshot.botThinking) {
        return `Your move is registered. ${snapshot.botName} is Thinking.`;
    }

    return "Click a piece, then a destination square. Promotions auto-queen.";
}

function createAxisLabel(value) {
    const span = document.createElement("span");
    span.textContent = value;
    return span;
}

function describeSquare(squareName, pieceCode) {
    if (!pieceCode) return `${squareName}, empty square`;
    return `${squareName}, ${describePiece(pieceCode)}`;
}

function describePiece(pieceCode) {
    const color = pieceCode[0] === "w" ? "white" : "black";
    const typeMap = {
        K: "king",
        Q: "queen",
        R: "rook",
        B: "bishop",
        N: "knight",
        P: "pawn",
    };
    return `${color} ${typeMap[pieceCode[1]]}`;
}

function capitalize(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
}
