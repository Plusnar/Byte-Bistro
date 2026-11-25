// Pages Function for `/api/auth/*`: player accounts on the game's own origin.
//
// Needs a D1 binding on the Pages project (Settings → Bindings → D1 database):
// ACCOUNTS → byte-bistro-accounts. Without it the API answers 503 `not-configured` and
// the game keeps saving progress in the browser only.
import { handleAccounts, type AccountsEnv } from "../../../workers/accounts/src/router";

export const onRequest = async (context: { request: Request; env: AccountsEnv }): Promise<Response> => {
  const response = await handleAccounts(context.request, context.env);
  return response ?? new Response("Not found", { status: 404 });
};
