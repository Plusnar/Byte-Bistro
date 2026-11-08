// Monta a API: banco → DAOs → controllers → rotas. Devolve o handler do node:http.
import { CozinheiroDAO } from "./dao/CozinheiroDAO.mjs";
import { FaseDAO } from "./dao/FaseDAO.mjs";
import { PartidaDAO } from "./dao/PartidaDAO.mjs";
import { CozinheiroController } from "./controllers/CozinheiroController.mjs";
import { FaseController } from "./controllers/FaseController.mjs";
import { PartidaController } from "./controllers/PartidaController.mjs";
import { HttpError, Router, errorResponse, readJson } from "./http.mjs";

export const API_VERSION = "1.0.0";

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ now?: () => string }} options
 */
export function createApp(db, { now } = {}) {
  const cozinheiroDAO = new CozinheiroDAO(db);
  const faseDAO = new FaseDAO(db);
  const partidaDAO = new PartidaDAO(db);

  const cozinheiros = new CozinheiroController(cozinheiroDAO, partidaDAO, now);
  const fases = new FaseController(faseDAO, now);
  const partidas = new PartidaController(partidaDAO, faseDAO, cozinheiroDAO, now);

  const router = new Router();
  router.add("GET", "/api", () => ({
    status: 200,
    body: {
      nome: "API Byte Bistro",
      versao: API_VERSION,
      recursos: ["/api/cozinheiros", "/api/fases", "/api/partidas"],
      metodos: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    },
  }));
  router.add("GET", "/api/saude", () => ({
    status: 200,
    body: { status: "ok", cozinheiros: cozinheiroDAO.count(), fases: faseDAO.count(), partidas: partidaDAO.count() },
  }));

  for (const [path, controller] of [["cozinheiros", cozinheiros], ["fases", fases], ["partidas", partidas]]) {
    router
      .add("GET", `/api/${path}`, (request) => controller.list(request))
      .add("POST", `/api/${path}`, (request) => controller.create(request))
      .add("GET", `/api/${path}/:id`, (request) => controller.get(request))
      .add("PUT", `/api/${path}/:id`, (request) => controller.replace(request))
      .add("PATCH", `/api/${path}/:id`, (request) => controller.patch(request))
      .add("DELETE", `/api/${path}/:id`, (request) => controller.remove(request));
  }

  /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
  return async function handle(req, res) {
    // CORS: o jogo (outro domínio) pode chamar a API pelo navegador.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    let response;
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const found = router.match(req.method ?? "GET", url.pathname);
      if (!found.handler) {
        if (found.allowed.length) {
          res.setHeader("Allow", found.allowed.join(", "));
          throw new HttpError(405, `método ${req.method} não permitido aqui; use ${found.allowed.join(", ")}`);
        }
        throw new HttpError(404, `rota ${url.pathname} não existe; veja GET /api`);
      }
      const body = await readJson(req);
      const query = Object.fromEntries(url.searchParams);
      response = await found.handler({ params: found.params, query, body });
    } catch (error) {
      response = errorResponse(error);
    }

    if (response.location) res.setHeader("Location", response.location);
    if (response.body === undefined) {
      res.writeHead(response.status).end();
      return;
    }
    res.writeHead(response.status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(response.body, null, 2));
  };
}
