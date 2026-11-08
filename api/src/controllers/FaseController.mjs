import { DIFICULDADES, Fase } from "../models/Fase.mjs";
import { slugify } from "../models/ValidationError.mjs";
import { HttpError, notFound } from "../http.mjs";

/** Controller das fases (mapas). */
export class FaseController {
  /** @param {import("../dao/FaseDAO.mjs").FaseDAO} dao */
  constructor(dao, now = () => new Date().toISOString()) {
    this.dao = dao;
    this.now = now;
  }

  /** Lista sem as peças do mapa (só a contagem); a fase inteira vem no GET por id. */
  list({ query }) {
    if (query.dificuldade && !DIFICULDADES.includes(query.dificuldade)) {
      throw new HttpError(400, `"dificuldade" deve ser um destes: ${DIFICULDADES.join(", ")}`);
    }
    const fases = this.dao.findAll({ dificuldade: query.dificuldade, busca: query.busca });
    return { status: 200, body: fases.map((fase) => fase.toSummary()) };
  }

  get({ params }) {
    const fase = this.dao.findById(params.id);
    if (!fase) throw notFound("fase");
    return { status: 200, body: fase };
  }

  create({ body }) {
    Fase.validate(body, { withId: true });
    const id = body.id ? slugify(body.id) : slugify(body.nome);
    if (this.dao.findById(id)) throw new HttpError(409, `já existe uma fase com id "${id}"`);
    const now = this.now();
    const created = this.dao.insert(new Fase({ ...body, id, criadoEm: now, atualizadoEm: now }));
    return { status: 201, body: created, location: `/api/fases/${id}` };
  }

  replace({ params, body }) {
    const current = this.dao.findById(params.id);
    if (!current) throw notFound("fase");
    Fase.validate(body);
    const updated = this.dao.update(new Fase({
      descricao: "",
      cenario: "wedding",
      objetos: [],
      ...body,
      id: current.id,
      criadoEm: current.criadoEm,
      atualizadoEm: this.now(),
    }));
    return { status: 200, body: updated };
  }

  patch({ params, body }) {
    const current = this.dao.findById(params.id);
    if (!current) throw notFound("fase");
    Fase.validate(body, { partial: true });
    const updated = this.dao.update(new Fase({ ...current, ...body, atualizadoEm: this.now() }));
    return { status: 200, body: updated };
  }

  /** Apaga a fase e o ranking dela (as partidas saem em cascata). */
  remove({ params }) {
    if (!this.dao.delete(params.id)) throw notFound("fase");
    return { status: 204 };
  }
}
