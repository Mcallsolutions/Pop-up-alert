require("dotenv").config();

const app = require("./app");
const { initializeDatabase } = require("./database");
const { startCollector, stopCollector } = require("./services/mtalk/mtalk.collector");

const port = Number(process.env.PORT || 3333);

initializeDatabase()
  .then((database) => {
    const server = app.listen(port, () => {
      console.log(`Mcall Ticket Tag API ouvindo em http://localhost:${port}`);
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
