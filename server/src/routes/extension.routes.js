const express = require("express");
const { buildExtensionZip, describeExtensionPackage } = require("../services/extension-package");

const router = express.Router();

// Versao e tamanho do pacote, para o painel mostrar antes do download.
router.get("/package", async (_req, res, next) => {
  try {
    res.json(await describeExtensionPackage());
  } catch (error) {
    error.statusCode = error.statusCode || 500;
    error.publicMessage = error.publicMessage || `Nao foi possivel ler a pasta /extension: ${error.message}`;
    next(error);
  }
});

// Baixa a extensao compactada. O zip nao leva token nem .env: quem recebe
// instala e configura o proprio token na tela de opcoes da extensao.
router.get("/download", async (_req, res, next) => {
  try {
    const { fileName, buffer } = await buildExtensionZip();

    res.setHeader("content-type", "application/zip");
    res.setHeader("content-disposition", `attachment; filename="${fileName}"`);
    // Sem isto o fetch do painel nao enxerga o cabecalho para nomear o arquivo.
    res.setHeader("access-control-expose-headers", "content-disposition");
    res.setHeader("content-length", buffer.length);
    res.send(buffer);
  } catch (error) {
    error.statusCode = error.statusCode || 500;
    error.publicMessage = error.publicMessage || `Nao foi possivel montar o pacote da extensao: ${error.message}`;
    next(error);
  }
});

module.exports = router;
