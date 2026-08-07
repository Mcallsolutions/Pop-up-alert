require("dotenv").config();

const app = require("./app");
const { initializeDatabase } = require("./database");

const port = Number(process.env.PORT || 3333);

initializeDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`Mcall Ticket Tag API ouvindo em http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error("[API]", error);
    process.exitCode = 1;
  });
