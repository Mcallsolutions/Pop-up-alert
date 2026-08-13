// Validacao do token da extensao, compartilhada pelas rotas que recebem dados
// de coleta (snapshot da extensao e coleta pela API oficial do MTalk).

function validateExtensionToken(req) {
  const expected = process.env.EXTENSION_TOKEN;
  if (!expected) {
    return;
  }

  if (req.get("x-extension-token") === expected) {
    return;
  }

  // A Vercel dispara os Cron Jobs com "Authorization: Bearer <CRON_SECRET>",
  // entao a coleta agendada tambem passa por aqui sem precisar de outra rota.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.get("authorization") === `Bearer ${cronSecret}`) {
    return;
  }

  const error = new Error("Token da extensao invalido");
  error.statusCode = 401;
  error.publicMessage = "Token da extensao invalido";
  throw error;
}

module.exports = { validateExtensionToken };
