import { Fase } from "../models/Fase.mjs";

/**
 * DAO das fases: todo o SQL da tabela `fases` fica aqui.
 * As peças do mapa (`objetos`) são guardadas como JSON numa coluna de texto.
 */
export class FaseDAO {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }

  /** @param {{ dificuldade?: string, busca?: string }} filtros */
  findAll({ dificuldade, busca } = {}) {
    const where = [];
    const params = {};
    if (dificuldade) {
      where.push("dificuldade = :dificuldade");
      params.dificuldade = dificuldade;
    }
    if (busca) {
      where.push("(nome LIKE :busca OR descricao LIKE :busca)");
      params.busca = `%${busca}%`;
    }
    const sql = `SELECT * FROM fases ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY nome`;
    return this.db.prepare(sql).all(params).map(Fase.fromRow);
  }

  /** @returns {Fase | null} */
  findById(id) {
    const row = this.db.prepare("SELECT * FROM fases WHERE id = ?").get(id);
    return row ? Fase.fromRow(row) : null;
  }

  /** @param {Fase} fase */
  insert(fase) {
    this.db.prepare(`
      INSERT INTO fases (id, nome, descricao, cenario, duracao_segundos, dificuldade, objetos, criado_em, atualizado_em)
      VALUES (:id, :nome, :descricao, :cenario, :duracao_segundos, :dificuldade, :objetos, :criado_em, :atualizado_em)
    `).run(fase.toRow());
    return this.findById(fase.id);
  }

  /** @param {Fase} fase */
  update(fase) {
    const { criado_em: _ignored, ...row } = fase.toRow();
    const result = this.db.prepare(`
      UPDATE fases
         SET nome = :nome, descricao = :descricao, cenario = :cenario, duracao_segundos = :duracao_segundos,
             dificuldade = :dificuldade, objetos = :objetos, atualizado_em = :atualizado_em
       WHERE id = :id
    `).run(row);
    return result.changes > 0 ? this.findById(fase.id) : null;
  }

  /** Apaga a fase e, em cascata, as partidas jogadas nela. */
  delete(id) {
    return this.db.prepare("DELETE FROM fases WHERE id = ?").run(id).changes > 0;
  }

  count() {
    return this.db.prepare("SELECT COUNT(*) AS total FROM fases").get().total;
  }
}
