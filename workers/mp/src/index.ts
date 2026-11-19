/**
 * Byte Bistro multiplayer Worker: owns the RoomDO and QuotaDO classes. Pages cannot define
 * Durable Objects, so this Worker is deployed on its own and the Pages project binds to its
 * namespaces (see docs/MULTIPLAYER.md). It can also serve the API directly on workers.dev.
 */
import type { MpEnv } from "./config";
import { handleMultiplayer } from "./router";

export { RoomDO } from "./room";
export { QuotaDO } from "./quota";

export default {
  async fetch(request: Request, env: MpEnv): Promise<Response> {
    const response = await handleMultiplayer(request, env);
    return response ?? new Response("Byte Bistro multiplayer", { status: 404 });
  },
} satisfies ExportedHandler<MpEnv>;
