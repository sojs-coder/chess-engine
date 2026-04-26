import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Board } from "./Board";
import { search } from "./Tree";
import { Color, Move, Piece, PieceType, Square } from "./types";

const PORT = Number(process.env.PORT ?? "4003");
const FILES = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;

type CastlingRights = {
  whiteKingSide: boolean;
  whiteQueenSide: boolean;
  blackKingSide: boolean;
  blackQueenSide: boolean;
};

type MoveRequest = {
  turn: Color;
  playerId: string;
  whitePlayerId: string;
  blackPlayerId: string;
  // orchestrator sends roundAdditionalSeconds; some builds use incrementSeconds
  roundAdditionalSeconds?: number;
  incrementSeconds?: number;
  board: string[][];
  castlingRights: CastlingRights;
  enPassantTarget: string | null;
};

createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "POST" && req.url === "/move") {
    await handleMove(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
}).listen(PORT, () => {
  console.log(`Mat algo player listening on port ${PORT}`);
});

async function handleMove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const engineColor = inferColor(body);
  const board = buildBoard(body);
  const roundAdditionalSeconds = body.roundAdditionalSeconds ?? body.incrementSeconds ?? 2;

  const move = findBestMove(board, engineColor, roundAdditionalSeconds);

  if (!move) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("A1,A1");
    return;
  }

  const response = `${squareToNotation(move.from)},${squareToNotation(move.to)}`;
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(response);
}

function inferColor(body: MoveRequest): Color {
  if (body.playerId && body.whitePlayerId && body.blackPlayerId) {
    return body.playerId === body.whitePlayerId ? Color.White : Color.Black;
  }
  return body.turn === "white" ? Color.White : Color.Black;
}

/**
 * Iterative deepening search with a time budget.
 *
 * Always completes at least 4 plies. Keeps searching deeper until
 * time_exploring > roundAdditionalSeconds - 0.5 (0.5s buffer for latency).
 * Returns the best move from the last fully completed search.
 */
function findBestMove(board: Board, engineColor: Color, roundAdditionalSeconds: number): Move | null {
  const timeBudgetMs = Math.max(0, roundAdditionalSeconds - 0.5) * 1000;
  const startTime = Date.now();

  let bestMove = search(board, 4, engineColor);

  if (timeBudgetMs <= 0) return bestMove;

  for (let depth = 5; ; depth++) {
    if (Date.now() - startTime >= timeBudgetMs) break;

    const move = search(board, depth, engineColor);
    if (move !== null) bestMove = move;

    if (Date.now() - startTime >= timeBudgetMs) break;
  }

  return bestMove;
}

function buildBoard(body: MoveRequest): Board {
  const pieces = parseWireBoard(body.board);
  const activeColor = body.turn === "white" ? Color.White : Color.Black;
  const enPassant = parseEnPassantTarget(body.enPassantTarget);
  return Board.fromPosition(pieces, activeColor, body.castlingRights, enPassant);
}

/**
 * Converts the wire board format to mat_algo's rank-indexed piece matrix.
 *
 * Wire:     row 0 = rank 8 (black back rank), row 7 = rank 1 (white back rank)
 * mat_algo: rank 0 = rank 1 (white back rank), rank 7 = rank 8 (black back rank)
 */
function parseWireBoard(rawBoard: string[][]): (Piece | null)[][] {
  const result: (Piece | null)[][] = Array(8).fill(null).map(() => Array(8).fill(null));
  for (let wireRow = 0; wireRow < 8; wireRow++) {
    const rank = 7 - wireRow;
    for (let file = 0; file < 8; file++) {
      result[rank][file] = parseWirePiece(rawBoard[wireRow][file]);
    }
  }
  return result;
}

function parseWirePiece(cell: string): Piece | null {
  if (!cell || cell.length < 2) return null;
  const color = cell[0] === "w" ? Color.White : Color.Black;
  const pieceMap: Record<string, PieceType> = {
    P: PieceType.Pawn,
    R: PieceType.Rook,
    N: PieceType.Knight,
    B: PieceType.Bishop,
    Q: PieceType.Queen,
    K: PieceType.King,
  };
  const type = pieceMap[cell[1]];
  if (!type) return null;
  return { color, type };
}

/**
 * Parses an algebraic en passant target like "e3" into a Square.
 * Returns null if the target is absent or malformed.
 */
function parseEnPassantTarget(target: string | null): Square | null {
  if (!target || target.length < 2) return null;
  const file = target.charCodeAt(0) - "a".charCodeAt(0);
  const rank = parseInt(target[1], 10) - 1;
  if (file < 0 || file > 7 || isNaN(rank) || rank < 0 || rank > 7) return null;
  return { file, rank };
}

function squareToNotation(square: Square): string {
  return `${FILES[square.file]}${square.rank + 1}`;
}

async function readJsonBody(req: IncomingMessage): Promise<MoveRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as MoveRequest;
}
