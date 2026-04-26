import { randomUUID } from "node:crypto";
import { Board } from "./Board";
import { findBestMove } from "./engine";
import { Color, Move, Piece, PieceType, Square } from "./types";

const BOT_NAME = "Mat Bot";
const DEFAULT_PLAYER_NAME = "Guest Player";
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const PIECE_CODES: Record<PieceType, string> = {
    [PieceType.Pawn]: "P",
    [PieceType.Knight]: "N",
    [PieceType.Bishop]: "B",
    [PieceType.Rook]: "R",
    [PieceType.Queen]: "Q",
    [PieceType.King]: "K",
};

const rawBotThinkSeconds = Number(process.env.LOCAL_BOT_THINK_SECONDS ?? "0.8");
const LOCAL_BOT_THINK_SECONDS = Number.isFinite(rawBotThinkSeconds)
    ? rawBotThinkSeconds
    : 0.8;

const rawClockSeconds = Number(process.env.LOCAL_CLOCK_SECONDS ?? "300");
const LOCAL_CLOCK_MS = Math.max(
    30_000,
    Math.round((Number.isFinite(rawClockSeconds) ? rawClockSeconds : 300) * 1000)
);

export type PlayerColorChoice = "white" | "black" | "random";

type RegisterLocalPlayerInput = {
    name?: string;
    preferredColor?: PlayerColorChoice;
};

type SubmitLocalPlayerMoveInput = {
    playerId?: string;
    from?: string;
    to?: string;
};

type GamePhase = "playing" | "checkmate" | "stalemate" | "timeout";
type GameWinner = "player" | "bot" | null;
type MoveActor = "player" | "bot";

type LocalGameSession = {
    playerId: string;
    playerName: string;
    humanColor: Color;
    botColor: Color;
    board: Board;
    moves: LocalMoveRecord[];
    lastBotMove: LocalMoveRecord | null;
    phase: GamePhase;
    winner: GameWinner;
    botThinking: boolean;
    playerTimeRemainingMs: number;
    botTimeRemainingMs: number;
    turnStartedAtMs: number;
    botTaskId: number;
    createdAt: string;
    updatedAt: string;
};

export type LocalMoveRecord = {
    ply: number;
    actor: MoveActor;
    color: Color;
    from: string;
    to: string;
    notation: string;
    autoPromotion: PieceType | null;
};

export type LocalGameSnapshot = {
    playerId: string;
    playerName: string;
    botName: string;
    playerColor: Color;
    botColor: Color;
    board: (string | null)[][];
    activeColor: Color;
    isPlayerTurn: boolean;
    botThinking: boolean;
    status: string;
    phase: GamePhase;
    winner: GameWinner;
    inCheck: boolean;
    legalTargetsByFrom: Record<string, string[]>;
    moves: LocalMoveRecord[];
    lastBotMove: LocalMoveRecord | null;
    playerTimeRemainingMs: number;
    botTimeRemainingMs: number;
    clockCapturedAt: string;
};

export class LocalGameError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.name = "LocalGameError";
        this.statusCode = statusCode;
    }
}

const sessions = new Map<string, LocalGameSession>();

export function registerLocalPlayer(input: RegisterLocalPlayerInput = {}): LocalGameSnapshot {
    const createdAtMs = Date.now();
    const createdAt = toIso(createdAtMs);
    const humanColor = resolvePlayerColor(input.preferredColor);
    const board = new Board();

    const session: LocalGameSession = {
        playerId: randomUUID(),
        playerName: normalizeName(input.name),
        humanColor,
        botColor: oppositeColor(humanColor),
        board,
        moves: [],
        lastBotMove: null,
        phase: "playing",
        winner: null,
        botThinking: false,
        playerTimeRemainingMs: LOCAL_CLOCK_MS,
        botTimeRemainingMs: LOCAL_CLOCK_MS,
        turnStartedAtMs: createdAtMs,
        botTaskId: 0,
        createdAt,
        updatedAt: createdAt,
    };

    sessions.set(session.playerId, session);

    if (board.getActiveColor() === session.botColor) {
        queueBotTurn(session);
    }

    return toSnapshot(session);
}

export function getLocalGameSnapshot(playerId: string): LocalGameSnapshot {
    const session = requireSession(playerId);
    refreshClockExpiration(session);
    return toSnapshot(session);
}

export function resetLocalGame(playerId: string): LocalGameSnapshot {
    const session = requireSession(playerId);
    const now = Date.now();

    session.botTaskId += 1;
    session.board = new Board();
    session.moves = [];
    session.lastBotMove = null;
    session.phase = "playing";
    session.winner = null;
    session.botThinking = false;
    session.playerTimeRemainingMs = LOCAL_CLOCK_MS;
    session.botTimeRemainingMs = LOCAL_CLOCK_MS;
    session.turnStartedAtMs = now;
    session.updatedAt = toIso(now);

    if (session.board.getActiveColor() === session.botColor) {
        queueBotTurn(session);
    }

    return toSnapshot(session);
}

export function submitLocalPlayerMove(input: SubmitLocalPlayerMoveInput): LocalGameSnapshot {
    const session = requireSession(input.playerId);
    refreshClockExpiration(session);

    if (session.phase !== "playing") {
        throw new LocalGameError(409, "This game is finished. Start a new game to keep playing.");
    }

    if (session.botThinking || session.board.getActiveColor() !== session.humanColor) {
        throw new LocalGameError(409, `${BOT_NAME} is Thinking.`);
    }

    const from = parseSquare(input.from);
    const to = parseSquare(input.to);

    if (!from || !to) {
        throw new LocalGameError(400, "Moves must use coordinates like e2 and e4.");
    }

    const piece = session.board.getPiece(from);
    if (!piece || piece.color !== session.humanColor) {
        throw new LocalGameError(400, "Select one of your own pieces.");
    }

    const moveAppliedAt = Date.now();
    consumeActiveTurnTime(session, moveAppliedAt);

    if (session.phase !== "playing") {
        throw new LocalGameError(409, `${BOT_NAME} wins on time.`);
    }

    const autoPromotion = getAutoPromotion(piece, to);
    const move: Move = autoPromotion ? { from, to, promotion: autoPromotion } : { from, to };

    if (!session.board.makeMove(move)) {
        throw new LocalGameError(400, "That move is not legal in the current position.");
    }

    recordMove(session, "player", move, autoPromotion, moveAppliedAt);
    refreshOutcome(session, moveAppliedAt);

    if (session.phase === "playing") {
        session.turnStartedAtMs = moveAppliedAt;
        queueBotTurn(session);
    } else {
        session.botThinking = false;
        session.updatedAt = toIso(moveAppliedAt);
    }

    return toSnapshot(session);
}

function requireSession(playerId: string | undefined): LocalGameSession {
    const normalizedId = playerId?.trim();
    if (!normalizedId) {
        throw new LocalGameError(400, "Missing playerId.");
    }

    const session = sessions.get(normalizedId);
    if (!session) {
        throw new LocalGameError(404, "No active player registration was found for that id.");
    }

    return session;
}

function queueBotTurn(session: LocalGameSession): void {
    if (session.phase !== "playing" || session.board.getActiveColor() !== session.botColor) {
        return;
    }

    session.botTaskId += 1;
    const taskId = session.botTaskId;
    session.botThinking = true;
    session.updatedAt = toIso();

    setTimeout(() => {
        executeBotTurn(session.playerId, taskId);
    }, 0);
}

function executeBotTurn(playerId: string, taskId: number): void {
    const session = sessions.get(playerId);
    if (
        !session ||
        session.botTaskId !== taskId ||
        session.phase !== "playing" ||
        session.board.getActiveColor() !== session.botColor ||
        !session.botThinking
    ) {
        return;
    }

    refreshClockExpiration(session);
    if (session.phase !== "playing") {
        return;
    }

    const botMove = findBestMove(session.board, session.botColor, LOCAL_BOT_THINK_SECONDS);
    const moveAppliedAt = Date.now();

    const latestSession = sessions.get(playerId);
    if (
        !latestSession ||
        latestSession.botTaskId !== taskId ||
        latestSession.phase !== "playing" ||
        latestSession.board.getActiveColor() !== latestSession.botColor ||
        !latestSession.botThinking
    ) {
        return;
    }

    consumeActiveTurnTime(latestSession, moveAppliedAt);
    if (latestSession.phase !== "playing") {
        return;
    }

    if (!botMove) {
        latestSession.botThinking = false;
        refreshOutcome(latestSession, moveAppliedAt);
        if (latestSession.phase === "playing") {
            latestSession.turnStartedAtMs = moveAppliedAt;
            latestSession.updatedAt = toIso(moveAppliedAt);
        }
        return;
    }

    const botPiece = latestSession.board.getPiece(botMove.from);
    const autoPromotion = botPiece ? getAutoPromotion(botPiece, botMove.to) : null;
    const move: Move = autoPromotion
        ? { ...botMove, promotion: autoPromotion }
        : botMove;

    if (!latestSession.board.makeMove(move)) {
        console.error("The bot produced an illegal move.");
        latestSession.botThinking = false;
        latestSession.phase = "timeout";
        latestSession.winner = "player";
        latestSession.botTimeRemainingMs = 0;
        latestSession.updatedAt = toIso(moveAppliedAt);
        return;
    }

    latestSession.botThinking = false;
    recordMove(latestSession, "bot", move, autoPromotion, moveAppliedAt);
    refreshOutcome(latestSession, moveAppliedAt);

    if (latestSession.phase === "playing") {
        latestSession.turnStartedAtMs = moveAppliedAt;
        latestSession.updatedAt = toIso(moveAppliedAt);
    }
}

function refreshOutcome(session: LocalGameSession, timestampMs: number = Date.now()): void {
    if (session.board.isCheckmate()) {
        session.phase = "checkmate";
        session.winner = session.board.getActiveColor() === session.humanColor ? "bot" : "player";
    } else if (session.board.isStalemate()) {
        session.phase = "stalemate";
        session.winner = null;
    } else {
        session.phase = "playing";
        session.winner = null;
    }

    session.updatedAt = toIso(timestampMs);
}

function recordMove(
    session: LocalGameSession,
    actor: MoveActor,
    move: Move,
    autoPromotion: PieceType | null,
    timestampMs: number = Date.now()
): void {
    const from = squareToCoordinate(move.from);
    const to = squareToCoordinate(move.to);
    const record: LocalMoveRecord = {
        ply: session.moves.length + 1,
        actor,
        color: actor === "player" ? session.humanColor : session.botColor,
        from,
        to,
        notation: `${from}-${to}${autoPromotion ? `=${PIECE_CODES[autoPromotion]}` : ""}`,
        autoPromotion,
    };

    session.moves.push(record);
    if (actor === "bot") session.lastBotMove = record;
    session.updatedAt = toIso(timestampMs);
}

function toSnapshot(session: LocalGameSession): LocalGameSnapshot {
    refreshClockExpiration(session);

    const now = Date.now();
    const inCheck = session.phase === "playing" ? session.board.isInCheck() : false;
    const isPlayerTurn =
        session.phase === "playing" &&
        session.board.getActiveColor() === session.humanColor &&
        !session.botThinking;

    return {
        playerId: session.playerId,
        playerName: session.playerName,
        botName: BOT_NAME,
        playerColor: session.humanColor,
        botColor: session.botColor,
        board: serializeBoard(session.board),
        activeColor: session.board.getActiveColor(),
        isPlayerTurn,
        botThinking: session.botThinking,
        status: buildStatus(session, inCheck),
        phase: session.phase,
        winner: session.winner,
        inCheck,
        legalTargetsByFrom: buildLegalTargetsByFrom(session.board, session.humanColor, session.phase),
        moves: [...session.moves],
        lastBotMove: session.lastBotMove,
        playerTimeRemainingMs: getRemainingTimeMs(session, session.humanColor, now),
        botTimeRemainingMs: getRemainingTimeMs(session, session.botColor, now),
        clockCapturedAt: toIso(now),
    };
}

function buildStatus(session: LocalGameSession, inCheck: boolean): string {
    if (session.phase === "timeout") {
        return session.winner === "player"
            ? `${session.playerName} wins on time.`
            : `${BOT_NAME} wins on time.`;
    }

    if (session.phase === "checkmate") {
        return session.winner === "player"
            ? `${session.playerName} wins by checkmate.`
            : `${BOT_NAME} wins by checkmate.`;
    }

    if (session.phase === "stalemate") {
        return "Stalemate. No legal moves remain.";
    }

    if (session.board.getActiveColor() === session.humanColor) {
        return inCheck
            ? `${session.playerName}, you are in check.`
            : `${session.playerName}, make your move.`;
    }

    return `${BOT_NAME} is Thinking.`;
}

function buildLegalTargetsByFrom(
    board: Board,
    humanColor: Color,
    phase: GamePhase
): Record<string, string[]> {
    if (phase !== "playing" || board.getActiveColor() !== humanColor) {
        return {};
    }

    const legalTargetsByFrom: Record<string, string[]> = {};

    for (let rank = 0; rank < 8; rank++) {
        for (let file = 0; file < 8; file++) {
            const from = { file, rank };
            const legalMoves = board.getLegalMoves(from);
            if (legalMoves.length === 0) continue;

            legalTargetsByFrom[squareToCoordinate(from)] = legalMoves.map((move) =>
                squareToCoordinate(move.to)
            );
        }
    }

    return legalTargetsByFrom;
}

function serializeBoard(board: Board): (string | null)[][] {
    const grid = board.getBoard();
    return Array.from({ length: 8 }, (_, wireRow) =>
        Array.from({ length: 8 }, (_, file) => encodePiece(grid[7 - wireRow][file]))
    );
}

function encodePiece(piece: Piece | null): string | null {
    if (!piece) return null;
    return `${piece.color === Color.White ? "w" : "b"}${PIECE_CODES[piece.type]}`;
}

function parseSquare(square: string | undefined): Square | null {
    const normalized = square?.trim().toLowerCase();
    if (!normalized || !/^[a-h][1-8]$/.test(normalized)) return null;

    return {
        file: normalized.charCodeAt(0) - "a".charCodeAt(0),
        rank: Number(normalized[1]) - 1,
    };
}

function squareToCoordinate(square: Square): string {
    return `${FILES[square.file]}${square.rank + 1}`;
}

function normalizeName(name: string | undefined): string {
    const normalized = name?.trim().replace(/\s+/g, " ").slice(0, 32);
    return normalized || DEFAULT_PLAYER_NAME;
}

function resolvePlayerColor(choice: PlayerColorChoice | undefined): Color {
    if (choice === "black") return Color.Black;
    if (choice === "random") {
        return Math.random() < 0.5 ? Color.White : Color.Black;
    }
    return Color.White;
}

function oppositeColor(color: Color): Color {
    return color === Color.White ? Color.Black : Color.White;
}

function getAutoPromotion(piece: Piece, to: Square): PieceType | null {
    if (piece.type !== PieceType.Pawn) return null;

    if (
        (piece.color === Color.White && to.rank === 7) ||
        (piece.color === Color.Black && to.rank === 0)
    ) {
        return PieceType.Queen;
    }

    return null;
}

function getRemainingTimeMs(
    session: LocalGameSession,
    color: Color,
    now: number = Date.now()
): number {
    const baseTimeMs = color === session.humanColor
        ? session.playerTimeRemainingMs
        : session.botTimeRemainingMs;

    if (session.phase !== "playing" || session.board.getActiveColor() !== color) {
        return Math.max(0, baseTimeMs);
    }

    return Math.max(0, baseTimeMs - (now - session.turnStartedAtMs));
}

function consumeActiveTurnTime(
    session: LocalGameSession,
    now: number = Date.now()
): void {
    if (session.phase !== "playing") return;

    const activeColor = session.board.getActiveColor();
    const remainingTimeMs = getRemainingTimeMs(session, activeColor, now);

    if (activeColor === session.humanColor) {
        session.playerTimeRemainingMs = remainingTimeMs;
    } else {
        session.botTimeRemainingMs = remainingTimeMs;
    }

    session.turnStartedAtMs = now;
    session.updatedAt = toIso(now);

    if (remainingTimeMs === 0) {
        session.phase = "timeout";
        session.winner = activeColor === session.humanColor ? "bot" : "player";
        session.botThinking = false;
    }
}

function refreshClockExpiration(
    session: LocalGameSession,
    now: number = Date.now()
): void {
    if (session.phase !== "playing") return;

    const activeColor = session.board.getActiveColor();
    const remainingTimeMs = getRemainingTimeMs(session, activeColor, now);
    if (remainingTimeMs > 0) return;

    if (activeColor === session.humanColor) {
        session.playerTimeRemainingMs = 0;
        session.winner = "bot";
    } else {
        session.botTimeRemainingMs = 0;
        session.winner = "player";
    }

    session.phase = "timeout";
    session.botThinking = false;
    session.turnStartedAtMs = now;
    session.updatedAt = toIso(now);
}

function toIso(timestampMs: number = Date.now()): string {
    return new Date(timestampMs).toISOString();
}
