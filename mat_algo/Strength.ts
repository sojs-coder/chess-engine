/**
 * Strength evaluation for a chess position.
 *
 * Factors (all normalized to [-1, 1] before weighting):
 *   - Material possession
 *   - Pawn advancement (average progress, normalized by count)
 *   - Piece mobility (unique squares controlled)
 *   - Winning threats: Σ max(0, value(target) − value(cheapest attacker)) — SEE-lite
 *   - Hanging pieces: Σ value(attacked-and-undefended pieces) differential
 *
 * The exported `strength` function optionally runs a 1- or 2-ply minimax
 * lookahead so the leaf evaluation is not purely static.
 */

import { Board } from './Board';
import { Color, Move, Piece, PieceType, Square } from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Weights = {
  material: number;
  mobility: number;
  pawnAdvancement: number;
  /** Value-weighted winning threats: Σ max(0, value(target) − value(cheapest attacker)). */
  threats: number;
  /** Value-weighted hanging pieces: Σ value(attacked-and-undefended pieces) differential. */
  hanging: number;
};

// Averaged across 15 generations of GA self-play (head-to-head, continuous scoring).
export const DEFAULT_WEIGHTS: Weights = {
  material:        0.398,
  mobility:        0.120,
  pawnAdvancement: 0.193,
  threats:         0.164,
  hanging:         0.125,
};

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const PIECE_VALUES: Record<PieceType, number> = {
  [PieceType.Pawn]: 1,
  [PieceType.Knight]: 3,
  [PieceType.Bishop]: 3.25,
  [PieceType.Rook]: 5,
  [PieceType.Queen]: 9,
  [PieceType.King]: 0,
};

const MAX_MATERIAL = 8 * 1 + 2 * 3 + 2 * 3.25 + 2 * 5 + 9; // ≈ 39.5

const CHECKMATE_SCORE = 1_000_000;

// ---------------------------------------------------------------------------
// Attack geometry (raw attacks, ignoring check — used for mobility / threats)
// ---------------------------------------------------------------------------

function isValid(sq: Square): boolean {
  return sq.file >= 0 && sq.file < 8 && sq.rank >= 0 && sq.rank < 8;
}

function getPieceAttacks(grid: (Piece | null)[][], sq: Square, piece: Piece): Square[] {
  const attacks: Square[] = [];
  const { file, rank } = sq;

  const push = (f: number, r: number) => {
    if (isValid({ file: f, rank: r })) attacks.push({ file: f, rank: r });
  };

  const slide = (dirs: [number, number][]) => {
    for (const [fd, rd] of dirs) {
      let f = file + fd, r = rank + rd;
      while (f >= 0 && f < 8 && r >= 0 && r < 8) {
        attacks.push({ file: f, rank: r });
        if (grid[r][f] !== null) break;
        f += fd; r += rd;
      }
    }
  };

  switch (piece.type) {
    case PieceType.Pawn: {
      const d = piece.color === Color.White ? 1 : -1;
      push(file - 1, rank + d);
      push(file + 1, rank + d);
      break;
    }
    case PieceType.Knight:
      for (const [fd, rd] of [[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[1,-2],[-1,2],[-1,-2]] as [number,number][])
        push(file + fd, rank + rd);
      break;
    case PieceType.Bishop: slide([[1,1],[1,-1],[-1,1],[-1,-1]]); break;
    case PieceType.Rook:   slide([[1,0],[-1,0],[0,1],[0,-1]]);  break;
    case PieceType.Queen:  slide([[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]); break;
    case PieceType.King:
      for (let fd = -1; fd <= 1; fd++)
        for (let rd = -1; rd <= 1; rd++)
          if (fd !== 0 || rd !== 0) push(file + fd, rank + rd);
      break;
  }

  return attacks;
}

// ---------------------------------------------------------------------------
// Static evaluation (no lookahead)
// ---------------------------------------------------------------------------

export function evaluateStatic(board: Board, color: Color, weights: Weights = DEFAULT_WEIGHTS): number {
  const grid = board.getBoard();
  const opp = color === Color.White ? Color.Black : Color.White;

  type Entry = { square: Square; piece: Piece };
  const mine: Entry[] = [], theirs: Entry[] = [];

  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const piece = grid[rank][file];
      if (!piece) continue;
      (piece.color === color ? mine : theirs).push({ square: { file, rank }, piece });
    }
  }

  // 1. Material
  const myMat  = mine.reduce((s, e)   => s + PIECE_VALUES[e.piece.type], 0);
  const oppMat = theirs.reduce((s, e) => s + PIECE_VALUES[e.piece.type], 0);
  const materialScore = (myMat - oppMat) / MAX_MATERIAL;

  // 2. Pawn advancement
  const advance = (entries: Entry[], c: Color) => {
    const pawns = entries.filter(e => e.piece.type === PieceType.Pawn);
    if (pawns.length === 0) return 0;
    const total = pawns.reduce((s, e) => {
      const a = c === Color.White ? (e.square.rank - 1) / 5 : (6 - e.square.rank) / 5;
      return s + Math.max(0, a);
    }, 0);
    return total / pawns.length;
  };
  const pawnScore = advance(mine, color) - advance(theirs, opp);

  // Build attacker maps: square → ascending-sorted list of attacker piece values.
  // One pass covers mobility, threat exchange values, and hanging piece detection.
  const myAttackers  = new Map<string, number[]>();
  const oppAttackers = new Map<string, number[]>();

  const buildAttackers = (entries: Entry[], map: Map<string, number[]>) => {
    for (const e of entries) {
      const val = PIECE_VALUES[e.piece.type];
      for (const sq of getPieceAttacks(grid, e.square, e.piece)) {
        const key = `${sq.file},${sq.rank}`;
        const list = map.get(key);
        if (list) list.push(val);
        else map.set(key, [val]);
      }
    }
    for (const list of map.values()) list.sort((a, b) => a - b); // cheapest attacker first
  };

  buildAttackers(mine, myAttackers);
  buildAttackers(theirs, oppAttackers);

  // 3. Mobility — unique squares controlled
  const mobilityScore = (myAttackers.size - oppAttackers.size) / 64;

  // 4. Value-weighted winning threats (SEE-lite)
  // For each attacked target: exchange = value(target) − value(our cheapest attacker).
  // Only profitable exchanges (exchange > 0) are counted — threatening a queen with a
  // pawn is winning; threatening a pawn with a queen is not a useful threat.
  const winningExchangeSum = (targets: Entry[], attackers: Map<string, number[]>): number => {
    let sum = 0;
    for (const e of targets) {
      const list = attackers.get(`${e.square.file},${e.square.rank}`);
      if (!list) continue;
      const exchange = PIECE_VALUES[e.piece.type] - list[0]; // list[0] = cheapest attacker
      if (exchange > 0) sum += exchange;
    }
    return sum;
  };

  const threatsScore = (winningExchangeSum(theirs, myAttackers) -
                        winningExchangeSum(mine,   oppAttackers)) / MAX_MATERIAL;

  // 5. Hanging pieces — attacked and not defended, weighted by piece value
  // A piece is hanging when it has at least one attacker and zero defenders.
  // Leaves on the table are measured in raw material value, not piece count.
  const hangingSum = (targets: Entry[], attackers: Map<string, number[]>, defenders: Map<string, number[]>): number => {
    let sum = 0;
    for (const e of targets) {
      const key = `${e.square.file},${e.square.rank}`;
      if ((attackers.get(key)?.length ?? 0) > 0 && (defenders.get(key)?.length ?? 0) === 0)
        sum += PIECE_VALUES[e.piece.type];
    }
    return sum;
  };

  const hangingScore = (hangingSum(theirs, myAttackers, oppAttackers) -
                        hangingSum(mine,   oppAttackers, myAttackers)) / MAX_MATERIAL;

  return (
    materialScore * weights.material        +
    mobilityScore * weights.mobility        +
    pawnScore     * weights.pawnAdvancement +
    threatsScore  * weights.threats         +
    hangingScore  * weights.hanging
  );
}

// ---------------------------------------------------------------------------
// Internal mini alpha-beta used for lookahead inside strength()
// (separate from Tree.ts's search to avoid circular imports)
// ---------------------------------------------------------------------------

function allMoves(board: Board): Move[] {
  const moves: Move[] = [];
  for (let rank = 0; rank < 8; rank++)
    for (let file = 0; file < 8; file++)
      moves.push(...board.getLegalMoves({ file, rank }));
  // Captures first — better pruning
  return moves.sort((a, b) =>
    (board.getPiece(b.to) ? 1 : 0) - (board.getPiece(a.to) ? 1 : 0)
  );
}

function lookaheadMinimax(
  board: Board,
  depth: number,
  alpha: number,
  beta: number,
  engineColor: Color,
  isMaximizing: boolean,
  weights: Weights
): number {
  if (board.isCheckmate()) return isMaximizing ? -CHECKMATE_SCORE : CHECKMATE_SCORE;
  if (board.isStalemate()) return 0;
  if (depth === 0) return evaluateStatic(board, engineColor, weights);

  const moves = allMoves(board);

  if (isMaximizing) {
    let best = -Infinity;
    for (const m of moves) {
      if (!board.makeMove(m)) continue;
      best = Math.max(best, lookaheadMinimax(board, depth - 1, alpha, beta, engineColor, false, weights));
      board.undoMove();
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const m of moves) {
      if (!board.makeMove(m)) continue;
      best = Math.min(best, lookaheadMinimax(board, depth - 1, alpha, beta, engineColor, true, weights));
      board.undoMove();
      beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluates the position for `color`.
 *
 * @param board         Board to evaluate.
 * @param color         The side whose strength is returned (positive = stronger).
 * @param weights       Factor weights (defaults to DEFAULT_WEIGHTS).
 * @param lookaheadPly  0 = pure static eval; 1 or 2 = mini alpha-beta lookahead.
 *                      Use 1–2 for better accuracy at a small speed cost.
 *                      Tree.ts's full search already provides deep lookahead;
 *                      this parameter is useful when strength() is called in
 *                      isolation (e.g., from the genetic optimizer fitness fn).
 */
export function strength(
  board: Board,
  color: Color,
  weights: Weights = DEFAULT_WEIGHTS,
  lookaheadPly: 0 | 1 | 2 = 0
): number {
  if (lookaheadPly === 0) return evaluateStatic(board, color, weights);
  const isMax = board.getActiveColor() === color;
  return lookaheadMinimax(board, lookaheadPly, -Infinity, Infinity, color, isMax, weights);
}
