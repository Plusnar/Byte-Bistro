// Pages Function for `/api/mp/*`: the multiplayer API on the game's own origin.
//
// Pages cannot define Durable Objects, so this forwards to the classes of the separate
// `byte-bistro-mp` Worker through two Durable Object bindings set on the Pages project
// (Settings → Bindings → Durable Object): ROOMS → RoomDO and QUOTA → QuotaDO, both from
// the byte-bistro-mp Worker. Without them the API answers 503 `not-configured` and the
// game keeps working with local controls only. See docs/MULTIPLAYER.md.
import { handleMultiplayer, type RouterEnv } from "../../../workers/mp/src/router";

export const onRequest = async (context: { request: Request; env: Partial<RouterEnv> }): Promise<Response> => {
  const response = await handleMultiplayer(context.request, context.env as RouterEnv);
  return response ?? new Response("Not found", { status: 404 });
};
