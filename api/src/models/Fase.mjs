import { ValidationError, check } from "./ValidationError.mjs";

export const DIFICULDADES = ["relaxed", "standard", "intense"];
const EDITABLE = ["nome", "descricao", "cenario", "duracaoSegundos", "dificuldade", "objetos"];

/**
 * Model: uma fase (mapa) do jogo — o mesmo conteúdo que o modo construção exporta em JSON.
 * `objetos` é a lista de peças do mapa (paredes, bancadas, decoração...).
 */
export class Fase {
  constructor({ id, nome, descricao = "", cenario = "wedding", duracaoSegundos, dificuldade, objetos = [], criadoEm, atualizadoEm }) {
    this.id = id;
    this.nome = nome;
    this.descricao = descricao;
    this.cenario = cenario;
    this.duracaoSegundos = duracaoSegundos;
    this.dificuldade = dificuldade;
    this.objetos = objetos;
    this.criadoEm = criadoEm;
    this.atualizadoEm = atualizadoEm;
  }

  static validate(body, { partial = false, withId = false } = {}) {
    const problems = [];
    const required = !partial;
    check.onlyKnown(problems, body, withId ? ["id", ...EDITABLE] : EDITABLE);
    if (withId) check.text(problems, body, "id", { required: false, max: 60 });
    check.text(problems, body, "nome", { required, max: 80 });
    if (body.descricao !== undefined && typeof body.descricao !== "string") problems.push('"descricao" deve ser um texto');
    check.text(problems, body, "cenario", { required: false, max: 40 });
    check.integer(problems, body, "duracaoSegundos", { required, min: 60, max: 900 });
    check.oneOf(problems, body, "dificuldade", DIFICULDADES, { required });
    if (body.objetos !== undefined) {
      if (!Array.isArray(body.objetos)) problems.push('"objetos" deve ser uma lista');
      else if (body.objetos.length > 3000) problems.push('"objetos" aceita no máximo 3000 peças');
      else if (body.objetos.some((item) => typeof item !== "object" || item === null || typeof item.assetId !== "string")) {
        problems.push('cada item de "objetos" precisa de um "assetId" (texto)');
      }
    }
    if (partial && Object.keys(body).length === 0) problems.push("envie ao menos um campo para alterar");
    if (problems.length) throw new ValidationError(problems);
  }

  static fromRow(row) {
    return new Fase({
      id: row.id,
      nome: row.nome,
      descricao: row.descricao,
      cenario: row.cenario,
      duracaoSegundos: row.duracao_segundos,
      dificuldade: row.dificuldade,
      objetos: JSON.parse(row.objetos),
      criadoEm: row.criado_em,
      atualizadoEm: row.atualizado_em,
    });
  }

  toRow() {
    return {
      id: this.id,
      nome: this.nome,
      descricao: this.descricao,
      cenario: this.cenario,
      duracao_segundos: this.duracaoSegundos,
      dificuldade: this.dificuldade,
      objetos: JSON.stringify(this.objetos),
      criado_em: this.criadoEm,
      atualizado_em: this.atualizadoEm,
    };
  }

  /** Versão curta para listagens: sem a lista completa de peças, só a contagem. */
  toSummary() {
    const { objetos, ...rest } = this;
    return { ...rest, totalObjetos: objetos.length };
  }
}
