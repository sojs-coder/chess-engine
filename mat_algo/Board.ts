import { Color, Piece, PieceType, Square, Move, GameState, MoveHistory } from './types';

export class Board {
    private board: (Piece | null)[][] = [];
    private whiteKingPos: Square = { file: 4, rank: 0 };
    private blackKingPos: Square = { file: 4, rank: 7 };
    private whiteCanCastleKingside: boolean = true;
    private whiteCanCastleQueenside: boolean = true;
    private blackCanCastleKingside: boolean = true;
    private blackCanCastleQueenside: boolean = true;
    private enPassantTarget: Square | null = null;
    private halfmoveClock: number = 0;
    private fullmoveNumber: number = 1;
    private activeColor: Color = Color.White;
    private moveHistory: MoveHistory[] = [];

    constructor() {
        this.initializeBoard();
    }

    static fromPosition(
        pieces: (Piece | null)[][],
        activeColor: Color,
        castlingRights: {
            whiteKingSide: boolean;
            whiteQueenSide: boolean;
            blackKingSide: boolean;
            blackQueenSide: boolean;
        },
        enPassantTarget: Square | null
    ): Board {
        const b = new Board();
        b.board = pieces.map(row => [...row]);
        b.activeColor = activeColor;
        b.whiteCanCastleKingside = castlingRights.whiteKingSide;
        b.whiteCanCastleQueenside = castlingRights.whiteQueenSide;
        b.blackCanCastleKingside = castlingRights.blackKingSide;
        b.blackCanCastleQueenside = castlingRights.blackQueenSide;
        b.enPassantTarget = enPassantTarget;
        b.moveHistory = [];
        // Locate kings so check detection works
        for (let rank = 0; rank < 8; rank++) {
            for (let file = 0; file < 8; file++) {
                const piece = b.board[rank][file];
                if (piece?.type === PieceType.King) {
                    if (piece.color === Color.White) b.whiteKingPos = { file, rank };
                    else b.blackKingPos = { file, rank };
                }
            }
        }
        return b;
    }

    private initializeBoard(): void {
        this.board = Array(8)
            .fill(null)
            .map(() => Array(8).fill(null));

        // Set up white pieces
        this.setPiece({ file: 0, rank: 0 }, { type: PieceType.Rook, color: Color.White });
        this.setPiece({ file: 1, rank: 0 }, { type: PieceType.Knight, color: Color.White });
        this.setPiece({ file: 2, rank: 0 }, { type: PieceType.Bishop, color: Color.White });
        this.setPiece({ file: 3, rank: 0 }, { type: PieceType.Queen, color: Color.White });
        this.setPiece({ file: 4, rank: 0 }, { type: PieceType.King, color: Color.White });
        this.setPiece({ file: 5, rank: 0 }, { type: PieceType.Bishop, color: Color.White });
        this.setPiece({ file: 6, rank: 0 }, { type: PieceType.Knight, color: Color.White });
        this.setPiece({ file: 7, rank: 0 }, { type: PieceType.Rook, color: Color.White });

        for (let file = 0; file < 8; file++) {
            this.setPiece({ file, rank: 1 }, { type: PieceType.Pawn, color: Color.White });
        }

        // Set up black pieces
        this.setPiece({ file: 0, rank: 7 }, { type: PieceType.Rook, color: Color.Black });
        this.setPiece({ file: 1, rank: 7 }, { type: PieceType.Knight, color: Color.Black });
        this.setPiece({ file: 2, rank: 7 }, { type: PieceType.Bishop, color: Color.Black });
        this.setPiece({ file: 3, rank: 7 }, { type: PieceType.Queen, color: Color.Black });
        this.setPiece({ file: 4, rank: 7 }, { type: PieceType.King, color: Color.Black });
        this.setPiece({ file: 5, rank: 7 }, { type: PieceType.Bishop, color: Color.Black });
        this.setPiece({ file: 6, rank: 7 }, { type: PieceType.Knight, color: Color.Black });
        this.setPiece({ file: 7, rank: 7 }, { type: PieceType.Rook, color: Color.Black });

        for (let file = 0; file < 8; file++) {
            this.setPiece({ file, rank: 6 }, { type: PieceType.Pawn, color: Color.Black });
        }
    }

    private isValidSquare(square: Square): boolean {
        return square.file >= 0 && square.file < 8 && square.rank >= 0 && square.rank < 8;
    }

    private setPiece(square: Square, piece: Piece | null): void {
        if (!this.isValidSquare(square)) return;
        this.board[square.rank][square.file] = piece;
    }

    getPiece(square: Square): Piece | null {
        if (!this.isValidSquare(square)) return null;
        return this.board[square.rank][square.file];
    }

    getBoard(): (Piece | null)[][] {
        return this.board.map(row => [...row]);
    }

    private isOccupiedBy(square: Square, color: Color): boolean {
        const piece = this.getPiece(square);
        return piece !== null && piece.color === color;
    }

    private isOpponentPiece(square: Square, color: Color): boolean {
        const piece = this.getPiece(square);
        return piece !== null && piece.color !== color;
    }

    private addMoveIfValid(
        moves: Move[],
        from: Square,
        to: Square,
        color: Color
    ): boolean {
        if (!this.isValidSquare(to)) return false;
        if (this.isOccupiedBy(to, color)) return false;
        moves.push({ from, to });
        return !this.isOpponentPiece(to, color);
    }

    private isPathClear(from: Square, to: Square): boolean {
        const fileDir = Math.sign(to.file - from.file);
        const rankDir = Math.sign(to.rank - from.rank);
        let current = { file: from.file + fileDir, rank: from.rank + rankDir };

        while (current.file !== to.file || current.rank !== to.rank) {
            if (this.getPiece(current) !== null) return false;
            current.file += fileDir;
            current.rank += rankDir;
        }

        return true;
    }

    private getPawnMoves(square: Square, piece: Piece): Move[] {
        const moves: Move[] = [];
        const direction = piece.color === Color.White ? 1 : -1;
        const startRank = piece.color === Color.White ? 1 : 6;

        const oneSquare = { file: square.file, rank: square.rank + direction };
        if (this.isValidSquare(oneSquare) && this.getPiece(oneSquare) === null) {
            moves.push({ from: square, to: oneSquare });

            if (square.rank === startRank) {
                const twoSquares = { file: square.file, rank: square.rank + 2 * direction };
                if (this.getPiece(twoSquares) === null) {
                    moves.push({ from: square, to: twoSquares });
                }
            }
        }

        // Captures
        for (const fileOffset of [-1, 1]) {
            const captureSquare = { file: square.file + fileOffset, rank: square.rank + direction };
            if (this.isValidSquare(captureSquare) && this.isOpponentPiece(captureSquare, piece.color)) {
                moves.push({ from: square, to: captureSquare });
            }

            // En passant
            if (
                this.enPassantTarget &&
                captureSquare.file === this.enPassantTarget.file &&
                captureSquare.rank === this.enPassantTarget.rank
            ) {
                moves.push({ from: square, to: captureSquare });
            }
        }

        return moves;
    }

    private getKnightMoves(square: Square, piece: Piece): Move[] {
        const moves: Move[] = [];
        const offsets = [
            { file: 2, rank: 1 },
            { file: 2, rank: -1 },
            { file: -2, rank: 1 },
            { file: -2, rank: -1 },
            { file: 1, rank: 2 },
            { file: 1, rank: -2 },
            { file: -1, rank: 2 },
            { file: -1, rank: -2 },
        ];

        for (const offset of offsets) {
            const target = { file: square.file + offset.file, rank: square.rank + offset.rank };
            this.addMoveIfValid(moves, square, target, piece.color);
        }

        return moves;
    }

    private getSlidingMoves(square: Square, piece: Piece, directions: number[][]): Move[] {
        const moves: Move[] = [];

        for (const [fileDir, rankDir] of directions) {
            let current = { file: square.file + fileDir, rank: square.rank + rankDir };

            while (this.isValidSquare(current)) {
                if (this.isOccupiedBy(current, piece.color)) break;

                moves.push({ from: square, to: { ...current } });

                if (this.isOpponentPiece(current, piece.color)) break;

                current.file += fileDir;
                current.rank += rankDir;
            }
        }

        return moves;
    }

    private getBishopMoves(square: Square, piece: Piece): Move[] {
        return this.getSlidingMoves(square, piece, [
            [1, 1],
            [1, -1],
            [-1, 1],
            [-1, -1],
        ]);
    }

    private getRookMoves(square: Square, piece: Piece): Move[] {
        return this.getSlidingMoves(square, piece, [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
        ]);
    }

    private getQueenMoves(square: Square, piece: Piece): Move[] {
        return this.getSlidingMoves(square, piece, [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
            [1, 1],
            [1, -1],
            [-1, 1],
            [-1, -1],
        ]);
    }

    private getKingMoves(square: Square, piece: Piece): Move[] {
        const moves: Move[] = [];
        for (let file = -1; file <= 1; file++) {
            for (let rank = -1; rank <= 1; rank++) {
                if (file === 0 && rank === 0) continue;
                const target = { file: square.file + file, rank: square.rank + rank };
                this.addMoveIfValid(moves, square, target, piece.color);
            }
        }

        // Castling
        if (piece.color === Color.White) {
            if (this.whiteCanCastleKingside && this.canCastleKingside(Color.White)) {
                moves.push({ from: square, to: { file: 6, rank: 0 } });
            }
            if (this.whiteCanCastleQueenside && this.canCastleQueenside(Color.White)) {
                moves.push({ from: square, to: { file: 2, rank: 0 } });
            }
        } else {
            if (this.blackCanCastleKingside && this.canCastleKingside(Color.Black)) {
                moves.push({ from: square, to: { file: 6, rank: 7 } });
            }
            if (this.blackCanCastleQueenside && this.canCastleQueenside(Color.Black)) {
                moves.push({ from: square, to: { file: 2, rank: 7 } });
            }
        }

        return moves;
    }

    private canCastleKingside(color: Color): boolean {
        const rank = color === Color.White ? 0 : 7;
        return (
            this.getPiece({ file: 5, rank }) === null &&
            this.getPiece({ file: 6, rank }) === null
        );
    }

    private canCastleQueenside(color: Color): boolean {
        const rank = color === Color.White ? 0 : 7;
        return (
            this.getPiece({ file: 1, rank }) === null &&
            this.getPiece({ file: 2, rank }) === null &&
            this.getPiece({ file: 3, rank }) === null
        );
    }

    getLegalMoves(square: Square): Move[] {
        const piece = this.getPiece(square);
        if (!piece || piece.color !== this.activeColor) return [];

        let moves: Move[] = [];

        switch (piece.type) {
            case PieceType.Pawn:
                moves = this.getPawnMoves(square, piece);
                break;
            case PieceType.Knight:
                moves = this.getKnightMoves(square, piece);
                break;
            case PieceType.Bishop:
                moves = this.getBishopMoves(square, piece);
                break;
            case PieceType.Rook:
                moves = this.getRookMoves(square, piece);
                break;
            case PieceType.Queen:
                moves = this.getQueenMoves(square, piece);
                break;
            case PieceType.King:
                moves = this.getKingMoves(square, piece);
                break;
        }

        return moves.filter(move => !this.leavesKingInCheck(piece.color, move));
    }

    private leavesKingInCheck(color: Color, move: Move): boolean {
        const prevState = this.captureState();
        this.executeMove(move);
        const inCheck = this.isKingInCheck(color);
        this.restoreState(prevState);
        return inCheck;
    }

    private captureState(): Partial<GameState> {
        return {
            board: this.board.map(row => [...row]),
            whiteKingPos: { ...this.whiteKingPos },
            blackKingPos: { ...this.blackKingPos },
            whiteCanCastleKingside: this.whiteCanCastleKingside,
            whiteCanCastleQueenside: this.whiteCanCastleQueenside,
            blackCanCastleKingside: this.blackCanCastleKingside,
            blackCanCastleQueenside: this.blackCanCastleQueenside,
            enPassantTarget: this.enPassantTarget ? { ...this.enPassantTarget } : null,
            halfmoveClock: this.halfmoveClock,
            fullmoveNumber: this.fullmoveNumber,
            activeColor: this.activeColor,
        };
    }

    private restoreState(state: Partial<GameState>): void {
        if (state.board) this.board = state.board.map(row => [...row]);
        if (state.whiteKingPos) this.whiteKingPos = { ...state.whiteKingPos };
        if (state.blackKingPos) this.blackKingPos = { ...state.blackKingPos };
        if (state.whiteCanCastleKingside !== undefined)
            this.whiteCanCastleKingside = state.whiteCanCastleKingside;
        if (state.whiteCanCastleQueenside !== undefined)
            this.whiteCanCastleQueenside = state.whiteCanCastleQueenside;
        if (state.blackCanCastleKingside !== undefined)
            this.blackCanCastleKingside = state.blackCanCastleKingside;
        if (state.blackCanCastleQueenside !== undefined)
            this.blackCanCastleQueenside = state.blackCanCastleQueenside;
        if (state.enPassantTarget !== undefined)
            this.enPassantTarget = state.enPassantTarget ? { ...state.enPassantTarget } : null;
        if (state.halfmoveClock !== undefined) this.halfmoveClock = state.halfmoveClock;
        if (state.fullmoveNumber !== undefined) this.fullmoveNumber = state.fullmoveNumber;
        if (state.activeColor) this.activeColor = state.activeColor;
    }

    private executeMove(move: Move): void {
        const piece = this.getPiece(move.from);
        const capturedPiece = this.getPiece(move.to);

        if (!piece) return;

        this.setPiece(move.from, null);
        this.setPiece(move.to, piece);

        if (piece.type === PieceType.King) {
            if (piece.color === Color.White) {
                this.whiteKingPos = move.to;
            } else {
                this.blackKingPos = move.to;
            }

            // Castling
            if (Math.abs(move.to.file - move.from.file) === 2) {
                if (move.to.file === 6) {
                    const rook = this.getPiece({ file: 7, rank: move.from.rank });
                    this.setPiece({ file: 7, rank: move.from.rank }, null);
                    this.setPiece({ file: 5, rank: move.from.rank }, rook);
                } else if (move.to.file === 2) {
                    const rook = this.getPiece({ file: 0, rank: move.from.rank });
                    this.setPiece({ file: 0, rank: move.from.rank }, null);
                    this.setPiece({ file: 3, rank: move.from.rank }, rook);
                }
            }

            if (piece.color === Color.White) {
                this.whiteCanCastleKingside = false;
                this.whiteCanCastleQueenside = false;
            } else {
                this.blackCanCastleKingside = false;
                this.blackCanCastleQueenside = false;
            }
        }

        if (piece.type === PieceType.Rook) {
            if (piece.color === Color.White) {
                if (move.from.file === 7) this.whiteCanCastleKingside = false;
                if (move.from.file === 0) this.whiteCanCastleQueenside = false;
            } else {
                if (move.from.file === 7) this.blackCanCastleKingside = false;
                if (move.from.file === 0) this.blackCanCastleQueenside = false;
            }
        }

        // En passant capture
        if (piece.type === PieceType.Pawn && this.enPassantTarget && move.to.file === this.enPassantTarget.file && move.to.rank === this.enPassantTarget.rank && !capturedPiece) {
            const captureRank = piece.color === Color.White ? move.to.rank - 1 : move.to.rank + 1;
            this.setPiece({ file: move.to.file, rank: captureRank }, null);
        }

        this.enPassantTarget = null;

        // Pawn double move
        if (piece.type === PieceType.Pawn && Math.abs(move.to.rank - move.from.rank) === 2) {
            this.enPassantTarget = { file: move.to.file, rank: (move.from.rank + move.to.rank) / 2 };
        }

        // Update halfmove clock
        if (piece.type === PieceType.Pawn || capturedPiece) {
            this.halfmoveClock = 0;
        } else {
            this.halfmoveClock++;
        }

        this.activeColor = this.activeColor === Color.White ? Color.Black : Color.White;

        if (this.activeColor === Color.White) {
            this.fullmoveNumber++;
        }
    }

    makeMove(move: Move): boolean {
        const legalMoves = this.getLegalMoves(move.from);
        const isLegal = legalMoves.some(m => m.to.file === move.to.file && m.to.rank === move.to.rank);

        if (!isLegal) return false;

        const prevState = this.captureState();
        const capturedPiece = this.getPiece(move.to);

        this.executeMove(move);

        this.moveHistory.push({
            move,
            capturedPiece: capturedPiece || null,
            prevState,
        });

        return true;
    }

    undoMove(): boolean {
        if (this.moveHistory.length === 0) return false;

        const history = this.moveHistory.pop();
        if (!history) return false;

        this.restoreState(history.prevState);
        return true;
    }

    private isKingInCheck(color: Color): boolean {
        const kingPos = color === Color.White ? this.whiteKingPos : this.blackKingPos;
        const opponentColor = color === Color.White ? Color.Black : Color.White;

        for (let rank = 0; rank < 8; rank++) {
            for (let file = 0; file < 8; file++) {
                const square = { file, rank };
                const piece = this.getPiece(square);

                if (!piece || piece.color !== opponentColor) continue;

                const mockBoard = this.board;
                const moves =
                    piece.type === PieceType.Pawn
                        ? this.getPawnMoves(square, piece)
                        : piece.type === PieceType.Knight
                            ? this.getKnightMoves(square, piece)
                            : piece.type === PieceType.Bishop
                                ? this.getBishopMoves(square, piece)
                                : piece.type === PieceType.Rook
                                    ? this.getRookMoves(square, piece)
                                    : piece.type === PieceType.Queen
                                        ? this.getQueenMoves(square, piece)
                                        : this.getKingMoves(square, piece);

                if (moves.some(m => m.to.file === kingPos.file && m.to.rank === kingPos.rank)) {
                    return true;
                }
            }
        }

        return false;
    }

    isInCheck(): boolean {
        return this.isKingInCheck(this.activeColor);
    }

    isCheckmate(): boolean {
        if (!this.isInCheck()) return false;

        for (let rank = 0; rank < 8; rank++) {
            for (let file = 0; file < 8; file++) {
                const square = { file, rank };
                if (this.getLegalMoves(square).length > 0) {
                    return false;
                }
            }
        }

        return true;
    }

    isStalemate(): boolean {
        if (this.isInCheck()) return false;

        for (let rank = 0; rank < 8; rank++) {
            for (let file = 0; file < 8; file++) {
                const square = { file, rank };
                if (this.getLegalMoves(square).length > 0) {
                    return false;
                }
            }
        }

        return true;
    }

    getGameState(): GameState {
        return {
            board: this.board.map(row => [...row]),
            whiteKingPos: { ...this.whiteKingPos },
            blackKingPos: { ...this.blackKingPos },
            whiteCanCastleKingside: this.whiteCanCastleKingside,
            whiteCanCastleQueenside: this.whiteCanCastleQueenside,
            blackCanCastleKingside: this.blackCanCastleKingside,
            blackCanCastleQueenside: this.blackCanCastleQueenside,
            enPassantTarget: this.enPassantTarget ? { ...this.enPassantTarget } : null,
            halfmoveClock: this.halfmoveClock,
            fullmoveNumber: this.fullmoveNumber,
            activeColor: this.activeColor,
        };
    }

    getActiveColor(): Color {
        return this.activeColor;
    }

    getMoveHistory(): MoveHistory[] {
        return [...this.moveHistory];
    }
}
