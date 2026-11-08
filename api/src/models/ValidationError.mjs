/** Erro de dados inválidos enviados pelo cliente; vira HTTP 400 com a lista de problemas. */
export class ValidationError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(problems.join("; "));
    this.name = "ValidationError";
    this.problems = problems;
  }
}

/** Funções de validação compartilhadas pelos Models. */
export const check = {
  text(problems, body, field, { required = true, max = 200 } = {}) {
    const value = body[field];
    if (value === undefined) {
      if (required) problems.push(`"${field}" é obrigatório`);
      return;
    }
    if (typeof value !== "string" || value.trim() === "") problems.push(`"${field}" deve ser um texto não vazio`);
    else if (value.length > max) problems.push(`"${field}" deve ter no máximo ${max} caracteres`);
  },
  integer(problems, body, field, { required = true, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const value = body[field];
    if (value === undefined) {
      if (required) problems.push(`"${field}" é obrigatório`);
      return;
    }
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(max === Number.MAX_SAFE_INTEGER
        ? `"${field}" deve ser um inteiro maior ou igual a ${min}`
        : `"${field}" deve ser um inteiro entre ${min} e ${max}`);
    }
  },
  oneOf(problems, body, field, options, { required = true } = {}) {
    const value = body[field];
    if (value === undefined) {
      if (required) problems.push(`"${field}" é obrigatório`);
      return;
    }
    if (!options.includes(value)) problems.push(`"${field}" deve ser um destes: ${options.join(", ")}`);
  },
  boolean(problems, body, field, { required = true } = {}) {
    const value = body[field];
    if (value === undefined) {
      if (required) problems.push(`"${field}" é obrigatório`);
      return;
    }
    if (typeof value !== "boolean") problems.push(`"${field}" deve ser true ou false`);
  },
  /** Campos que o cliente não pode mandar (id, datas) ou que o recurso não conhece. */
  onlyKnown(problems, body, allowed) {
    for (const field of Object.keys(body)) {
      if (!allowed.includes(field)) problems.push(`campo desconhecido ou somente leitura: "${field}"`);
    }
  },
};

/** Gera um id legível a partir do nome: "Fase do Casamento" → "fase-do-casamento". */
export const slugify = (text) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "item";
