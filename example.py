import json
import os
import random
from http.server import BaseHTTPRequestHandler, HTTPServer


PORT = int(os.environ.get("PORT", "4002"))
FILES = "ABCDEFGH"


def parse_piece(cell):
    if not isinstance(cell, str) or cell == "":
        return None

    color = "white" if cell[0] == "w" else "black"
    piece_map = {
        "P": "pawn",
        "R": "rook",
        "N": "knight",
        "B": "bishop",
        "Q": "queen",
        "K": "king",
    }

    return {"color": color, "type": piece_map[cell[1]]}


def deserialize_board(raw_board):
    return [[parse_piece(cell) for cell in row] for row in raw_board]

def is_on_board(square):
    return 0 <= square["row"] < 8 and 0 <= square["col"] < 8


def coordinate_to_notation(square):
    return f"{FILES[square['col']]}{8 - square['row']}"


def get_pawn_targets(board, from_square, color):
    direction = -1 if color == "white" else 1
    start_row = 6 if color == "white" else 1
    targets = []

    one_forward = {"row": from_square["row"] + direction, "col": from_square["col"]}
    if is_on_board(one_forward) and board[one_forward["row"]][one_forward["col"]] is None:
        targets.append(one_forward)

        two_forward = {"row": from_square["row"] + (direction * 2), "col": from_square["col"]}
        if from_square["row"] == start_row and board[two_forward["row"]][two_forward["col"]] is None:
            targets.append(two_forward)

    for col_delta in (-1, 1):
        capture = {"row": from_square["row"] + direction, "col": from_square["col"] + col_delta}
        if not is_on_board(capture):
            continue

        occupant = board[capture["row"]][capture["col"]]
        if occupant is not None and occupant["color"] != color:
            targets.append(capture)

    return targets


def get_sliding_targets(board, from_square, directions):
    piece = board[from_square["row"]][from_square["col"]]
    targets = []

    for direction in directions:
        row = from_square["row"] + direction["row"]
        col = from_square["col"] + direction["col"]

        while is_on_board({"row": row, "col": col}):
            occupant = board[row][col]
            if occupant is None:
                targets.append({"row": row, "col": col})
                row += direction["row"]
                col += direction["col"]
                continue

            if occupant["color"] != piece["color"]:
                targets.append({"row": row, "col": col})
            break

    return targets


def get_jump_targets(board, from_square, deltas):
    piece = board[from_square["row"]][from_square["col"]]
    targets = []

    for delta in deltas:
        square = {"row": from_square["row"] + delta["row"], "col": from_square["col"] + delta["col"]}
        if not is_on_board(square):
            continue

        occupant = board[square["row"]][square["col"]]
        if occupant is None or occupant["color"] != piece["color"]:
            targets.append(square)

    return targets


def get_piece_targets(board, from_square):
    piece = board[from_square["row"]][from_square["col"]]
    if piece is None:
        return []

    if piece["type"] == "pawn":
        return get_pawn_targets(board, from_square, piece["color"])
    if piece["type"] == "rook":
        return get_sliding_targets(board, from_square, [
            {"row": -1, "col": 0},
            {"row": 1, "col": 0},
            {"row": 0, "col": -1},
            {"row": 0, "col": 1},
        ])
    if piece["type"] == "bishop":
        return get_sliding_targets(board, from_square, [
            {"row": -1, "col": -1},
            {"row": -1, "col": 1},
            {"row": 1, "col": -1},
            {"row": 1, "col": 1},
        ])
    if piece["type"] == "queen":
        return get_sliding_targets(board, from_square, [
            {"row": -1, "col": 0},
            {"row": 1, "col": 0},
            {"row": 0, "col": -1},
            {"row": 0, "col": 1},
            {"row": -1, "col": -1},
            {"row": -1, "col": 1},
            {"row": 1, "col": -1},
            {"row": 1, "col": 1},
        ])
    if piece["type"] == "knight":
        return get_jump_targets(board, from_square, [
            {"row": -2, "col": -1},
            {"row": -2, "col": 1},
            {"row": -1, "col": -2},
            {"row": -1, "col": 2},
            {"row": 1, "col": -2},
            {"row": 1, "col": 2},
            {"row": 2, "col": -1},
            {"row": 2, "col": 1},
        ])
    if piece["type"] == "king":
        return get_jump_targets(board, from_square, [
            {"row": -1, "col": -1},
            {"row": -1, "col": 0},
            {"row": -1, "col": 1},
            {"row": 0, "col": -1},
            {"row": 0, "col": 1},
            {"row": 1, "col": -1},
            {"row": 1, "col": 0},
            {"row": 1, "col": 1},
        ])

    return []


def get_all_moves(board, color):
    moves = []
    for row in range(8):
        for col in range(8):
            piece = board[row][col]
            if piece is None or piece["color"] != color:
                continue

            from_square = {"row": row, "col": col}
            for to_square in get_piece_targets(board, from_square):
                moves.append({"from": from_square, "to": to_square})

    return moves


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"ok")
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path != "/move":
            self.send_response(404)
            self.end_headers()
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length).decode("utf-8")
        payload = json.loads(raw_body)
        board = deserialize_board(payload["board"])
        color = payload["turn"]
        moves = get_all_moves(board, color)

        if not moves:
            move_text = "A1,A1"
        else:
            move = random.choice(moves)
            move_text = f"{coordinate_to_notation(move['from'])},{coordinate_to_notation(move['to'])}"

        encoded = move_text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format, *args):
        return


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Example Python player listening on port {PORT}")
    server.serve_forever()
