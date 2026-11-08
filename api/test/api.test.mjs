// Testes de ponta a ponta: servidor HTTP real, banco SQLite em memória, mesmas rotas do servidor.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { openDatabase } from "../src/database.mjs";
import { seed } from "../src/seed.mjs";
import { createApp } from "../src/app.mjs";
import { CozinheiroDAO } from "../src/dao/CozinheiroDAO.mjs";
import { Cozinheiro } from "../src/models/Cozinheiro.mjs";

let server;
let db;
let base;

beforeAll(async () => {
  db = openDatabase(":memory:");
  seed(db, () => "2026-11-08T12:00:00.000Z");
  server = createServer(createApp(db));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

const call = async (method, path, body) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
};

describe("raiz", () => {
  it("lista os recursos e conta o que há no banco", async () => {
    const index = await call("GET", "/api");
    expect(index.status).toBe(200);
    expect(index.body.recursos).toEqual(["/api/cozinheiros", "/api/fases", "/api/partidas"]);
    const health = await call("GET", "/api/saude");
    expect(health.body).toMatchObject({ status: "ok", cozinheiros: 4, fases: 1, partidas: 3 });
  });

  it("responde 404 a rotas inexistentes e 405 a métodos não aceitos", async () => {
    expect((await call("GET", "/api/sobremesas")).status).toBe(404);
    const wrong = await call("DELETE", "/api/fases");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toContain("GET");
  });

  it("libera CORS para o jogo chamar pelo navegador", async () => {
    const preflight = await fetch(`${base}/api/partidas`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("PATCH");
  });
});

describe("/api/cozinheiros", () => {
  it("GET lista e busca por id", async () => {
    const list = await call("GET", "/api/cozinheiros");
    expect(list.body.map((cook) => cook.id).sort()).toEqual(["jean", "milena", "sandy", "william"]);
    const one = await call("GET", "/api/cozinheiros/milena");
    expect(one.body).toMatchObject({ nome: "Milena", ativo: true });
    expect((await call("GET", "/api/cozinheiros/ninguem")).status).toBe(404);
  });

  it("POST cria, PUT substitui, PATCH altera parte e DELETE apaga", async () => {
    const created = await call("POST", "/api/cozinheiros", { nome: "Beatriz Souza", funcao: "Sous-chef", modelo: "beatriz.glb" });
    expect(created.status).toBe(201);
    expect(created.body.id).toBe("beatriz-souza");
    expect(created.headers.get("location")).toBe("/api/cozinheiros/beatriz-souza");

    const duplicated = await call("POST", "/api/cozinheiros", { nome: "Beatriz Souza", funcao: "x", modelo: "y" });
    expect(duplicated.status).toBe(409);

    const replaced = await call("PUT", "/api/cozinheiros/beatriz-souza", { nome: "Bia", funcao: "Chef", modelo: "bia.glb", ativo: false });
    expect(replaced.body).toMatchObject({ id: "beatriz-souza", nome: "Bia", funcao: "Chef", ativo: false });

    const patched = await call("PATCH", "/api/cozinheiros/beatriz-souza", { ativo: true });
    expect(patched.body).toMatchObject({ nome: "Bia", ativo: true });

    expect((await call("DELETE", "/api/cozinheiros/beatriz-souza")).status).toBe(204);
    expect((await call("GET", "/api/cozinheiros/beatriz-souza")).status).toBe(404);
  });

  it("recusa dados inválidos com a lista de problemas", async () => {
    const bad = await call("POST", "/api/cozinheiros", { nome: "", ativo: "sim", idade: 3 });
    expect(bad.status).toBe(400);
    expect(bad.body.detalhes).toEqual(expect.arrayContaining([
      '"nome" deve ser um texto não vazio',
      '"funcao" é obrigatório',
      '"ativo" deve ser true ou false',
      'campo desconhecido ou somente leitura: "idade"',
    ]));
    const incomplete = await call("PUT", "/api/cozinheiros/jean", { nome: "Jean" });
    expect(incomplete.status).toBe(400);
  });

  it("não apaga quem tem partidas no ranking (409); desativa-se com PATCH", async () => {
    const blocked = await call("DELETE", "/api/cozinheiros/jean");
    expect(blocked.status).toBe(409);
    const inactive = await call("PATCH", "/api/cozinheiros/jean", { ativo: false });
    expect(inactive.body.ativo).toBe(false);
    const active = await call("GET", "/api/cozinheiros?ativo=true");
    expect(active.body.some((cook) => cook.id === "jean")).toBe(false);
    await call("PATCH", "/api/cozinheiros/jean", { ativo: true });
  });
});

describe("/api/fases", () => {
  const nova = { nome: "Rush do Almoço", descricao: "Teste", duracaoSegundos: 180, dificuldade: "intense", objetos: [{ assetId: "build-floor" }] };

  it("GET lista resumida e a fase completa por id", async () => {
    const list = await call("GET", "/api/fases");
    expect(list.body[0]).toMatchObject({ id: "casamento", duracaoSegundos: 195 });
    expect(list.body[0].objetos).toBeUndefined();
    expect(list.body[0].totalObjetos).toBeGreaterThan(100);
    const full = await call("GET", "/api/fases/casamento");
    expect(full.body.objetos.length).toBe(list.body[0].totalObjetos);
  });

  it("CRUD completo e filtros", async () => {
    const created = await call("POST", "/api/fases", nova);
    expect(created.status).toBe(201);
    expect(created.body.id).toBe("rush-do-almoco");
    expect((await call("GET", "/api/fases?dificuldade=intense")).body.map((fase) => fase.id)).toEqual(["rush-do-almoco"]);
    expect((await call("GET", "/api/fases?busca=almo")).body).toHaveLength(1);
    expect((await call("GET", "/api/fases?dificuldade=facil")).status).toBe(400);

    const replaced = await call("PUT", "/api/fases/rush-do-almoco", { nome: "Rush", duracaoSegundos: 240, dificuldade: "relaxed" });
    expect(replaced.body).toMatchObject({ nome: "Rush", descricao: "", objetos: [] });

    const patched = await call("PATCH", "/api/fases/rush-do-almoco", { duracaoSegundos: 300 });
    expect(patched.body).toMatchObject({ nome: "Rush", duracaoSegundos: 300 });

    expect((await call("PATCH", "/api/fases/rush-do-almoco", { duracaoSegundos: 10 })).status).toBe(400);
    expect((await call("DELETE", "/api/fases/rush-do-almoco")).status).toBe(204);
    expect((await call("DELETE", "/api/fases/rush-do-almoco")).status).toBe(404);
  });

  it("exige JSON no corpo", async () => {
    const response = await fetch(`${base}/api/fases`, { method: "POST", body: "nome=x" });
    expect(response.status).toBe(415);
  });
});

describe("/api/partidas", () => {
  it("GET ranking por pontos, filtros e limite", async () => {
    const ranking = await call("GET", "/api/partidas?faseId=casamento");
    expect(ranking.body.map((partida) => partida.pontos)).toEqual([2310, 1840, 960]);
    const sandy = await call("GET", "/api/partidas?cozinheiro=sandy");
    expect(sandy.body).toHaveLength(2);
    expect((await call("GET", "/api/partidas?limite=1")).body).toHaveLength(1);
    expect((await call("GET", "/api/partidas?ordem=nome")).status).toBe(400);
  });

  it("CRUD completo, conferindo fase e cozinheiros", async () => {
    const created = await call("POST", "/api/partidas", {
      faseId: "casamento", cozinheiros: ["william", "milena"], pontos: 1500, pedidosEntregues: 8, rank: "B",
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(created.body).toMatchObject({ pedidosPerdidos: 0, rank: "B" });

    expect((await call("POST", "/api/partidas", { faseId: "lua", cozinheiros: ["william"], pontos: 1, rank: "D" })).status).toBe(400);
    expect((await call("POST", "/api/partidas", { faseId: "casamento", cozinheiros: ["ninguem"], pontos: 1, rank: "D" })).status).toBe(400);

    const replaced = await call("PUT", `/api/partidas/${id}`, { faseId: "casamento", cozinheiros: ["jean"], pontos: 2000, rank: "A" });
    expect(replaced.body).toMatchObject({ id, cozinheiros: ["jean"], pontos: 2000, pedidosEntregues: 0 });

    const patched = await call("PATCH", `/api/partidas/${id}`, { rank: "S" });
    expect(patched.body).toMatchObject({ pontos: 2000, rank: "S" });

    expect((await call("DELETE", `/api/partidas/${id}`)).status).toBe(204);
    expect((await call("GET", `/api/partidas/${id}`)).status).toBe(404);
    expect((await call("GET", "/api/partidas/abc")).status).toBe(404);
  });

  it("apagar uma fase apaga o ranking dela", async () => {
    await call("POST", "/api/fases", { nome: "Temporaria", duracaoSegundos: 120, dificuldade: "standard" });
    await call("POST", "/api/partidas", { faseId: "temporaria", cozinheiros: ["sandy"], pontos: 10, rank: "D" });
    expect((await call("GET", "/api/partidas?faseId=temporaria")).body).toHaveLength(1);
    await call("DELETE", "/api/fases/temporaria");
    expect((await call("GET", "/api/partidas?faseId=temporaria")).body).toHaveLength(0);
  });
});

describe("DAO", () => {
  it("lê e grava Models, sem passar pelo HTTP", () => {
    const dao = new CozinheiroDAO(db);
    const at = "2026-11-08T12:00:00.000Z";
    const saved = dao.insert(new Cozinheiro({ id: "teste", nome: "Teste", funcao: "f", modelo: "m", criadoEm: at, atualizadoEm: at }));
    expect(saved).toBeInstanceOf(Cozinheiro);
    expect(dao.findById("teste")?.nome).toBe("Teste");
    expect(dao.delete("teste")).toBe(true);
    expect(dao.findById("teste")).toBeNull();
  });
});
