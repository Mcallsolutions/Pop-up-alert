require("dotenv").config();

const app = require("./app");
const { initializeDatabase } = require("./database");
const { startCollector, stopCollector } = require("./services/mtalk/mtalk.collector");

const port = Number(process.env.PORT || 3333);
// Interface onde a API escuta. O padrao continua aberto na rede local, que e
// como a extensao de cada atendente alcanca a API. Atras de um proxy (nginx
// na VPS) use HOST=127.0.0.1: so o proxy fala com o Node, e a porta 3333
// deixa de existir para a internet.
const host = String(process.env.HOST || "0.0.0.0").trim();

initializeDatabase()
  .then((database) => {
    const server = app.listen(port, host, () => {
      console.log(`Mcall Ticket Tag API ouvindo em http://${host}:${port}`);
      console.log(`[DB] SQLite em ${database.filename}`);
      startCollector();
    });

    const shutdown = () => {
      stopCollector();
      server.close(() => {
        database.close();
        process.exit(0);
      });
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })
  .catch((error) => {
    console.error("[API]", error);
    process.exitCode = 1;
  });
