// Conexão com o banco SQLite (módulo nativo node:sqlite, sem dependências externas).
// O DAO é a única camada que conversa com o banco; os controllers nunca usam SQL.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cozinheiros (
  id          TEXT PRIMARY KEY,
  nome        TEXT NOT NULL,
  funcao      TEXT NOT NULL,
  modelo      TEXT NOT NULL,
  ativo       INTEGER NOT NULL DEFAULT 1,
  criado_em   TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fases (
  id               TEXT PRIMARY KEY,
  nome             TEXT NOT NULL,
  descricao        TEXT NOT NULL DEFAULT '',
  cenario          TEXT NOT NULL DEFAULT 'wedding',
  duracao_segundos INTEGER NOT NULL,
  dificuldade      TEXT NOT NULL,
  objetos          TEXT NOT NULL DEFAULT '[]',
  criado_em        TEXT NOT NULL,
  atualizado_em    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS partidas (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  fase_id            TEXT NOT NULL REFERENCES fases(id) ON DELETE CASCADE,
  cozinheiros        TEXT NOT NULL,
  pontos             INTEGER NOT NULL,
  pedidos_entregues  INTEGER NOT NULL DEFAULT 0,
  pedidos_perdidos   INTEGER NOT NULL DEFAULT 0,
  rank               TEXT NOT NULL,
  jogada_em          TEXT NOT NULL
);
`;

/**
 * Abre (ou cria) o banco em `file`. Use ":memory:" nos testes.
 * @param {string} file
 * @returns {DatabaseSync}
 */
export function openDatabase(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}
