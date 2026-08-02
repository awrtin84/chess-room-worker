import { Chess } from "chess.js";

export class GameRoom {
    constructor(state, env) {
        this.state = state;
        this.sessions = new Map();
        this.game = new Chess();
        this.hostConnected = false;
        this.guestConnected = false;
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

    handleMessage(ws, event) {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            return;
        }

        if (data.type !== "move") return;

        const session = this.sessions.get(ws);
        if (!session) return;
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
            ws.send(JSON.stringify({ type: "error", message: "Illegal move" }));
            return;
        }

        this.broadcast(
            {
                type: "move",
                from: move.from,
                to: move.to,
                promotion: move.promotion || null,
                piece: move.piece,
                color: move.color,
                fen: this.game.fen(),
            },
            null,
        );
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
