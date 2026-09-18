// Autenticacao da API local: le o token do cabecalho, resolve quem e a pessoa
// e deixa o recorte pronto em req.auth.
//
// Enquanto nao existe token ativo a API roda em MODO ABERTO (todo mundo como
// ADMIN, como era antes de existir login). Criar o primeiro token liga a
// exigencia — nao ha flag no .env para desligar: o estado do banco manda.

const { authenticateToken, isOpenMode, openModeIdentity } = require("../services/token.service");

let avisouModoAberto = false;

async function authenticate(req, _res, next) {
  try {
    if (await isOpenMode()) {
      avisarModoAberto();
      req.auth = openModeIdentity();
      next();
      return;
    }

    const token = readToken(req);
    if (!token) {
      next(unauthorized("Token de acesso obrigatorio. Configure o seu token no painel ou na extensao."));
      return;
    }

    const identity = await authenticateToken(token);
    if (!identity) {
      next(unauthorized("Token de acesso invalido ou revogado."));
      return;
    }

    req.auth = identity;
    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req, _res, next) {
  if (!req.auth?.isAdmin) {
    next(forbidden("Esta area e restrita a tokens de administrador."));
    return;
  }
  next();
}

// Filtros de relatorio com o recorte do token por cima: o valor vem SEMPRE de
// req.auth, nunca da query — senao bastaria mandar ?scopeAttendant= para ver o
// que nao e seu.
function scopedFilters(req, base) {
  return { ...(base || {}), scopeAttendant: req.auth?.scopeAttendant || null };
}

function readToken(req) {
  const authorization = String(req.headers.authorization || "").trim();
  if (/^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, "").trim();
  }

  return String(req.headers["x-api-token"] || "").trim();
}

function avisarModoAberto() {
  if (avisouModoAberto) {
    return;
  }
  avisouModoAberto = true;
  console.warn(
    "[Auth] Nenhum token ativo: a API esta em modo aberto (todo mundo ve tudo). Crie o primeiro com `npm run token -- criar ...`."
  );
}

function unauthorized(message) {
  const error = new Error(message);
  error.statusCode = 401;
  error.publicMessage = message;
  return error;
}

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  error.publicMessage = message;
  return error;
}

module.exports = {
  authenticate,
  requireAdmin,
  scopedFilters
};
