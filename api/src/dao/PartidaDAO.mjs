import { Partida } from "../models/Partida.mjs";

const ORDERS = {
  pontos: "pontos DESC, jogada_em ASC",
  recentes: "jogada_em DESC, id DESC",
};

/** A data em que a partida foi jogada nunca muda depois de gravada. */
const withoutPlayedAt = ({ jogada_em: _ignored, ...row }) => row;

/** DAO das partidas (ranking): todo o SQL da tabela `partidas` fica aqui. */
export class PartidaDAO {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * @param {{ faseId?: string, cozinheiro?: string, ordem?: "pontos" | "recentes", limite?: number }} filtros
   */
  findAll({ faseId, cozinheiro, ordem = "pontos", limite = 50 } = {}) {
    const where = [];
    const params = { limite };
    if (faseId) {
      where.push("fase_id = :faseId");
      params.faseId = faseId;
    }
    if (cozinheiro) {
      // `cozinheiros` é uma lista JSON; json_each a abre em linhas.
      where.push("EXISTS (SELECT 1 FROM json_each(partidas.cozinheiros) WHERE value = :cozinheiro)");
      params.cozinheiro = cozinheiro;
    }
    const sql = `SELECT * FROM partidas ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY ${ORDERS[ordem] ?? ORDERS.pontos} LIMIT :limite`;
    return this.db.prepare(sql).all(params).map(Partida.fromRow);
  }

  /** @returns {Partida | null} */
  findById(id) {
    const row = this.db.prepare("SELECT * FROM partidas WHERE id = ?").get(id);
    return row ? Partida.fromRow(row) : null;
  }

  /** @param {Partida} partida @returns {Partida} com o id gerado pelo banco */
  insert(partida) {
    const result = this.db.prepare(`
      INSERT INTO partidas (fase_id, cozinheiros, pontos, pedidos_entregues, pedidos_perdidos, rank, jogada_em)
      VALUES (:fase_id, :cozinheiros, :pontos, :pedidos_entregues, :pedidos_perdidos, :rank, :jogada_em)
    `).run(partida.toRow());
    return this.findById(Number(result.lastInsertRowid));
  }

  /** @param {Partida} partida */
  update(partida) {
    const result = this.db.prepare(`
      UPDATE partidas
         SET fase_id = :fase_id, cozinheiros = :cozinheiros, pontos = :pontos, pedidos_entregues = :pedidos_entregues,
             pedidos_perdidos = :pedidos_perdidos, rank = :rank
       WHERE id = :id
    `).run(withoutPlayedAt({ ...partida.toRow(), id: partida.id }));
    return result.changes > 0 ? this.findById(partida.id) : null;
  }

  delete(id) {
    return this.db.prepare("DELETE FROM partidas WHERE id = ?").run(id).changes > 0;
  }

  count() {
    return this.db.prepare("SELECT COUNT(*) AS total FROM partidas").get().total;
  }
}
