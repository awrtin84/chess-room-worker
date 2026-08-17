import { Chess } from "chess.js";

export class GameRoom {
    constructor(state, env) {
        this.state = state;
        this.sessions = new Map();
        this.game = new Chess();
        this.moveHistory = [];
        this.hostConnected = false;
        this.guestConnected = false;
        this.pendingUndo = null;
        this.pendingRematch = null;

        this.state.blockConcurrencyWhile(async () => {
            const savedHistory = await this.state.storage.get("moveHistory");
            if (savedHistory && savedHistory.length > 0) {
                const replay = new Chess();
                for (const san of savedHistory) {
                    try {
                        replay.move(san);
                    } catch (e) {
                        break;
                    }
                }
                this.game = replay;
                this.moveHistory = savedHistory;
            }
        });
    }

    async fetch(request) {
        const upgradeHeader = request.headers.get("Upgrade");
        if (upgradeHeader !== "websocket") {
            return new Response("Expected WebSocket", { status: 426 });
        }

        const url = new URL(request.url);
        const role = url.searchParams.get("role") === "host" ? "host" : "guest";

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        server.accept();
        this.handleSession(server, role);

        return new Response(null, { status: 101, webSocket: client });
    }

    handleSession(ws, role) {
        if (role === "host") {
            if (this.hostConnected) {
                ws.send(
                    JSON.stringify({
                        type: "error",
                        message: "Host slot already taken",
                    }),
                );
                ws.close();
                return;
            }
            this.hostConnected = true;
        } else {
            if (this.guestConnected) {
                ws.send(
                    JSON.stringify({
                        type: "error",
                        message: "Guest slot already taken",
                    }),
                );
                ws.close();
                return;
            }
            this.guestConnected = true;
        }

        this.sessions.set(ws, { role, color: role === "host" ? "w" : "b" });

        ws.send(
            JSON.stringify({
                type: "init",
                color: role === "host" ? "w" : "b",
                fen: this.game.fen(),
                moveHistory: this.moveHistory,
                bothConnected: this.hostConnected && this.guestConnected,
            }),
        );

        this.broadcast(
            {
                type: "presence",
                bothConnected: this.hostConnected && this.guestConnected,
            },
            ws,
        );

        ws.addEventListener("message", (event) =>
            this.handleMessage(ws, event),
        );
        ws.addEventListener("close", () => this.handleClose(ws));
    }

    async persistState() {
        await this.state.storage.put("moveHistory", this.moveHistory);
    }

    async handleMessage(ws, event) {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            return;
        }

        const session = this.sessions.get(ws);
        if (!session) return;

        if (data.type === "move") {
            if (this.game.turn() !== session.color) return;

            let move;
            try {
                move = this.game.move({
                    from: data.from,
                    to: data.to,
                    promotion: data.promotion || "q",
                });
            } catch (e) {
                move = null;
            }

            if (!move) {
                ws.send(
                    JSON.stringify({ type: "error", message: "Illegal move" }),
                );
                return;
            }

            this.moveHistory.push(move.san);
            this.pendingUndo = null;
            this.pendingRematch = null;
            await this.persistState();

            this.broadcast(
                {
                    type: "move",
                    from: move.from,
                    to: move.to,
                    promotion: move.promotion || null,
                    piece: move.piece,
                    color: move.color,
                    fen: this.game.fen(),
                    moveHistory: this.moveHistory,
                },
                null,
            );
            return;
        }

        if (data.type === "undo_request") {
            if (this.moveHistory.length === 0) return;
            const lastMoverColor = this.game.turn() === "w" ? "b" : "w";
            if (lastMoverColor !== session.color) return;
            if (this.pendingUndo) return;

            this.pendingUndo = { requesterRole: session.role };
            this.broadcast({ type: "undo_request", from: session.role }, ws);
            return;
        }

        if (data.type === "undo_response") {
            if (
                !this.pendingUndo ||
                session.role === this.pendingUndo.requesterRole
            )
                return;

            if (data.accept) {
                this.game.undo();
                this.moveHistory.pop();
                await this.persistState();
            }

            this.pendingUndo = null;
            this.broadcast(
                {
                    type: "undo_result",
                    accepted: !!data.accept,
                    fen: this.game.fen(),
                    moveHistory: this.moveHistory,
                },
                null,
            );
            return;
        }

        if (data.type === "rematch_request") {
            if (this.pendingRematch) return;
            this.pendingRematch = { requesterRole: session.role };
            this.broadcast({ type: "rematch_request", from: session.role }, ws);
            return;
        }

        if (data.type === "rematch_response") {
            if (
                !this.pendingRematch ||
                session.role === this.pendingRematch.requesterRole
            )
                return;

            if (data.accept) {
                this.game = new Chess();
                this.moveHistory = [];
                await this.persistState();
            }

            this.pendingRematch = null;
            this.broadcast(
                {
                    type: "rematch_result",
                    accepted: !!data.accept,
                    fen: this.game.fen(),
                    moveHistory: this.moveHistory,
                },
                null,
            );
            return;
        }

        if (data.type === "reaction") {
            if (typeof data.emoji !== "string" || data.emoji.length > 8) return;
            this.broadcast({ type: "reaction", emoji: data.emoji }, ws);
            return;
        }
    }

    handleClose(ws) {
        const session = this.sessions.get(ws);
        if (session?.role === "host") this.hostConnected = false;
        if (session?.role === "guest") this.guestConnected = false;
        this.sessions.delete(ws);
        this.broadcast(
            {
                type: "presence",
                bothConnected: this.hostConnected && this.guestConnected,
            },
            ws,
        );
    }

    broadcast(message, exclude) {
        const payload = JSON.stringify(message);
        for (const ws of this.sessions.keys()) {
            if (ws === exclude) continue;
            try {
                ws.send(payload);
            } catch (e) {
                // dead connection, cleaned up on close event
            }
        }
    }
}
