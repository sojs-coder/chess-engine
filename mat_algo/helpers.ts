import { GameState, Move, PieceType, Square } from "./types";

function extractMoveFromStates(prevState: Partial<GameState>, nextState: Partial<GameState>): Move | null {
    if (!prevState.board || !nextState.board) return null;

    let fromSquare: Square | null = null;
    let toSquare: Square | null = null;

    for (let rank = 0; rank < 8; rank++) {
        for (let file = 0; file < 8; file++) {
            const prevPiece = prevState.board[rank][file];
            const nextPiece = nextState.board[rank][file];

            if (prevPiece && !nextPiece) {
                fromSquare = { file, rank };
            } else if (!prevPiece && nextPiece) {
                toSquare = { file, rank };
            } else if (prevPiece && nextPiece && prevPiece.type !== nextPiece.type) {
                toSquare = { file, rank }; // Handle promotion case where piece type changes but color remains the same
            }
        }
    }

    if (!fromSquare || !toSquare) return null;

    const movedPiece = prevState.board[fromSquare.rank][fromSquare.file];
    const targetPiece = nextState.board[toSquare.rank][toSquare.file];

    const move: Move = { from: fromSquare, to: toSquare };

    // Check for promotion: if a pawn moved to destination with a non-pawn piece
    if (movedPiece && movedPiece.type === PieceType.Pawn && targetPiece && targetPiece.type !== PieceType.Pawn && movedPiece.color === targetPiece.color) {
        move.promotion = targetPiece.type;
    }

    return move;
}