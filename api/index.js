// Entrypoint da Serverless Function da Vercel.
// Todo o codigo da API vive em /server. Esta pasta contem apenas este arquivo
// para que a Vercel gere UMA unica function (o limite do plano Hobby e 12).
const app = require("../server/src/app");

module.exports = app;
