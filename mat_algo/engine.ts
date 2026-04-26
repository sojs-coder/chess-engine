import { Board } from "./Board";
import { search } from "./Tree";
import { Color, Move } from "./types";

/**
 * Iterative deepening search with a time budget.
 *
 * Always completes at least 4 plies. Keeps searching deeper until
 * time_exploring > roundAdditionalSeconds - 0.5 (0.5s buffer for latency).
 * Returns the best move from the last fully completed search.
 */
export function findBestMove(
    board: Board,
    engineColor: Color,
    roundAdditionalSeconds: number
): Move | null {
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
