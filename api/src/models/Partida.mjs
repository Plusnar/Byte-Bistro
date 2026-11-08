import { ValidationError, check } from "./ValidationError.mjs";

export const RANKS = ["S", "A", "B", "C", "D"];
const EDITABLE = ["faseId", "cozinheiros", "pontos", "pedidosEntregues", "pedidosPerdidos", "rank"];

/**
 * Model: o resultado de uma partida jogada (entra no ranking da fase).
 * `cozinheiros` traz os ids dos dois cozinheiros que jogaram juntos.
 */
export class Partida {
  constructor({ id, faseId, cozinheiros, pontos, pedidosEntregues = 0, pedidosPerdidos = 0, rank, jogadaEm }) {
    this.id = id;
    this.faseId = faseId;
    this.cozinheiros = cozinheiros;
    this.pontos = pontos;
    this.pedidosEntregues = pedidosEntregues;
    this.pedidosPerdidos = pedidosPerdidos;
    this.rank = rank;
    this.jogadaEm = jogadaEm;
  }

  static validate(body, { partial = false } = {}) {
    const problems = [];
    const required = !partial;
    check.onlyKnown(problems, body, EDITABLE);
    check.text(problems, body, "faseId", { required, max: 60 });
    if (body.cozinheiros !== undefined || required) {
      const list = body.cozinheiros;
      if (!Array.isArray(list) || list.length < 1 || list.length > 2 || list.some((id) => typeof id !== "string")) {
        problems.push('"cozinheiros" deve ser uma lista com 1 ou 2 ids de cozinheiro');
      }
    }
    check.integer(problems, body, "pontos", { required, min: 0 });
    check.integer(problems, body, "pedidosEntregues", { required: false, min: 0 });
    check.integer(problems, body, "pedidosPerdidos", { required: false, min: 0 });
    check.oneOf(problems, body, "rank", RANKS, { required });
    if (partial && Object.keys(body).length === 0) problems.push("envie ao menos um campo para alterar");
    if (problems.length) throw new ValidationError(problems);
  }

  static fromRow(row) {
    return new Partida({
      id: row.id,
      faseId: row.fase_id,
      cozinheiros: JSON.parse(row.cozinheiros),
      pontos: row.pontos,
      pedidosEntregues: row.pedidos_entregues,
      pedidosPerdidos: row.pedidos_perdidos,
      rank: row.rank,
      jogadaEm: row.jogada_em,
    });
  }

  toRow() {
    return {
      fase_id: this.faseId,
      cozinheiros: JSON.stringify(this.cozinheiros),
      pontos: this.pontos,
      pedidos_entregues: this.pedidosEntregues,
      pedidos_perdidos: this.pedidosPerdidos,
      rank: this.rank,
      jogada_em: this.jogadaEm,
    };
  }
}
