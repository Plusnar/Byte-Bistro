import { ValidationError, check } from "./ValidationError.mjs";

const EDITABLE = ["nome", "funcao", "modelo", "ativo"];

/**
 * Model: um cozinheiro jogável (William, Sandy, Milena, Jean...).
 * Só guarda e valida dados; quem lê e grava no banco é o CozinheiroDAO.
 */
export class Cozinheiro {
  /**
   * @param {{ id: string, nome: string, funcao: string, modelo: string, ativo?: boolean,
   *           criadoEm?: string, atualizadoEm?: string }} data
   */
  constructor({ id, nome, funcao, modelo, ativo = true, criadoEm, atualizadoEm }) {
    this.id = id;
    this.nome = nome;
    this.funcao = funcao;
    this.modelo = modelo;
    this.ativo = ativo;
    this.criadoEm = criadoEm;
    this.atualizadoEm = atualizadoEm;
  }

  /**
   * Valida o corpo de uma requisição. `partial` (PATCH) aceita só parte dos campos.
   * @param {Record<string, unknown>} body
   * @param {{ partial?: boolean, withId?: boolean }} options
   */
  static validate(body, { partial = false, withId = false } = {}) {
    const problems = [];
    const required = !partial;
    check.onlyKnown(problems, body, withId ? ["id", ...EDITABLE] : EDITABLE);
    if (withId) check.text(problems, body, "id", { required: false, max: 60 });
    check.text(problems, body, "nome", { required, max: 60 });
    check.text(problems, body, "funcao", { required, max: 80 });
    check.text(problems, body, "modelo", { required, max: 300 });
    check.boolean(problems, body, "ativo", { required: false });
    if (partial && Object.keys(body).length === 0) problems.push("envie ao menos um campo para alterar");
    if (problems.length) throw new ValidationError(problems);
  }

  /** Linha do banco → Model. */
  static fromRow(row) {
    return new Cozinheiro({
      id: row.id,
      nome: row.nome,
      funcao: row.funcao,
      modelo: row.modelo,
      ativo: row.ativo === 1,
      criadoEm: row.criado_em,
      atualizadoEm: row.atualizado_em,
    });
  }

  /** Model → parâmetros nomeados do SQL. */
  toRow() {
    return {
      id: this.id,
      nome: this.nome,
      funcao: this.funcao,
      modelo: this.modelo,
      ativo: this.ativo ? 1 : 0,
      criado_em: this.criadoEm,
      atualizado_em: this.atualizadoEm,
    };
  }
}
