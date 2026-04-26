export enum Color {
    White = 'white',
    Black = 'black',
}

export enum PieceType {
    Pawn = 'pawn',
    Knight = 'knight',
    Bishop = 'bishop',
    Rook = 'rook',
    Queen = 'queen',
    King = 'king',
}

export interface Piece {
    type: PieceType;
    color: Color;
}

export interface Square {
    file: number; // 0-7 (a-h)
    rank: number; // 0-7 (1-8)
}

export interface Move {
    from: Square;
    to: Square;
    promotion?: PieceType; // for pawn promotion
}

export interface GameState {
    board: (Piece | null)[][];
    whiteKingPos: Square;
    blackKingPos: Square;
    whiteCanCastleKingside: boolean;
    whiteCanCastleQueenside: boolean;
    blackCanCastleKingside: boolean;
    blackCanCastleQueenside: boolean;
    enPassantTarget: Square | null;
    halfmoveClock: number; // for 50-move rule
    fullmoveNumber: number;
    activeColor: Color;
}

export interface MoveHistory {
    move: Move;
    capturedPiece: Piece | null;
    prevState: Partial<GameState>;
}
