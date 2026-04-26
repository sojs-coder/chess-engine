import { readFileSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Board } from "./Board";
import {
  getLocalGameSnapshot,
  LocalGameError,
  registerLocalPlayer,
  resetLocalGame,
  submitLocalPlayerMove,
} from "./LocalPlay";
import { findBestMove } from "./engine";
import { Color, Move, Piece, PieceType, Square } from "./types";

const PORT = Number(process.env.PORT ?? "4003");
const PLAYER_ADDRESS = process.env.PLAYER_ADDRESS?.trim() || "127.0.0.1";
const PLAYER_PATH = normalizeBasePath(process.env.PLAYER_PATH?.trim() || "/");
const ORCHESTRATOR_URL = (process.env.ORCHESTRATOR_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const FILES = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
const INDEX_HTML = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const APP_CSS = readFileSync(new URL("./public/app.css", import.meta.url), "utf8");
const APP_JS = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");

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
  roundAdditionalSeconds?: number;
  incrementSeconds?: number;
  board: string[][];
  castlingRights: CastlingRights;
  enPassantTarget: string | null;
};

type RegisteredPlayer = {
  id: string;
  address: string;
  port: number;
  path: string;
  registeredAt: string;
};

type RegisterPlayerResponse = {
  playerId: string;
  player: RegisteredPlayer;
};

type LocalRegisterRequest = {
  name?: string;
  preferredColor?: "white" | "black" | "random";
};

type LocalMoveRequest = {
  playerId?: string;
  from?: string;
  to?: string;
};

type ResetLocalGameRequest = {
  playerId?: string;
};

class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

const movePath = joinBasePath(PLAYER_PATH, "move");
const healthPath = joinBasePath(PLAYER_PATH, "health");

createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const requestUrl = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? `127.0.0.1:${PORT}`}`,
  );
  const pathname = requestUrl.pathname;

  try {
    if (req.method === "POST" && pathname === movePath) {
      await handleOrchestratorMove(req, res);
      return;
    }

    if (req.method === "GET" && pathname === healthPath) {
      respondText(res, 200, "ok");
      return;
    }

    if (req.method === "POST" && pathname === "/api/register") {
      await handleRegisterLocalPlayer(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/game") {
      handleGetLocalGame(requestUrl, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/move") {
      await handleLocalPlayerMove(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/reset") {
      await handleResetLocalGame(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/") {
      respond(res, 200, { "content-type": "text/html; charset=utf-8" }, INDEX_HTML);
      return;
    }

    if (req.method === "GET" && pathname === "/app.css") {
      respond(res, 200, { "content-type": "text/css; charset=utf-8" }, APP_CSS);
      return;
    }

    if (req.method === "GET" && pathname === "/app.js") {
      respond(res, 200, { "content-type": "text/javascript; charset=utf-8" }, APP_JS);
      return;
    }

    if (req.method === "GET" && pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    respondText(res, 404, "Not found");
  } catch (error) {
    handleRouteError(error, res);
  }
}).listen(PORT, () => {
  console.log(
    `Mat algo player listening on port ${PORT} (path ${PLAYER_PATH}, move ${movePath}, local arena /)`,
  );
  void registerPlayer();
});

async function handleOrchestratorMove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<MoveRequest>(req);
  const engineColor = inferColor(body);
  const board = buildBoard(body);
  const roundAdditionalSeconds = body.roundAdditionalSeconds ?? body.incrementSeconds ?? 2;

  const move = findBestMove(board, engineColor, roundAdditionalSeconds);

  if (!move) {
    respondText(res, 200, "A1,A1");
    return;
  }

  respondText(res, 200, `${squareToNotation(move.from)},${squareToNotation(move.to)}`);
}

async function handleRegisterLocalPlayer(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody<LocalRegisterRequest>(req);
  respondJson(res, 200, registerLocalPlayer(body));
}

function handleGetLocalGame(requestUrl: URL, res: ServerResponse): void {
  const playerId = requestUrl.searchParams.get("playerId") ?? "";
  respondJson(res, 200, getLocalGameSnapshot(playerId));
}

async function handleLocalPlayerMove(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody<LocalMoveRequest>(req);
  respondJson(res, 200, submitLocalPlayerMove(body));
}

async function handleResetLocalGame(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody<ResetLocalGameRequest>(req);
  respondJson(res, 200, resetLocalGame(body.playerId ?? ""));
}

function inferColor(body: MoveRequest): Color {
  if (body.playerId && body.whitePlayerId && body.blackPlayerId) {
    return body.playerId === body.whitePlayerId ? Color.White : Color.Black;
  }
  return body.turn === "white" ? Color.White : Color.Black;
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
  if (file < 0 || file > 7 || Number.isNaN(rank) || rank < 0 || rank > 7) return null;
  return { file, rank };
}

function squareToNotation(square: Square): string {
  return `${FILES[square.file]}${square.rank + 1}`;
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) return {} as T;

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body.");
  }
}

function normalizeBasePath(path: string): string {
  if (!path || path === "/") return "/";
  return `/${path.replace(/^\/+|\/+$/g, "")}`;
}

function joinBasePath(basePath: string, suffix: string): string {
  return basePath === "/" ? `/${suffix}` : `${basePath}/${suffix}`;
}

function respond(
  res: ServerResponse,
  statusCode: number,
  headers: Record<string, string>,
  body: string,
): void {
  res.writeHead(statusCode, headers);
  res.end(body);
}

function respondText(res: ServerResponse, statusCode: number, body: string): void {
  respond(res, statusCode, { "content-type": "text/plain; charset=utf-8" }, body);
}

function respondJson(res: ServerResponse, statusCode: number, data: unknown): void {
  respond(
    res,
    statusCode,
    {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    JSON.stringify(data),
  );
}

function handleRouteError(error: unknown, res: ServerResponse): void {
  if (error instanceof LocalGameError || error instanceof HttpError) {
    respondJson(res, error.statusCode, { error: error.message });
    return;
  }

  console.error("Request failed:", error);
  respondJson(res, 500, { error: "Internal server error." });
}

async function registerPlayer(): Promise<void> {
  try {
    const response = await fetch(`${ORCHESTRATOR_URL}/players/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        address: PLAYER_ADDRESS,
        port: PORT,
        path: PLAYER_PATH,
      }),
    });

    const rawText = await response.text();
    if (!response.ok) {
      console.error(
        `Player registration failed with status ${response.status}: ${rawText || "<empty body>"}`,
      );
      return;
    }

    const registration = JSON.parse(rawText) as RegisterPlayerResponse;
    console.log(
      `Registered player ${registration.playerId} with orchestrator at ${ORCHESTRATOR_URL}`,
    );
  } catch (error) {
    console.error(`Player registration failed:`, error);
  }
}
