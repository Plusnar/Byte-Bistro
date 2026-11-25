/**
 * Byte Bistro accounts, as a standalone Worker for local development (`npm run accounts:dev`,
 * with a local D1). In production the same router runs as the Pages Function
 * `functions/api/auth/[[path]].ts`, bound to the D1 database on the Pages project.
 */
import { handleAccounts, type AccountsEnv } from "./router";

export default {
  async fetch(request: Request, env: AccountsEnv): Promise<Response> {
    const response = await handleAccounts(request, env);
    return response ?? new Response("Byte Bistro accounts", { status: 404 });
  },
} satisfies ExportedHandler<AccountsEnv>;
