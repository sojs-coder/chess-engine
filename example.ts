import { createServer, IncomingMessage, ServerResponse } from "node:http";

type Color = "white" | "black";
type PieceType = "pawn" | "rook" | "knight" | "bishop" | "queen" | "king";
type GameStatus = "pending" | "active" | "finished";

type Piece = {
  color: Color;
  type: PieceType;
};

type Coordinate = {
  row: number;
  col: number;
};

type Board = Array<Array<Piece | null>>;

type CastlingRights = {
  whiteKingSide: boolean;
  whiteQueenSide: boolean;
  blackKingSide: boolean;
  blackQueenSide: boolean;
};

type MoveRecord = {
  from: string;
  to: string;
  color: Color;
  piece: PieceType;
  playerId: string;
  durationMs: number;
  remainingTimeSeconds: number;
  captured?: PieceType;
  promotion?: PieceType;
  castling?: "king-side" | "queen-side";
  enPassant?: boolean;
};

type GameResult = {
  winnerPlayerId: string | null;
  loserPlayerId: string | null;
  reason: string;
};

type MoveRequest = {
  id: string;
  status: GameStatus;
  whitePlayerId: string;
  blackPlayerId: string;
  turn: Color;
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
  startTimeMinutes: number;
  incrementSeconds: number;
  remainingTimeSeconds: Record<Color, number>;
  moves: MoveRecord[];
  moveIndex: number;
  enPassantTarget: string | null;
  castlingRights: CastlingRights;
  halfMoveClock: number;
  positionCounts: Record<string, number>;
  result?: GameResult;
  board: string[][];
  playerId: string;
  lastError: string | null;
};

type ParsedMove = {
  from: Coordinate;
  to: Coordinate;
};

const PORT = Number(process.env.PORT ?? "4001");
const FILES = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;

createServer(async (req, res) => {
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
  console.log(`Example TS player listening on port ${PORT}`);
});

async function handleMove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const board = deserializeBoard(body.board);
  const color = body.turn;
  const legalMoves = getAllPseudoLegalMoves(board, color);

  if (legalMoves.length === 0) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("A1,A1");
    return;
  }

  const move = legalMoves[Math.floor(Math.random() * legalMoves.length)];
  const response = `${coordinateToNotation(move.from)},${coordinateToNotation(move.to)}`;

  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(response);
}

function deserializeBoard(rawBoard: unknown): Board {
  if (!Array.isArray(rawBoard)) {
    throw new Error("Invalid board");
  }

  return rawBoard.map((row) => {
    if (!Array.isArray(row)) {
      throw new Error("Invalid board row");
    }

    return row.map((cell) => parsePiece(cell));
  });
}

function parsePiece(cell: unknown): Piece | null {
  if (typeof cell !== "string" || cell.length === 0) {
    return null;
  }

  const color = cell[0] === "w" ? "white" : "black";
  const pieceMap: Record<string, PieceType> = {
    P: "pawn",
    R: "rook",
    N: "knight",
    B: "bishop",
    Q: "queen",
    K: "king",
  };

  const type = pieceMap[cell[1]];
  if (!type) {
    throw new Error(`Unknown piece: ${cell}`);
  }

  return { color, type };
}

function getAllPseudoLegalMoves(board: Board, color: Color): ParsedMove[] {
  const moves: ParsedMove[] = [];

  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const piece = board[row][col];
      if (!piece || piece.color !== color) {
        continue;
      }

      const from = { row, col };
      for (const to of getPseudoLegalTargets(board, from)) {
        moves.push({ from, to });
      }
    }
  }

  return moves;
}

function getPseudoLegalTargets(board: Board, from: Coordinate): Coordinate[] {
  const piece = board[from.row][from.col];
  if (!piece) {
    return [];
  }

  switch (piece.type) {
    case "pawn":
      return getPawnTargets(board, from, piece.color);
    case "rook":
      return getSlidingTargets(board, from, [
        { row: -1, col: 0 },
        { row: 1, col: 0 },
        { row: 0, col: -1 },
        { row: 0, col: 1 },
      ]);
    case "bishop":
      return getSlidingTargets(board, from, [
        { row: -1, col: -1 },
        { row: -1, col: 1 },
        { row: 1, col: -1 },
        { row: 1, col: 1 },
      ]);
    case "queen":
      return getSlidingTargets(board, from, [
        { row: -1, col: 0 },
        { row: 1, col: 0 },
        { row: 0, col: -1 },
        { row: 0, col: 1 },
        { row: -1, col: -1 },
        { row: -1, col: 1 },
        { row: 1, col: -1 },
        { row: 1, col: 1 },
      ]);
    case "knight":
      return getJumpTargets(board, from, [
        { row: -2, col: -1 },
        { row: -2, col: 1 },
        { row: -1, col: -2 },
        { row: -1, col: 2 },
        { row: 1, col: -2 },
        { row: 1, col: 2 },
        { row: 2, col: -1 },
        { row: 2, col: 1 },
      ]);
    case "king":
      return getJumpTargets(board, from, [
        { row: -1, col: -1 },
        { row: -1, col: 0 },
        { row: -1, col: 1 },
        { row: 0, col: -1 },
        { row: 0, col: 1 },
        { row: 1, col: -1 },
        { row: 1, col: 0 },
        { row: 1, col: 1 },
      ]);
    default:
      return [];
  }
}

function getPawnTargets(board: Board, from: Coordinate, color: Color): Coordinate[] {
  const direction = color === "white" ? -1 : 1;
  const startRow = color === "white" ? 6 : 1;
  const targets: Coordinate[] = [];

  const oneForward = { row: from.row + direction, col: from.col };
  if (isOnBoard(oneForward) && !board[oneForward.row][oneForward.col]) {
    targets.push(oneForward);

    const twoForward = { row: from.row + direction * 2, col: from.col };
    if (from.row === startRow && !board[twoForward.row][twoForward.col]) {
      targets.push(twoForward);
    }
  }

  for (const colDelta of [-1, 1]) {
    const capture = { row: from.row + direction, col: from.col + colDelta };
    if (!isOnBoard(capture)) {
      continue;
    }

    const occupant = board[capture.row][capture.col];
    if (occupant && occupant.color !== color) {
      targets.push(capture);
    }
  }

  return targets;
}

function getSlidingTargets(board: Board, from: Coordinate, directions: Coordinate[]): Coordinate[] {
  const piece = board[from.row][from.col];
  if (!piece) {
    return [];
  }

  const targets: Coordinate[] = [];

  for (const direction of directions) {
    let row = from.row + direction.row;
    let col = from.col + direction.col;

    while (isOnBoard({ row, col })) {
      const occupant = board[row][col];
      if (!occupant) {
        targets.push({ row, col });
        row += direction.row;
        col += direction.col;
        continue;
      }

      if (occupant.color !== piece.color) {
        targets.push({ row, col });
      }

      break;
    }
  }

  return targets;
}

function getJumpTargets(board: Board, from: Coordinate, deltas: Coordinate[]): Coordinate[] {
  const piece = board[from.row][from.col];
  if (!piece) {
    return [];
  }

  return deltas
    .map((delta) => ({ row: from.row + delta.row, col: from.col + delta.col }))
    .filter(isOnBoard)
    .filter((square) => {
      const occupant = board[square.row][square.col];
      return !occupant || occupant.color !== piece.color;
    });
}

function coordinateToNotation(square: Coordinate): string {
  return `${FILES[square.col]}${8 - square.row}`;
}

function isOnBoard(square: Coordinate): boolean {
  return square.row >= 0 && square.row < 8 && square.col >= 0 && square.col < 8;
}

async function readJsonBody(req: IncomingMessage): Promise<MoveRequest> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(body) as MoveRequest;
}
