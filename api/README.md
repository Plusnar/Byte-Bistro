# API Byte Bistro

API REST do jogo [Byte Bistro](https://byte-bistro.pages.dev/), em Node.js 24 + SQLite (`node:sqlite`),
sem dependências externas, na arquitetura **Model / DAO**.

```
npm run api        # http://localhost:3333/api
npm run test:api   # testes de ponta a ponta
```

| Recurso | Rotas |
|---|---|
| Cozinheiros | `GET/POST /api/cozinheiros`, `GET/PUT/PATCH/DELETE /api/cozinheiros/:id` |
| Fases | `GET/POST /api/fases`, `GET/PUT/PATCH/DELETE /api/fases/:id` |
| Partidas (ranking) | `GET/POST /api/partidas`, `GET/PUT/PATCH/DELETE /api/partidas/:id` |

Camadas: `src/models` (dados e validação) → `src/dao` (único acesso ao banco) →
`src/controllers` (regras de cada operação) → `src/app.mjs` (rotas HTTP).

A documentação de uso completa (PDF, ABNT) é entregue à parte.

Equipe: Sandriely Maciel e William Fagundes. Professora: Milena Felix.
