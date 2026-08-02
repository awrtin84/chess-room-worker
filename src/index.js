import { GameRoom } from "./game-room.js";

export { GameRoom };

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const match = url.pathname.match(/^\/room\/([^/]+)$/);
        if (!match) return new Response("Not found", { status: 404 });

        const roomId = match[1];
        const id = env.GAME_ROOM.idFromName(roomId.toUpperCase());
        const stub = env.GAME_ROOM.get(id);
        return stub.fetch(request);
    },
};
