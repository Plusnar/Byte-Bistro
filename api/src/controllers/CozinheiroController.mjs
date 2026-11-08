import { Cozinheiro } from "../models/Cozinheiro.mjs";
import { slugify } from "../models/ValidationError.mjs";
import { HttpError, notFound } from "../http.mjs";

/**
 * Controller dos cozinheiros: recebe a requisição, valida com o Model e usa o DAO.
 * Não conhece SQL nem HTTP cru — só o que entra (params, query, body) e o que sai.
 */
export class CozinheiroController {
  /** @param {import("../dao/CozinheiroDAO.mjs").CozinheiroDAO} dao @param {import("../dao/PartidaDAO.mjs").PartidaDAO} partidas */
  constructor(dao, partidas, now = () => new Date().toISOString()) {
    this.dao = dao;
    this.partidas = partidas;
    this.now = now;
  }

  list({ query }) {
    const ativo = query.ativo === undefined ? undefined : query.ativo === "true";
    return { status: 200, body: this.dao.findAll({ ativo }) };
  }

  get({ params }) {
    const cozinheiro = this.dao.findById(params.id);
    if (!cozinheiro) throw notFound("cozinheiro");
    return { status: 200, body: cozinheiro };
  }

  create({ body }) {
    Cozinheiro.validate(body, { withId: true });
    const id = body.id ? slugify(body.id) : slugify(body.nome);
    if (this.dao.findById(id)) throw new HttpError(409, `já existe um cozinheiro com id "${id}"`);
    const now = this.now();
    const created = this.dao.insert(new Cozinheiro({ ...body, id, criadoEm: now, atualizadoEm: now }));
    return { status: 201, body: created, location: `/api/cozinheiros/${id}` };
  }

  /** PUT: substitui todos os campos editáveis. */
  replace({ params, body }) {
    const current = this.dao.findById(params.id);
    if (!current) throw notFound("cozinheiro");
    Cozinheiro.validate(body);
    const updated = this.dao.update(new Cozinheiro({
      ativo: true,
      ...body,
      id: current.id,
      criadoEm: current.criadoEm,
      atualizadoEm: this.now(),
    }));
    return { status: 200, body: updated };
  }

  /** PATCH: altera só os campos enviados. */
  patch({ params, body }) {
    const current = this.dao.findById(params.id);
    if (!current) throw notFound("cozinheiro");
    Cozinheiro.validate(body, { partial: true });
    const updated = this.dao.update(new Cozinheiro({ ...current, ...body, atualizadoEm: this.now() }));
    return { status: 200, body: updated };
  }

  remove({ params }) {
    if (!this.dao.findById(params.id)) throw notFound("cozinheiro");
    // Um cozinheiro com partidas no ranking não some: desative-o com PATCH { "ativo": false }.
    if (this.partidas.findAll({ cozinheiro: params.id, limite: 1 }).length > 0) {
      throw new HttpError(409, 'este cozinheiro tem partidas no ranking; desative-o com PATCH { "ativo": false }');
    }
    this.dao.delete(params.id);
    return { status: 204 };
  }
}
