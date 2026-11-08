import { Cozinheiro } from "../models/Cozinheiro.mjs";

/**
 * DAO (Data Access Object) dos cozinheiros: todo o SQL da tabela `cozinheiros` fica aqui.
 * Recebe e devolve Models (`Cozinheiro`), nunca linhas cruas do banco.
 */
export class CozinheiroDAO {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }

  /** @param {{ ativo?: boolean }} filtros */
  findAll({ ativo } = {}) {
    const rows = ativo === undefined
      ? this.db.prepare("SELECT * FROM cozinheiros ORDER BY nome").all()
      : this.db.prepare("SELECT * FROM cozinheiros WHERE ativo = ? ORDER BY nome").all(ativo ? 1 : 0);
    return rows.map(Cozinheiro.fromRow);
  }

  /** @returns {Cozinheiro | null} */
  findById(id) {
    const row = this.db.prepare("SELECT * FROM cozinheiros WHERE id = ?").get(id);
    return row ? Cozinheiro.fromRow(row) : null;
  }

  /** @param {Cozinheiro} cozinheiro */
  insert(cozinheiro) {
    this.db.prepare(`
      INSERT INTO cozinheiros (id, nome, funcao, modelo, ativo, criado_em, atualizado_em)
      VALUES (:id, :nome, :funcao, :modelo, :ativo, :criado_em, :atualizado_em)
    `).run(cozinheiro.toRow());
    return this.findById(cozinheiro.id);
  }

  /** Grava todos os campos editáveis de `cozinheiro` (usado pelo PUT e pelo PATCH). */
  update(cozinheiro) {
    const { criado_em: _ignored, ...row } = cozinheiro.toRow();
    const result = this.db.prepare(`
      UPDATE cozinheiros
         SET nome = :nome, funcao = :funcao, modelo = :modelo, ativo = :ativo, atualizado_em = :atualizado_em
       WHERE id = :id
    `).run(row);
    return result.changes > 0 ? this.findById(cozinheiro.id) : null;
  }

  /** @returns {boolean} se havia um cozinheiro com esse id */
  delete(id) {
    return this.db.prepare("DELETE FROM cozinheiros WHERE id = ?").run(id).changes > 0;
  }

  count() {
    return this.db.prepare("SELECT COUNT(*) AS total FROM cozinheiros").get().total;
  }
}
