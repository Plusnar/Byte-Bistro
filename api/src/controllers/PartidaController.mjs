import { Partida } from "../models/Partida.mjs";
import { HttpError, notFound } from "../http.mjs";

/** Controller das partidas (ranking). Confere se a fase e os cozinheiros existem antes de gravar. */
export class PartidaController {
  /**
   * @param {import("../dao/PartidaDAO.mjs").PartidaDAO} dao
   * @param {import("../dao/FaseDAO.mjs").FaseDAO} fases
   * @param {import("../dao/CozinheiroDAO.mjs").CozinheiroDAO} cozinheiros
   */
  constructor(dao, fases, cozinheiros, now = () => new Date().toISOString()) {
    this.dao = dao;
    this.fases = fases;
    this.cozinheiros = cozinheiros;
    this.now = now;
  }

  list({ query }) {
    if (query.ordem && !["pontos", "recentes"].includes(query.ordem)) {
      throw new HttpError(400, '"ordem" deve ser "pontos" ou "recentes"');
    }
    const limite = query.limite === undefined ? 50 : Number(query.limite);
    if (!Number.isInteger(limite) || limite < 1 || limite > 500) throw new HttpError(400, '"limite" deve ser um inteiro entre 1 e 500');
    const partidas = this.dao.findAll({ faseId: query.faseId, cozinheiro: query.cozinheiro, ordem: query.ordem, limite });
    return { status: 200, body: partidas };
  }

  get({ params }) {
    const partida = this.dao.findById(this.id(params.id));
    if (!partida) throw notFound("partida");
    return { status: 200, body: partida };
  }

  create({ body }) {
    Partida.validate(body);
    this.checkReferences(body);
    const created = this.dao.insert(new Partida({ ...body, jogadaEm: this.now() }));
    return { status: 201, body: created, location: `/api/partidas/${created.id}` };
  }

  replace({ params, body }) {
    const current = this.dao.findById(this.id(params.id));
    if (!current) throw notFound("partida");
    Partida.validate(body);
    this.checkReferences(body);
    const updated = this.dao.update(new Partida({
      pedidosEntregues: 0,
      pedidosPerdidos: 0,
      ...body,
      id: current.id,
      jogadaEm: current.jogadaEm,
    }));
    return { status: 200, body: updated };
  }

  patch({ params, body }) {
    const current = this.dao.findById(this.id(params.id));
    if (!current) throw notFound("partida");
    Partida.validate(body, { partial: true });
    const merged = { ...current, ...body };
    this.checkReferences(merged);
    return { status: 200, body: this.dao.update(new Partida(merged)) };
  }

  remove({ params }) {
    if (!this.dao.delete(this.id(params.id))) throw notFound("partida");
    return { status: 204 };
  }

  /** Ids de partida são números; qualquer outra coisa é um 404, não um erro do banco. */
  id(raw) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 1) throw notFound("partida");
    return id;
  }

  checkReferences({ faseId, cozinheiros }) {
    if (!this.fases.findById(faseId)) throw new HttpError(400, `a fase "${faseId}" não existe`);
    for (const id of cozinheiros) {
      if (!this.cozinheiros.findById(id)) throw new HttpError(400, `o cozinheiro "${id}" não existe`);
    }
  }
}
