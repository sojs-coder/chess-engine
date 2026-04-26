import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export type Color = "white" | "black";
export type PieceType = "pawn" | "rook" | "knight" | "bishop" | "queen" | "king";
export type GameStatus = "pending" | "active" | "finished";

export type Piece = {
  color: Color;
  type: PieceType;
};

type PlayerRegistration = {
  address: string;
  port: number;
  path: string;
};

type Player = PlayerRegistration & {
  id: string;
  registeredAt: string;
};

export type Board = Array<Array<Piece | null>>;

export type Coordinate = {
  row: number;
  col: number;
};

export type CastlingRights = {
  whiteKingSide: boolean;
  whiteQueenSide: boolean;
  blackKingSide: boolean;
  blackQueenSide: boolean;
};

export type MoveRecord = {
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

export type GameResult = {
  winnerPlayerId: string | null;
  loserPlayerId: string | null;
  reason: string;
};

export type Game = {
  id: string;
  status: GameStatus;
  whitePlayerId: string;
  blackPlayerId: string;
  board: Board;
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
  positionCounts: Map<string, number>;
  result?: GameResult;
};

export type SerializedGame = {
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
};

export type MoveRequestPayload = SerializedGame & {
  playerId: string;
  lastError: string | null;
};

type ParsedMove = {
  from: Coordinate;
  to: Coordinate;
  fromNotation: string;
  toNotation: string;
};

type AppliedMove = {
  captured?: Piece;
  promotion?: PieceType;
  castling?: "king-side" | "queen-side";
  enPassant?: boolean;
};

const PORT = Number(process.env.PORT ?? "3000");
const GAMES_DIR = "games";
const MOVE_TIMEOUT_MS = 60_000 * 10;

const players = new Map<string, Player>();
const games = new Map<string, Game>();

const FILES = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;

export function createOrchestratorServer() {
  return createServer(async (req, res) => {
    try {
      await routeRequest(req, res);
    } catch (error) {
      console.error("Unhandled request error:", error);
      sendJson(res, 500, { error: "Internal server error" });
    }
  });
}

if (import.meta.main) {
  void ensureGamesDirectory();

  const server = createOrchestratorServer();
  server.listen(PORT, () => {
    console.log(`Chess orchestrator listening on port ${PORT}`);
  });
}

async function routeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "POST" && url.pathname === "/players/register") {
    await handleRegisterPlayer(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/games/start") {
    await handleStartGame(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/players") {
    sendJson(res, 200, { players: [...players.values()] });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/games/")) {
    const gameId = url.pathname.slice("/games/".length);
    const game = games.get(gameId);

    if (!game) {
      sendJson(res, 404, { error: "Game not found" });
      return;
    }

    sendJson(res, 200, serializeGame(game));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function handleRegisterPlayer(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;

  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const address = typeof body.address === "string" ? body.address.trim() : "";
  const path = typeof body.path === "string" ? normalizePath(body.path.trim()) : "/";
  const port = Number(body.port);

  if (!address || !Number.isInteger(port) || port < 1 || port > 65_535) {
    sendJson(res, 400, {
      error: "Expected JSON body with address:string, port:number, path:string",
    });
    return;
  }

  const player: Player = {
    id: randomUUID(),
    address,
    port,
    path,
    registeredAt: new Date().toISOString(),
  };

  players.set(player.id, player);

  sendJson(res, 201, {
    playerId: player.id,
    player,
  });
}

async function handleStartGame(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  await consumeBody(req);

  if (players.size < 2) {
    sendJson(res, 400, { error: "At least two registered players are required" });
    return;
  }

  const startTimeMinutes = Number(url.searchParams.get("start_time") ?? "5");
  const incrementSeconds = Number(url.searchParams.get("round_additional_seconds") ?? "0");
  const requestedWhiteId = url.searchParams.get("white");

  if (!Number.isFinite(startTimeMinutes) || startTimeMinutes <= 0) {
    sendJson(res, 400, { error: "start_time must be a positive number of minutes" });
    return;
  }

  if (!Number.isFinite(incrementSeconds) || incrementSeconds < 0) {
    sendJson(res, 400, { error: "round_additional_seconds must be zero or greater" });
    return;
  }

  const selectedPlayers = pickPlayers(requestedWhiteId);

  if (!selectedPlayers) {
    sendJson(res, 400, { error: "white must reference a registered player" });
    return;
  }

  const [whitePlayer, blackPlayer] = selectedPlayers;
  const game: Game = {
    id: randomUUID(),
    status: "active",
    whitePlayerId: whitePlayer.id,
    blackPlayerId: blackPlayer.id,
    board: createInitialBoard(),
    turn: "white",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    startTimeMinutes,
    incrementSeconds,
    remainingTimeSeconds: {
      white: Math.round(startTimeMinutes * 60),
      black: Math.round(startTimeMinutes * 60),
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
  };

  const initialKey = getPositionKey(game);
  game.positionCounts.set(initialKey, 1);

  games.set(game.id, game);
  await writeGamePgn(game);

  sendJson(res, 201, {
    gameId: game.id,
    whitePlayerId: whitePlayer.id,
    blackPlayerId: blackPlayer.id,
    startTimeMinutes,
    roundAdditionalSeconds: incrementSeconds,
    status: game.status,
  });

  void runGameLoop(game.id);
}

async function runGameLoop(gameId: string): Promise<void> {
  const game = games.get(gameId);
  if (!game) {
    return;
  }

  while (game.status === "active") {
    const currentColor = game.turn;
    const currentPlayerId = getPlayerIdForColor(game, currentColor);
    const opponentPlayerId = getOpponentPlayerIdForColor(game, currentColor);
    const player = players.get(currentPlayerId);

    if (!player) {
      await finishGame(game, {
        winnerPlayerId: opponentPlayerId,
        loserPlayerId: currentPlayerId,
        reason: `Player ${currentPlayerId} is no longer registered`,
      });
      return;
    }

    if (getAllLegalMoves(game, currentColor).length === 0) {
      const winner = isInCheck(game, currentColor) ? opponentPlayerId : null;
      await finishGame(game, {
        winnerPlayerId: winner,
        loserPlayerId: winner ? currentPlayerId : null,
        reason: winner ? `${currentColor} is checkmated` : "Stalemate",
      });
      return;
    }

    let badMoveNotice: string | null = null;
    const turnStartedAt = Date.now();

    while (game.status === "active") {
      const responseText = await requestMoveFromPlayer(player, game, badMoveNotice);
      const elapsedSeconds = (Date.now() - turnStartedAt) / 1000;

      if (responseText === null) {
        await finishGame(game, {
          winnerPlayerId: opponentPlayerId,
          loserPlayerId: currentPlayerId,
          reason: `${currentColor} failed to return a move`,
        });
        return;
      }

      const projectedRemaining =
        game.remainingTimeSeconds[currentColor] -
        Math.max(0, elapsedSeconds - game.incrementSeconds);

      if (projectedRemaining <= 0) {
        game.remainingTimeSeconds[currentColor] = 0;
        await finishGame(game, {
          winnerPlayerId: opponentPlayerId,
          loserPlayerId: currentPlayerId,
          reason: `${currentColor} ran out of time`,
        });
        return;
      }

      const parsedMove = parseMove(responseText);
      if (!parsedMove) {
        badMoveNotice = `Bad move: expected format "E2,E4", received "${responseText}"`;
        continue;
      }

      const piece = game.board[parsedMove.from.row][parsedMove.from.col];
      if (!piece || piece.color !== currentColor) {
        badMoveNotice = "Bad move: source square does not contain the current player's piece";
        continue;
      }

      const legalMoves = getLegalMovesForPiece(game, parsedMove.from);
      const chosenMove = legalMoves.find(
        (move) => move.to.row === parsedMove.to.row && move.to.col === parsedMove.to.col,
      );

      if (!chosenMove) {
        badMoveNotice = `Bad move: ${parsedMove.fromNotation},${parsedMove.toNotation} is not legal`;
        continue;
      }

      const timeCharge = Math.max(0, elapsedSeconds - game.incrementSeconds);
      game.remainingTimeSeconds[currentColor] = roundToMillisPrecision(
        game.remainingTimeSeconds[currentColor] - timeCharge,
      );

      const applied = applyMove(game, parsedMove.from, parsedMove.to);
      const moveRecord: MoveRecord = {
        from: parsedMove.fromNotation,
        to: parsedMove.toNotation,
        color: currentColor,
        piece: piece.type,
        playerId: currentPlayerId,
        durationMs: Math.round(elapsedSeconds * 1000),
        remainingTimeSeconds: game.remainingTimeSeconds[currentColor],
        captured: applied.captured?.type,
        promotion: applied.promotion,
        castling: applied.castling,
        enPassant: applied.enPassant,
      };

      game.moves.push(moveRecord);

      const notation = `${moveRecord.from},${moveRecord.to}`;
      const movePrefix = `${game.moveIndex}. ${currentColor}`;
      const moveLine = `${movePrefix} ${notation} (${moveRecord.remainingTimeSeconds}s left)`;
      console.log(`[game:${game.id}] ${moveLine}`);
      await writeGamePgn(game);

      const opponentColor = oppositeColor(currentColor);
      const opponentHasLegalMoves = getAllLegalMoves(game, opponentColor).length > 0;

      if (!opponentHasLegalMoves) {
        const winnerPlayerId = isInCheck(game, opponentColor) ? currentPlayerId : null;
        await finishGame(game, {
          winnerPlayerId,
          loserPlayerId: winnerPlayerId ? opponentPlayerId : null,
          reason: winnerPlayerId ? `${opponentColor} is checkmated` : "Stalemate",
        });
        return;
      }

      game.turn = opponentColor;
      game.moveIndex += currentColor === "black" ? 1 : 0;

      game.halfMoveClock =
        piece.type === "pawn" || applied.captured !== undefined
          ? 0
          : game.halfMoveClock + 1;

      if (game.halfMoveClock >= 100) {
        await finishGame(game, {
          winnerPlayerId: null,
          loserPlayerId: null,
          reason: "50-move rule",
        });
        return;
      }

      const posKey = getPositionKey(game);
      game.positionCounts.set(posKey, (game.positionCounts.get(posKey) ?? 0) + 1);
      if ((game.positionCounts.get(posKey) ?? 0) >= 3) {
        await finishGame(game, {
          winnerPlayerId: null,
          loserPlayerId: null,
          reason: "Threefold repetition",
        });
        return;
      }

      break;
    }
  }
}

async function requestMoveFromPlayer(
  player: Player,
  game: Game,
  errorMessage: string | null,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MOVE_TIMEOUT_MS);
  const playerId = getPlayerIdForColor(game, game.turn);

  try {
    const response = await fetch(buildMoveUrl(player), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(serializeMoveRequest(game, playerId, errorMessage)),
      signal: controller.signal,
    });

    const responseText = (await response.text()).trim();
    return response.ok ? responseText : null;
  } catch (error) {
    console.error(`Failed to request move from player ${player.id}:`, error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function buildMoveUrl(player: Player): string {
  const basePath = normalizePath(player.path);
  const movePath = basePath.endsWith("/move") ? basePath : `${basePath.replace(/\/$/, "")}/move`;
  return `http://${player.address}:${player.port}${movePath}`;
}

function pickPlayers(requestedWhiteId: string | null): [Player, Player] | null {
  const pool = [...players.values()];

  if (requestedWhiteId) {
    const whitePlayer = players.get(requestedWhiteId);
    if (!whitePlayer) {
      return null;
    }

    const candidates = pool.filter((player) => player.id !== requestedWhiteId);
    const blackPlayer = randomItem(candidates);
    return blackPlayer ? [whitePlayer, blackPlayer] : null;
  }

  const shuffled = shuffle(pool);
  const [first, second] = shuffled;

  if (!first || !second) {
    return null;
  }

  return Math.random() < 0.5 ? [first, second] : [second, first];
}

export function createInitialBoard(): Board {
  const backRank: PieceType[] = [
    "rook",
    "knight",
    "bishop",
    "queen",
    "king",
    "bishop",
    "knight",
    "rook",
  ];

  const board: Board = Array.from({ length: 8 }, () => Array<Piece | null>(8).fill(null));

  for (let col = 0; col < 8; col += 1) {
    board[0][col] = { color: "black", type: backRank[col] };
    board[1][col] = { color: "black", type: "pawn" };
    board[6][col] = { color: "white", type: "pawn" };
    board[7][col] = { color: "white", type: backRank[col] };
  }

  return board;
}

export function parseMove(rawMove: string): ParsedMove | null {
  const trimmed = rawMove.trim();
  const match = /^([A-H][1-8])\s*,\s*([A-H][1-8])$/i.exec(trimmed);

  if (!match) {
    return null;
  }

  const fromNotation = match[1].toUpperCase();
  const toNotation = match[2].toUpperCase();

  return {
    from: notationToCoordinate(fromNotation),
    to: notationToCoordinate(toNotation),
    fromNotation,
    toNotation,
  };
}

export function notationToCoordinate(notation: string): Coordinate {
  const file = notation[0].toUpperCase();
  const rank = Number(notation[1]);
  return {
    row: 8 - rank,
    col: FILES.indexOf(file as (typeof FILES)[number]),
  };
}

export function coordinateToNotation(square: Coordinate): string {
  return `${FILES[square.col]}${8 - square.row}`;
}

export function renderMoveAsSan(game: Game, from: Coordinate, to: Coordinate): string {
  const preMoveGame = cloneGame(game);
  const postMoveGame = cloneGame(game);
  const applied = applyMove(postMoveGame, from, to);
  return formatSanMove(preMoveGame, from, to, applied, postMoveGame);
}

function formatSanMove(
  preMoveGame: Game,
  from: Coordinate,
  to: Coordinate,
  applied: AppliedMove,
  postMoveGame: Game,
): string {
  const piece = preMoveGame.board[from.row][from.col];
  if (!piece) {
    throw new Error("Cannot format SAN for a move without a source piece");
  }

  let san: string;

  if (applied.castling === "king-side") {
    san = "O-O";
  } else if (applied.castling === "queen-side") {
    san = "O-O-O";
  } else {
    const destination = coordinateToNotation(to).toLowerCase();
    const isCapture = applied.captured !== undefined;

    if (piece.type === "pawn") {
      const prefix = isCapture ? `${coordinateToNotation(from)[0].toLowerCase()}x` : "";
      san = `${prefix}${destination}`;
      if (applied.promotion) {
        san += `=${pieceTypeToSanSymbol(applied.promotion)}`;
      }
    } else {
      const pieceSymbol = pieceTypeToSanSymbol(piece.type);
      const disambiguation = getSanDisambiguation(preMoveGame, piece, from, to);
      san = `${pieceSymbol}${disambiguation}${isCapture ? "x" : ""}${destination}`;
    }
  }

  const opponentColor = oppositeColor(piece.color);
  const opponentHasLegalMoves = getAllLegalMoves(postMoveGame, opponentColor).length > 0;
  const opponentInCheck = isInCheck(postMoveGame, opponentColor);

  if (!opponentHasLegalMoves && opponentInCheck) {
    return `${san}#`;
  }

  if (opponentInCheck) {
    return `${san}+`;
  }

  return san;
}

function getSanDisambiguation(
  game: Game,
  piece: Piece,
  from: Coordinate,
  to: Coordinate,
): string {
  const competingMoves = getAllLegalMoves(game, piece.color).filter((candidate) => {
    if (candidate.to.row !== to.row || candidate.to.col !== to.col) {
      return false;
    }

    if (candidate.from.row === from.row && candidate.from.col === from.col) {
      return false;
    }

    const candidatePiece = game.board[candidate.from.row][candidate.from.col];
    return candidatePiece?.type === piece.type;
  });

  if (competingMoves.length === 0) {
    return "";
  }

  const fromSquare = coordinateToNotation(from).toLowerCase();
  const sameFile = competingMoves.some((candidate) => candidate.from.col === from.col);
  const sameRank = competingMoves.some((candidate) => candidate.from.row === from.row);

  if (!sameFile) {
    return fromSquare[0];
  }

  if (!sameRank) {
    return fromSquare[1];
  }

  return fromSquare;
}

function pieceTypeToSanSymbol(pieceType: PieceType): string {
  switch (pieceType) {
    case "pawn":
      return "";
    case "knight":
      return "N";
    case "bishop":
      return "B";
    case "rook":
      return "R";
    case "queen":
      return "Q";
    case "king":
      return "K";
    default:
      return "";
  }
}

export function getAllLegalMoves(game: Game, color: Color): ParsedMove[] {
  const moves: ParsedMove[] = [];

  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const piece = game.board[row][col];
      if (!piece || piece.color !== color) {
        continue;
      }

      const from = { row, col };
      for (const move of getLegalMovesForPiece(game, from)) {
        moves.push({
          from,
          to: move.to,
          fromNotation: coordinateToNotation(from),
          toNotation: coordinateToNotation(move.to),
        });
      }
    }
  }

  return moves;
}

export function getLegalMovesForPiece(game: Game, from: Coordinate): Array<{ to: Coordinate }> {
  const piece = game.board[from.row][from.col];
  if (!piece) {
    return [];
  }

  const candidates = getPseudoLegalMoves(game, from, true);
  return candidates.filter(({ to }) => {
    const clonedGame = cloneGame(game);
    applyMove(clonedGame, from, to);
    return !isInCheck(clonedGame, piece.color);
  });
}

function getPseudoLegalMoves(
  game: Game,
  from: Coordinate,
  includeCastling: boolean,
): Array<{ to: Coordinate }> {
  const piece = game.board[from.row][from.col];
  if (!piece) {
    return [];
  }

  switch (piece.type) {
    case "pawn":
      return getPawnMoves(game, from, piece.color);
    case "rook":
      return getSlidingMoves(game, from, [
        { row: -1, col: 0 },
        { row: 1, col: 0 },
        { row: 0, col: -1 },
        { row: 0, col: 1 },
      ]);
    case "bishop":
      return getSlidingMoves(game, from, [
        { row: -1, col: -1 },
        { row: -1, col: 1 },
        { row: 1, col: -1 },
        { row: 1, col: 1 },
      ]);
    case "queen":
      return getSlidingMoves(game, from, [
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
      return getJumpMoves(game, from, [
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
      return getKingMoves(game, from, includeCastling);
    default:
      return [];
  }
}

function getPawnMoves(game: Game, from: Coordinate, color: Color): Array<{ to: Coordinate }> {
  const direction = color === "white" ? -1 : 1;
  const startRow = color === "white" ? 6 : 1;
  const moves: Array<{ to: Coordinate }> = [];

  const oneForward = { row: from.row + direction, col: from.col };
  if (isOnBoard(oneForward) && !game.board[oneForward.row][oneForward.col]) {
    moves.push({ to: oneForward });

    const twoForward = { row: from.row + direction * 2, col: from.col };
    if (from.row === startRow && !game.board[twoForward.row][twoForward.col]) {
      moves.push({ to: twoForward });
    }
  }

  for (const colDelta of [-1, 1]) {
    const captureSquare = { row: from.row + direction, col: from.col + colDelta };
    if (!isOnBoard(captureSquare)) {
      continue;
    }

    const targetPiece = game.board[captureSquare.row][captureSquare.col];
    if (targetPiece && targetPiece.color !== color) {
      moves.push({ to: captureSquare });
      continue;
    }

    if (game.enPassantTarget === coordinateToNotation(captureSquare)) {
      moves.push({ to: captureSquare });
    }
  }

  return moves;
}

function getSlidingMoves(
  game: Game,
  from: Coordinate,
  directions: Coordinate[],
): Array<{ to: Coordinate }> {
  const piece = game.board[from.row][from.col];
  if (!piece) {
    return [];
  }

  const moves: Array<{ to: Coordinate }> = [];

  for (const direction of directions) {
    let row = from.row + direction.row;
    let col = from.col + direction.col;

    while (isOnBoard({ row, col })) {
      const occupant = game.board[row][col];

      if (!occupant) {
        moves.push({ to: { row, col } });
        row += direction.row;
        col += direction.col;
        continue;
      }

      if (occupant.color !== piece.color) {
        moves.push({ to: { row, col } });
      }

      break;
    }
  }

  return moves;
}

function getJumpMoves(
  game: Game,
  from: Coordinate,
  deltas: Coordinate[],
): Array<{ to: Coordinate }> {
  const piece = game.board[from.row][from.col];
  if (!piece) {
    return [];
  }

  return deltas
    .map(({ row, col }) => ({ row: from.row + row, col: from.col + col }))
    .filter(isOnBoard)
    .filter((square) => {
      const occupant = game.board[square.row][square.col];
      return !occupant || occupant.color !== piece.color;
    })
    .map((square) => ({ to: square }));
}

function getKingMoves(
  game: Game,
  from: Coordinate,
  includeCastling: boolean,
): Array<{ to: Coordinate }> {
  const piece = game.board[from.row][from.col];
  if (!piece) {
    return [];
  }

  const deltas: Coordinate[] = [
    { row: -1, col: -1 },
    { row: -1, col: 0 },
    { row: -1, col: 1 },
    { row: 0, col: -1 },
    { row: 0, col: 1 },
    { row: 1, col: -1 },
    { row: 1, col: 0 },
    { row: 1, col: 1 },
  ];

  const moves = getJumpMoves(game, from, deltas);

  if (!includeCastling || isInCheck(game, piece.color)) {
    return moves;
  }

  const rights = game.castlingRights;
  const row = piece.color === "white" ? 7 : 0;
  const enemy = oppositeColor(piece.color);

  const canCastleKingSide =
    (piece.color === "white" ? rights.whiteKingSide : rights.blackKingSide) &&
    !game.board[row][5] &&
    !game.board[row][6] &&
    !isSquareAttacked(game, { row, col: 5 }, enemy) &&
    !isSquareAttacked(game, { row, col: 6 }, enemy);

  if (canCastleKingSide) {
    const rook = game.board[row][7];
    if (rook?.type === "rook" && rook.color === piece.color) {
      moves.push({ to: { row, col: 6 } });
    }
  }

  const canCastleQueenSide =
    (piece.color === "white" ? rights.whiteQueenSide : rights.blackQueenSide) &&
    !game.board[row][1] &&
    !game.board[row][2] &&
    !game.board[row][3] &&
    !isSquareAttacked(game, { row, col: 3 }, enemy) &&
    !isSquareAttacked(game, { row, col: 2 }, enemy);

  if (canCastleQueenSide) {
    const rook = game.board[row][0];
    if (rook?.type === "rook" && rook.color === piece.color) {
      moves.push({ to: { row, col: 2 } });
    }
  }

  return moves;
}

export function applyMove(game: Game, from: Coordinate, to: Coordinate): AppliedMove {
  const piece = game.board[from.row][from.col];
  if (!piece) {
    throw new Error("Cannot apply move without a source piece");
  }

  const applied: AppliedMove = {};
  let captured = game.board[to.row][to.col] ?? undefined;

  if (piece.type === "pawn" && from.col !== to.col && !captured) {
    const capturedRow = piece.color === "white" ? to.row + 1 : to.row - 1;
    captured = game.board[capturedRow][to.col] ?? undefined;
    game.board[capturedRow][to.col] = null;
    applied.enPassant = true;
  }

  game.board[to.row][to.col] = piece;
  game.board[from.row][from.col] = null;

  if (piece.type === "king" && Math.abs(to.col - from.col) === 2) {
    const rookFromCol = to.col > from.col ? 7 : 0;
    const rookToCol = to.col > from.col ? 5 : 3;
    const rook = game.board[to.row][rookFromCol];
    game.board[to.row][rookToCol] = rook;
    game.board[to.row][rookFromCol] = null;
    applied.castling = to.col > from.col ? "king-side" : "queen-side";
  }

  if (piece.type === "pawn" && (to.row === 0 || to.row === 7)) {
    game.board[to.row][to.col] = { color: piece.color, type: "queen" };
    applied.promotion = "queen";
  }

  applied.captured = captured;

  updateCastlingRights(game, piece, from, to, captured);
  updateEnPassantTarget(game, piece, from, to);

  return applied;
}

function updateCastlingRights(
  game: Game,
  piece: Piece,
  from: Coordinate,
  to: Coordinate,
  captured?: Piece,
): void {
  if (piece.type === "king") {
    if (piece.color === "white") {
      game.castlingRights.whiteKingSide = false;
      game.castlingRights.whiteQueenSide = false;
    } else {
      game.castlingRights.blackKingSide = false;
      game.castlingRights.blackQueenSide = false;
    }
  }

  if (piece.type === "rook") {
    if (from.row === 7 && from.col === 0) {
      game.castlingRights.whiteQueenSide = false;
    }
    if (from.row === 7 && from.col === 7) {
      game.castlingRights.whiteKingSide = false;
    }
    if (from.row === 0 && from.col === 0) {
      game.castlingRights.blackQueenSide = false;
    }
    if (from.row === 0 && from.col === 7) {
      game.castlingRights.blackKingSide = false;
    }
  }

  if (captured?.type === "rook") {
    if (to.row === 7 && to.col === 0) {
      game.castlingRights.whiteQueenSide = false;
    }
    if (to.row === 7 && to.col === 7) {
      game.castlingRights.whiteKingSide = false;
    }
    if (to.row === 0 && to.col === 0) {
      game.castlingRights.blackQueenSide = false;
    }
    if (to.row === 0 && to.col === 7) {
      game.castlingRights.blackKingSide = false;
    }
  }
}

function updateEnPassantTarget(game: Game, piece: Piece, from: Coordinate, to: Coordinate): void {
  if (piece.type === "pawn" && Math.abs(to.row - from.row) === 2) {
    const middleRow = (from.row + to.row) / 2;
    game.enPassantTarget = coordinateToNotation({ row: middleRow, col: from.col });
    return;
  }

  game.enPassantTarget = null;
}

function isInCheck(game: Game, color: Color): boolean {
  const kingSquare = findKing(game.board, color);
  return isSquareAttacked(game, kingSquare, oppositeColor(color));
}

function isSquareAttacked(game: Game, target: Coordinate, byColor: Color): boolean {
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const piece = game.board[row][col];
      if (!piece || piece.color !== byColor) {
        continue;
      }

      const from = { row, col };

      if (piece.type === "pawn") {
        const direction = byColor === "white" ? -1 : 1;
        for (const colDelta of [-1, 1]) {
          if (target.row === row + direction && target.col === col + colDelta) {
            return true;
          }
        }
        continue;
      }

      const moves = getPseudoLegalMoves(game, from, false);
      if (moves.some((move) => move.to.row === target.row && move.to.col === target.col)) {
        return true;
      }
    }
  }

  return false;
}

function findKing(board: Board, color: Color): Coordinate {
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const piece = board[row][col];
      if (piece?.type === "king" && piece.color === color) {
        return { row, col };
      }
    }
  }

  throw new Error(`King not found for ${color}`);
}

export function cloneGame(game: Game): Game {
  return {
    ...game,
    board: game.board.map((row) => row.map((piece) => (piece ? { ...piece } : null))),
    remainingTimeSeconds: { ...game.remainingTimeSeconds },
    moves: game.moves.map((move) => ({ ...move })),
    castlingRights: { ...game.castlingRights },
    positionCounts: new Map(game.positionCounts),
    result: game.result ? { ...game.result } : undefined,
  };
}

function getPositionKey(game: Game): string {
  const board = serializeBoard(game.board)
    .map((row) => row.join(""))
    .join("|");
  const cr = game.castlingRights;
  const castling = `${cr.whiteKingSide ? "K" : ""}${cr.whiteQueenSide ? "Q" : ""}${cr.blackKingSide ? "k" : ""}${cr.blackQueenSide ? "q" : ""}`;
  return `${board};${game.turn};${castling};${game.enPassantTarget ?? "-"}`;
}

async function finishGame(game: Game, result: GameResult): Promise<void> {
  if (game.status === "finished") {
    return;
  }

  game.status = "finished";
  game.result = result;
  game.finishedAt = new Date().toISOString();

  const winnerLine = result.winnerPlayerId
    ? `Winner: ${result.winnerPlayerId}. Reason: ${result.reason}`
    : `Game drawn. Reason: ${result.reason}`;

  console.log(`[game:${game.id}] ${winnerLine}`);
  await writeGamePgn(game);
}

export function renderGamePgn(game: Game): string {
  const tags = [
    `[Event "Chess Engine State Game"]`,
    `[Site "Local"]`,
    `[Date "${formatPgnDate(game.startedAt)}"]`,
    `[Round "?"]`,
    `[White "${escapePgnTagValue(game.whitePlayerId)}"]`,
    `[Black "${escapePgnTagValue(game.blackPlayerId)}"]`,
    `[Result "${getPgnResultToken(game)}"]`,
    `[TimeControl "${game.startTimeMinutes * 60}+${game.incrementSeconds}"]`,
    `[GameId "${escapePgnTagValue(game.id)}"]`,
  ];

  if (game.result) {
    tags.push(`[Termination "${escapePgnTagValue(game.result.reason)}"]`);
  }

  const movetext = renderPgnMovetext(game);
  return `${tags.join("\n")}\n\n${wrapPgnText(movetext)}\n`;
}

function renderPgnMovetext(game: Game): string {
  const replayGame = createReplayGame(game);
  const tokens: string[] = [];
  let fullMoveNumber = 1;

  for (let index = 0; index < game.moves.length; index += 1) {
    const moveRecord = game.moves[index];
    const from = notationToCoordinate(moveRecord.from);
    const to = notationToCoordinate(moveRecord.to);
    const preMoveGame = cloneGame(replayGame);
    const applied = applyMove(replayGame, from, to);
    const san = formatSanMove(preMoveGame, from, to, applied, replayGame);

    if (moveRecord.color === "white") {
      tokens.push(`${fullMoveNumber}. ${san}`);
      continue;
    }

    if (index === 0 || game.moves[index - 1]?.color !== "white") {
      tokens.push(`${fullMoveNumber}... ${san}`);
    } else {
      tokens.push(san);
    }

    fullMoveNumber += 1;
  }

  tokens.push(getPgnResultToken(game));
  return tokens.join(" ");
}

function createReplayGame(game: Game): Game {
  const replayGame: Game = {
    id: game.id,
    status: "active",
    whitePlayerId: game.whitePlayerId,
    blackPlayerId: game.blackPlayerId,
    board: createInitialBoard(),
    turn: "white",
    createdAt: game.createdAt,
    startedAt: game.startedAt,
    finishedAt: game.finishedAt,
    startTimeMinutes: game.startTimeMinutes,
    incrementSeconds: game.incrementSeconds,
    remainingTimeSeconds: {
      white: game.startTimeMinutes * 60,
      black: game.startTimeMinutes * 60,
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
    result: undefined,
  };

  const initialKey = getPositionKey(replayGame);
  replayGame.positionCounts.set(initialKey, 1);

  return replayGame;
}

function getPgnResultToken(game: Pick<Game, "whitePlayerId" | "blackPlayerId" | "result">): string {
  if (!game.result) {
    return "*";
  }

  if (!game.result.winnerPlayerId) {
    return "1/2-1/2";
  }

  return game.result.winnerPlayerId === game.whitePlayerId ? "1-0" : "0-1";
}

function formatPgnDate(timestamp: string): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}.${month}.${day}`;
}

function escapePgnTagValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function wrapPgnText(text: string, maxWidth = 80): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "";
  }

  const lines: string[] = [];
  let currentLine = words[0];

  for (const word of words.slice(1)) {
    if (currentLine.length + word.length + 1 <= maxWidth) {
      currentLine += ` ${word}`;
      continue;
    }

    lines.push(currentLine);
    currentLine = word;
  }

  lines.push(currentLine);
  return lines.join("\n");
}

async function ensureGamesDirectory(): Promise<void> {
  await mkdir(GAMES_DIR, { recursive: true });
}

function getGamePgnPath(gameId: string): string {
  return `${GAMES_DIR}/${gameId}.txt`;
}

async function writeGamePgn(game: Game): Promise<void> {
  await ensureGamesDirectory();
  await writeFile(getGamePgnPath(game.id), renderGamePgn(game), "utf8");
}

function serializeBoard(board: Board): string[][] {
  const pieceSymbol: Record<PieceType, string> = {
    pawn: "P",
    rook: "R",
    knight: "N",
    bishop: "B",
    queen: "Q",
    king: "K",
  };

  return board.map((row) =>
    row.map((piece) => {
      if (!piece) {
        return "";
      }

      const symbol = pieceSymbol[piece.type];
      return `${piece.color[0]}${symbol}`;
    }),
  );
}

function serializePositionCounts(positionCounts: Map<string, number>): Record<string, number> {
  return Object.fromEntries(positionCounts);
}

function serializeGame(game: Game): SerializedGame {
  return {
    id: game.id,
    status: game.status,
    whitePlayerId: game.whitePlayerId,
    blackPlayerId: game.blackPlayerId,
    turn: game.turn,
    createdAt: game.createdAt,
    startedAt: game.startedAt,
    finishedAt: game.finishedAt,
    startTimeMinutes: game.startTimeMinutes,
    incrementSeconds: game.incrementSeconds,
    remainingTimeSeconds: { ...game.remainingTimeSeconds },
    moves: game.moves.map((move) => ({ ...move })),
    moveIndex: game.moveIndex,
    enPassantTarget: game.enPassantTarget,
    castlingRights: { ...game.castlingRights },
    halfMoveClock: game.halfMoveClock,
    positionCounts: serializePositionCounts(game.positionCounts),
    result: game.result ? { ...game.result } : undefined,
    board: serializeBoard(game.board),
  };
}

function serializeMoveRequest(
  game: Game,
  playerId: string,
  lastError: string | null,
): MoveRequestPayload {
  return {
    ...serializeGame(game),
    playerId,
    lastError,
  };
}

function getPlayerIdForColor(game: Game, color: Color): string {
  return color === "white" ? game.whitePlayerId : game.blackPlayerId;
}

function getOpponentPlayerIdForColor(game: Game, color: Color): string {
  return color === "white" ? game.blackPlayerId : game.whitePlayerId;
}

function oppositeColor(color: Color): Color {
  return color === "white" ? "black" : "white";
}

function isOnBoard(square: Coordinate): boolean {
  return square.row >= 0 && square.row < 8 && square.col >= 0 && square.col < 8;
}

function normalizePath(rawPath: string): string {
  if (!rawPath || rawPath === "/") {
    return "/";
  }

  return rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
}

function roundToMillisPrecision(value: number): number {
  return Math.max(0, Math.round(value * 1000) / 1000);
}

function shuffle<T>(items: T[]): T[] {
  const clone = [...items];

  for (let index = clone.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [clone[index], clone[swapIndex]] = [clone[swapIndex], clone[index]];
  }

  return clone;
}

function randomItem<T>(items: T[]): T | null {
  if (items.length === 0) {
    return null;
  }

  return items[Math.floor(Math.random() * items.length)] ?? null;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readRawBody(req);
  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

async function consumeBody(req: IncomingMessage): Promise<void> {
  await readRawBody(req);
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}
