// Peças HTTP compartilhadas: erros com status, leitura do corpo JSON e um roteador mínimo.
import { ValidationError } from "./models/ValidationError.mjs";

export class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const notFound = (what) => new HttpError(404, `${what} não encontrado(a)`);

/** Maior corpo aceito: uma fase grande tem algumas centenas de KB. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Lê o corpo da requisição como JSON (objeto). */
export async function readJson(req) {
  if (!["POST", "PUT", "PATCH"].includes(req.method)) return undefined;
  const type = req.headers["content-type"] ?? "";
  if (!type.includes("application/json")) throw new HttpError(415, 'envie o corpo como JSON ("Content-Type: application/json")');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "corpo da requisição grande demais (máx. 2 MB)");
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
  } catch {
    throw new HttpError(400, "JSON inválido");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "o corpo deve ser um objeto JSON");
  return body;
}

/**
 * Roteador: cada rota é [método, padrão, handler]. Padrões como "/api/fases/:id".
 * O handler recebe { params, query, body } e devolve { status, body }.
 */
export class Router {
  constructor() {
    /** @type {{ method: string, regex: RegExp, keys: string[], handler: Function }[]} */
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return "([^/]+)";
    })}/?$`);
    this.routes.push({ method, regex, keys, handler });
    return this;
  }

  /** Encontra a rota; devolve { handler, params } ou, se o caminho existe com outro método, os métodos aceitos. */
  match(method, path) {
    const allowed = [];
    for (const route of this.routes) {
      const found = route.regex.exec(path);
      if (!found) continue;
      if (route.method !== method) {
        allowed.push(route.method);
        continue;
      }
      const params = Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(found[index + 1])]));
      return { handler: route.handler, params };
    }
    return { allowed };
  }
}

/** Converte qualquer erro numa resposta JSON com o status certo. */
export function errorResponse(error) {
  if (error instanceof ValidationError) return { status: 400, body: { erro: "dados inválidos", detalhes: error.problems } };
  if (error instanceof HttpError) return { status: error.status, body: { erro: error.message } };
  console.error(error);
  return { status: 500, body: { erro: "erro interno do servidor" } };
}
