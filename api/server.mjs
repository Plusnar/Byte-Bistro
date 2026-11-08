// Ponto de entrada da API Byte Bistro: `npm run api` (porta 3333, ou a variável PORT).
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./src/database.mjs";
import { seed } from "./src/seed.mjs";
import { createApp } from "./src/app.mjs";

const port = Number(process.env.PORT ?? 3333);
const file = process.env.DB_FILE ?? fileURLToPath(new URL("./data/bytebistro.db", import.meta.url));

const db = openDatabase(file);
seed(db);
const server = createServer(createApp(db));

server.listen(port, () => {
  console.log(`API Byte Bistro em http://localhost:${port}/api  (banco: ${file})`);
});

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
