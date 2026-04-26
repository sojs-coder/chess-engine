import { describe, expect, test } from "bun:test";
import {
  applyMove,
  createInitialBoard,
  notationToCoordinate,
  renderGamePgn,
  renderMoveAsSan,
  type Board,
  type Game,
  type MoveRecord,
  type Piece,
} from "../index.ts";

describe("PGN rendering", () => {
  test("renders castling as SAN", () => {
    const game = createGame({
      board: boardFromPieces([
        ["E1", { color: "white", type: "king" }],
        ["H1", { color: "white", type: "rook" }],
        ["E8", { color: "black", type: "king" }],
      ]),
      castlingRights: {
        whiteKingSide: true,
        whiteQueenSide: false,
        blackKingSide: false,
        blackQueenSide: false,
      },
    });

    const san = renderMoveAsSan(game, notationToCoordinate("E1"), notationToCoordinate("G1"));

    expect(san).toBe("O-O");
  });

  test("disambiguates SAN when two pieces can reach the same square", () => {
    const game = createGame({
      board: boardFromPieces([
        ["E1", { color: "white", type: "king" }],
        ["G1", { color: "white", type: "knight" }],
        ["C3", { color: "white", type: "knight" }],
        ["E8", { color: "black", type: "king" }],
      ]),
    });

    const san = renderMoveAsSan(game, notationToCoordinate("G1"), notationToCoordinate("E2"));

    expect(san).toBe("Nge2");
  });

  test("renders a full PGN game into the txt artifact format", () => {
    const game = createGame({ board: createInitialBoard() });

    recordMove(game, "white", "E2", "E4");
    recordMove(game, "black", "E7", "E5");
    recordMove(game, "white", "G1", "F3");

    game.status = "finished";
    game.result = {
      winnerPlayerId: game.whitePlayerId,
      loserPlayerId: game.blackPlayerId,
      reason: "black failed to return a move",
    };
    game.finishedAt = "2026-04-25T00:01:00.000Z";

    const pgn = renderGamePgn(game);

    expect(pgn).toContain('[White "white-player"]');
    expect(pgn).toContain('[Black "black-player"]');
    expect(pgn).toContain('[Result "1-0"]');
    expect(pgn).toContain('[Termination "black failed to return a move"]');
    expect(pgn).toContain("1. e4 e5 2. Nf3 1-0");
  });
});

function createGame(overrides: Partial<Game> = {}): Game {
  return {
    id: "game-id",
    status: "active",
    whitePlayerId: "white-player",
    blackPlayerId: "black-player",
    board: emptyBoard(),
    turn: "white",
    createdAt: "2026-04-25T00:00:00.000Z",
    startedAt: "2026-04-25T00:00:00.000Z",
    startTimeMinutes: 5,
    incrementSeconds: 0,
    remainingTimeSeconds: {
      white: 300,
      black: 300,
    },
    moves: [],
    moveIndex: 1,
    enPassantTarget: null,
    castlingRights: {
      whiteKingSide: true,
      whiteQueenSide: true,
      blackKingSide: true,
      blackQueenSide: true,
    },
    halfMoveClock: 0,
    positionCounts: new Map(),
    ...overrides,
  };
}

function emptyBoard(): Board {
  return Array.from({ length: 8 }, () => Array<Piece | null>(8).fill(null));
}

function boardFromPieces(entries: Array<[string, Piece]>): Board {
  const board = emptyBoard();

  for (const [square, piece] of entries) {
    const { row, col } = notationToCoordinate(square);
    board[row][col] = piece;
  }

  return board;
}

function recordMove(game: Game, color: "white" | "black", fromNotation: string, toNotation: string): void {
  const from = notationToCoordinate(fromNotation);
  const to = notationToCoordinate(toNotation);
  const piece = game.board[from.row][from.col];

  if (!piece) {
    throw new Error(`Missing piece on ${fromNotation}`);
  }

  const applied = applyMove(game, from, to);
  const moveRecord: MoveRecord = {
    from: fromNotation,
    to: toNotation,
    color,
    piece: piece.type,
    playerId: color === "white" ? game.whitePlayerId : game.blackPlayerId,
    durationMs: 1000,
    remainingTimeSeconds: game.remainingTimeSeconds[color],
    captured: applied.captured?.type,
    promotion: applied.promotion,
    castling: applied.castling,
    enPassant: applied.enPassant,
  };

  game.moves.push(moveRecord);
  game.turn = color === "white" ? "black" : "white";
  if (color === "black") {
    game.moveIndex += 1;
  }
}
