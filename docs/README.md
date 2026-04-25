# Chess Orchestrator

This project contains:

- `index.ts`: the chess state orchestrator
- `example.ts`: a simple TypeScript player server
- `example.py`: a simple Python player server

## Run

Start the orchestrator:

```bash
bun index.ts
```

Start the TypeScript example player:

```bash
PORT=4001 bun example.ts
```

Start the Python example player:

```bash
PORT=4002 python example.py
```

The orchestrator listens on port `3000` by default.

## Player Registration

Register a player with its host, port, and base path:

```bash
curl -X POST http://localhost:3000/players/register \
  -H "Content-Type: application/json" \
  -d '{
    "address": "127.0.0.1",
    "port": 4001,
    "path": "/"
  }'
```

Response:

```json
{
  "playerId": "uuid",
  "player": {
    "id": "uuid",
    "address": "127.0.0.1",
    "port": 4001,
    "path": "/",
    "registeredAt": "2026-04-25T23:00:00.000Z"
  }
}
```

`playerId` is used later if you want to force a specific player to be white.

## Start A Game

Start a game after at least two players have registered:

```bash
curl -X POST "http://localhost:3000/games/start?start_time=5&round_additional_seconds=2"
```

To force white:

```bash
curl -X POST "http://localhost:3000/games/start?start_time=5&round_additional_seconds=2&white=<playerId>"
```

Query parameters:

- `start_time=MM`: starting time in minutes for each player
- `round_additional_seconds=SS`: per-turn increment in seconds
- `white=<playerId>`: optional registered player id to assign white

Response:

```json
{
  "gameId": "uuid",
  "whitePlayerId": "uuid",
  "blackPlayerId": "uuid",
  "startTimeMinutes": 5,
  "roundAdditionalSeconds": 2,
  "status": "active"
}
```

## Player Move Contract

For each turn, the orchestrator sends a `POST` request to:

```text
http://<address>:<port><path>/move
```

If the registered path is `/`, the move endpoint becomes `/move`.

Request body shape:

```json
{
  "gameId": "uuid",
  "turn": "white",
  "playerId": "uuid",
  "whitePlayerId": "uuid",
  "blackPlayerId": "uuid",
  "moveIndex": 1,
  "startTimeMinutes": 5,
  "roundAdditionalSeconds": 2,
  "remainingTimeSeconds": {
    "white": 300,
    "black": 300
  },
  "lastError": null,
  "moves": [],
  "board": [
    ["bR", "bN", "bB", "bQ", "bK", "bB", "bN", "bR"],
    ["bP", "bP", "bP", "bP", "bP", "bP", "bP", "bP"],
    ["", "", "", "", "", "", "", ""],
    ["", "", "", "", "", "", "", ""],
    ["", "", "", "", "", "", "", ""],
    ["", "", "", "", "", "", "", ""],
    ["wP", "wP", "wP", "wP", "wP", "wP", "wP", "wP"],
    ["wR", "wN", "wB", "wQ", "wK", "wB", "wN", "wR"]
  ]
}
```

The player must return plain text in this format:

```text
E2,E4
```

If the move is invalid, the orchestrator asks again and sets `lastError` to a message beginning with `Bad move`.

## Timing Rules

- The clock starts when the orchestrator sends the move request.
- The clock stops when a valid move is received.
- The orchestrator subtracts `turn_time - round_additional_seconds` from that player's remaining time.
- If a player's remaining time reaches `0`, the other player wins on time.

## Logs And Game Files

Each game is written to:

```text
games/<gameId>.txt
```

The file contains:

- a game start line
- one line per accepted move
- a winner or draw line when the game ends

The orchestrator also exposes:

- `GET /players`: list registered players
- `GET /games/<gameId>`: current game state

## Example Flow

1. Start `example.ts` on port `4001`.
2. Start `example.py` on port `4002`.
3. Register both players with `POST /players/register`.
4. Start a game with `POST /games/start?...`.
5. Inspect the result with `GET /games/<gameId>` or open `games/<gameId>.txt`.
