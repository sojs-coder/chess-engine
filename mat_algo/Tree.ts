import { Board } from './Board';
import { Color, Move, Square } from './types';
import { strength } from './Strength';

const CHECKMATE_SCORE = 1_000_000;

function getAllMoves(board: Board): Move[] {
  const moves: Move[] = [];
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      moves.push(...board.getLegalMoves({ file, rank }));
    }
  }
  return moves;
}

// Captures first — dramatically improves alpha-beta cutoff rate
function orderMoves(board: Board, moves: Move[]): Move[] {
  return moves.sort((a, b) => {
    const ca = board.getPiece(a.to) !== null ? 1 : 0;
    const cb = board.getPiece(b.to) !== null ? 1 : 0;
    return cb - ca;
  });
}

/**
 * Returns all legal moves for the active color that capture the piece sitting
 * on `target`. Returns empty if the square is unoccupied (no capture to make).
 */
function getCapturesOf(board: Board, target: Square): Move[] {
  if (board.getPiece(target) === null) return [];
  const captures: Move[] = [];
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      board.getLegalMoves({ file, rank })
        .filter(m => m.to.file === target.file && m.to.rank === target.rank)
        .forEach(m => captures.push(m));
    }
  }
  return captures;
}

/**
 * Quiescence search: resolves capture chains at the frontier.
 *
 * Instead of evaluating the position immediately at depth 0, we follow every
 * sequence of recaptures on `captureTarget` (the square where the last piece
 * landed) until no side wants to capture there any more. This prevents the
 * horizon effect where the engine counts a capture as a gain without seeing
 * the immediate recapture that takes it back.
 *
 * Critically, only captures OF `captureTarget` are considered — not all
 * captures on the board. This ensures we don't penalise a move for threats
 * that existed before the move was played (e.g. an unrelated hanging piece
 * that was already attackable).
 *
 * Standing pat (choosing not to recapture) is always an option: if the
 * current static evaluation is already acceptable the side to move can decline
 * the exchange.
 */
function quiescence(
  board: Board,
  alpha: number,
  beta: number,
  engineColor: Color,
  captureTarget: Square,
  isMaximizing: boolean
): number {
  const standPat = strength(board, engineColor);

  // Standing pat cutoff — also doubles as the return value when no captures exist
  if (isMaximizing) {
    if (standPat >= beta) return standPat;
    alpha = Math.max(alpha, standPat);
  } else {
    if (standPat <= alpha) return standPat;
    beta = Math.min(beta, standPat);
  }

  // Only look at captures of the piece that just landed on captureTarget
  const captures = getCapturesOf(board, captureTarget);

  for (const move of captures) {
    if (!board.makeMove(move)) continue;
    // After the capture, captureTarget still holds the new piece — recurse there
    const score = quiescence(board, alpha, beta, engineColor, captureTarget, !isMaximizing);
    board.undoMove();

    if (isMaximizing) {
      alpha = Math.max(alpha, score);
      if (alpha >= beta) break;
    } else {
      beta = Math.min(beta, score);
      if (beta <= alpha) break;
    }
  }

  return isMaximizing ? alpha : beta;
}

/**
 * Alpha-beta minimax.
 *
 * `isMaximizing` — true when it is the engine's turn (maximizing engineColor's score),
 *                  false when it is the opponent's turn.
 * `lastMove`     — the move that produced this position, used to seed quiescence at
 *                  depth 0 with the square that was just occupied.
 */
function minimax(
  board: Board,
  depth: number,
  alpha: number,
  beta: number,
  engineColor: Color,
  isMaximizing: boolean,
  lastMove: Move | null
): number {
  if (board.isCheckmate()) {
    return isMaximizing ? -CHECKMATE_SCORE : CHECKMATE_SCORE;
  }

  if (board.isStalemate()) return 0;

  if (depth === 0) {
    // Hand off to quiescence rather than returning the static eval directly.
    // If there was no prior move (root call edge case), fall back to static eval.
    return lastMove
      ? quiescence(board, alpha, beta, engineColor, lastMove.to, isMaximizing)
      : strength(board, engineColor);
  }

  const moves = orderMoves(board, getAllMoves(board));

  if (isMaximizing) {
    let best = -Infinity;
    for (const move of moves) {
      if (!board.makeMove(move)) continue;
      const score = minimax(board, depth - 1, alpha, beta, engineColor, false, move);
      board.undoMove();
      best = Math.max(best, score);
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const move of moves) {
      if (!board.makeMove(move)) continue;
      const score = minimax(board, depth - 1, alpha, beta, engineColor, true, move);
      board.undoMove();
      best = Math.min(best, score);
      beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
    return best;
  }
}

/**
 * Searches the game tree to the given depth and returns the best move for the
 * engine (the side currently to move on `board`).
 *
 * @param board       Current board position. Must be the engine's turn.
 * @param depth       Search depth in plies. 4–6 is practical for real-time play.
 * @param engineColor The color the engine is playing.
 * @returns The best Move found, or null if there are no legal moves.
 */
export function search(board: Board, depth: number, engineColor: Color): Move | null {
  const moves = orderMoves(board, getAllMoves(board));
  if (moves.length === 0) return null;

  let bestMove: Move | null = null;
  let bestScore = -Infinity;
  let alpha = -Infinity;
  const beta = Infinity;

  for (const move of moves) {
    if (!board.makeMove(move)) continue;
    const score = minimax(board, depth - 1, alpha, beta, engineColor, false, move);
    board.undoMove();

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
    alpha = Math.max(alpha, bestScore);
  }

  return bestMove;
}
