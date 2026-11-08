// Dados iniciais: os quatro cozinheiros do jogo, a fase oficial do Casamento e um ranking de exemplo.
// Só roda com o banco vazio, então não apaga nada que já foi cadastrado.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CozinheiroDAO } from "./dao/CozinheiroDAO.mjs";
import { FaseDAO } from "./dao/FaseDAO.mjs";
import { PartidaDAO } from "./dao/PartidaDAO.mjs";
import { Cozinheiro } from "./models/Cozinheiro.mjs";
import { Fase } from "./models/Fase.mjs";
import { Partida } from "./models/Partida.mjs";

const COZINHEIROS = [
  { id: "william", nome: "William", funcao: "Chef de cozinha", modelo: "asset-library/Char/Characters/William .glb" },
  { id: "sandy", nome: "Sandy", funcao: "Confeiteira", modelo: "asset-library/Char/Characters/Sandy.glb" },
  { id: "milena", nome: "Milena", funcao: "Confeiteira", modelo: "asset-library/Char/Characters/Milena.glb" },
  { id: "jean", nome: "Jean", funcao: "Chef da grelha", modelo: "asset-library/Char/Characters/Jean.glb" },
];

const OFFICIAL_LEVEL = fileURLToPath(new URL("../../src/data/levels/casamento.bytebistro.json", import.meta.url));

/** @param {import("node:sqlite").DatabaseSync} db */
export function seed(db, now = () => new Date().toISOString()) {
  const cozinheiros = new CozinheiroDAO(db);
  const fases = new FaseDAO(db);
  const partidas = new PartidaDAO(db);
  const at = now();

  if (cozinheiros.count() === 0) {
    for (const data of COZINHEIROS) cozinheiros.insert(new Cozinheiro({ ...data, criadoEm: at, atualizadoEm: at }));
  }
  if (fases.count() === 0) {
    const map = JSON.parse(readFileSync(OFFICIAL_LEVEL, "utf8"));
    fases.insert(new Fase({
      id: "casamento",
      nome: "Casamento",
      descricao: "A recepção do casamento. Sirva os convidados robôs antes do tempo acabar.",
      cenario: map.scenarioId ?? "wedding",
      duracaoSegundos: map.meta?.shiftDurationSeconds ?? 195,
      dificuldade: map.meta?.difficultyId ?? "standard",
      objetos: map.objects,
      criadoEm: at,
      atualizadoEm: at,
    }));
  }
  if (partidas.count() === 0) {
    const exemplos = [
      { cozinheiros: ["william", "sandy"], pontos: 1840, pedidosEntregues: 9, pedidosPerdidos: 1, rank: "A" },
      { cozinheiros: ["milena", "jean"], pontos: 2310, pedidosEntregues: 11, pedidosPerdidos: 0, rank: "S" },
      { cozinheiros: ["sandy", "jean"], pontos: 960, pedidosEntregues: 5, pedidosPerdidos: 3, rank: "C" },
    ];
    for (const data of exemplos) partidas.insert(new Partida({ ...data, faseId: "casamento", jogadaEm: at }));
  }
}
