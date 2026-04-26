import { describe, expect, test } from "bun:test";
import {
  applyMove,
  getLegalMovesForPiece,
  notationToCoordinate,
  type Board,
  type Game,
  type Piece,
} from "../index.ts";

describe("special move logic", () => {
  test("allows and applies white king-side castling", () => {
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

    const legalMoves = getLegalMovesForPiece(game, notationToCoordinate("E1"));
    expect(hasMoveTo(legalMoves, "G1")).toBe(true);

    const applied = applyMove(game, notationToCoordinate("E1"), notationToCoordinate("G1"));

    expect(applied.castling).toBe("king-side");
    expect(pieceAt(game.board, "G1")).toMatchObject({ color: "white", type: "king" });
    expect(pieceAt(game.board, "F1")).toMatchObject({ color: "white", type: "rook" });
    expect(pieceAt(game.board, "E1")).toBeNull();
    expect(pieceAt(game.board, "H1")).toBeNull();
    expect(game.castlingRights).toMatchObject({
      whiteKingSide: false,
      whiteQueenSide: false,
    });
  });

  test("allows and applies white queen-side castling", () => {
    const game = createGame({
      board: boardFromPieces([
        ["A1", { color: "white", type: "rook" }],
        ["E1", { color: "white", type: "king" }],
        ["E8", { color: "black", type: "king" }],
      ]),
      castlingRights: {
        whiteKingSide: false,
        whiteQueenSide: true,
        blackKingSide: false,
        blackQueenSide: false,
      },
    });

    const legalMoves = getLegalMovesForPiece(game, notationToCoordinate("E1"));
    expect(hasMoveTo(legalMoves, "C1")).toBe(true);

    const applied = applyMove(game, notationToCoordinate("E1"), notationToCoordinate("C1"));

    expect(applied.castling).toBe("queen-side");
    expect(pieceAt(game.board, "C1")).toMatchObject({ color: "white", type: "king" });
    expect(pieceAt(game.board, "D1")).toMatchObject({ color: "white", type: "rook" });
    expect(pieceAt(game.board, "A1")).toBeNull();
    expect(pieceAt(game.board, "E1")).toBeNull();
    expect(game.castlingRights).toMatchObject({
      whiteKingSide: false,
      whiteQueenSide: false,
    });
  });

  test("disallows castling through an attacked square", () => {
    const game = createGame({
      board: boardFromPieces([
        ["E1", { color: "white", type: "king" }],
        ["H1", { color: "white", type: "rook" }],
        ["F8", { color: "black", type: "rook" }],
        ["E8", { color: "black", type: "king" }],
      ]),
      castlingRights: {
        whiteKingSide: true,
        whiteQueenSide: false,
        blackKingSide: false,
        blackQueenSide: false,
      },
    });

    const legalMoves = getLegalMovesForPiece(game, notationToCoordinate("E1"));
    expect(hasMoveTo(legalMoves, "G1")).toBe(false);
  });

  test("creates and applies en passant correctly", () => {
    const game = createGame({
      board: boardFromPieces([
        ["E1", { color: "white", type: "king" }],
        ["E5", { color: "white", type: "pawn" }],
        ["D7", { color: "black", type: "pawn" }],
        ["E8", { color: "black", type: "king" }],
      ]),
    });

    applyMove(game, notationToCoordinate("D7"), notationToCoordinate("D5"));
    expect(game.enPassantTarget).toBe("D6");

    const legalMoves = getLegalMovesForPiece(game, notationToCoordinate("E5"));
    expect(hasMoveTo(legalMoves, "D6")).toBe(true);

    const applied = applyMove(game, notationToCoordinate("E5"), notationToCoordinate("D6"));

    expect(applied.enPassant).toBe(true);
    expect(applied.captured).toMatchObject({ color: "black", type: "pawn" });
    expect(pieceAt(game.board, "D6")).toMatchObject({ color: "white", type: "pawn" });
    expect(pieceAt(game.board, "D5")).toBeNull();
    expect(pieceAt(game.board, "E5")).toBeNull();
    expect(game.enPassantTarget).toBeNull();
  });

  test("auto-promotes pawns to queens on the back rank", () => {
    const game = createGame({
      board: boardFromPieces([
        ["E1", { color: "white", type: "king" }],
        ["A7", { color: "white", type: "pawn" }],
        ["E8", { color: "black", type: "king" }],
      ]),
    });

    const applied = applyMove(game, notationToCoordinate("A7"), notationToCoordinate("A8"));

    expect(applied.promotion).toBe("queen");
    expect(pieceAt(game.board, "A8")).toMatchObject({ color: "white", type: "queen" });
    expect(pieceAt(game.board, "A7")).toBeNull();
  });

  test("disallows en passant when it would expose the king to check", () => {
    const game = createGame({
      board: boardFromPieces([
        ["E1", { color: "white", type: "king" }],
        ["E5", { color: "white", type: "pawn" }],
        ["D5", { color: "black", type: "pawn" }],
        ["E8", { color: "black", type: "rook" }],
        ["A8", { color: "black", type: "king" }],
      ]),
      enPassantTarget: "D6",
    });

    const legalMoves = getLegalMovesForPiece(game, notationToCoordinate("E5"));
    expect(hasMoveTo(legalMoves, "D6")).toBe(false);
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

function pieceAt(board: Board, square: string): Piece | null {
  const { row, col } = notationToCoordinate(square);
  return board[row][col];
}

function hasMoveTo(moves: Array<{ to: { row: number; col: number } }>, square: string): boolean {
  const target = notationToCoordinate(square);
  return moves.some((move) => move.to.row === target.row && move.to.col === target.col);
}
