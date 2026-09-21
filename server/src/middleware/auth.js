// Autenticacao da API local. Sao dois tipos de credencial, os dois no
// cabecalho Authorization: Bearer:
//
// - sessao do painel (mcs_...), obtida com usuario e senha em /api/auth/login.
//   E a unica que abre o painel de administracao;
// - token por pessoa (mca_...), usado so pela extensao (pop-up) para saber de
//   quem sao os alertas.
//
// Enquanto nao existe token de extensao ativo, as rotas da extensao rodam em
// MODO ABERTO (todo mundo ve tudo). O painel nunca fica aberto: sem login, 401.

const { authenticateToken, isOpenMode, openModeIdentity } = require("../services/token.service");
const { authenticateSession, isSessionToken } = require("../services/admin-auth.service");

let avisouModoAberto = false;

// Rotas que a extensao usa (alertas, status, coleta). Aceita o token da pessoa
// ou uma sessao do painel.
async function authenticate(req, _res, next) {
  try {
    const credential = readToken(req);

    if (isSessionToken(credential)) {
      const identity = await authenticateSession(credential);
      if (!identity) {
        next(unauthorized("Sessao expirada ou encerrada. Entre novamente."));
        return;
      }
      req.auth = identity;
      next();
      return;
    }

    if (await isOpenMode()) {
      avisarModoAberto();
      req.auth = openModeIdentity();
      next();
      return;
    }

    if (!credential) {
      next(unauthorized("Token de acesso obrigatorio. Configure o seu token nas opcoes da extensao."));
      return;
    }

    const identity = await authenticateToken(credential);
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

// Rotas do painel de administracao: so sessao de login. Token da extensao,
// mesmo de perfil ADMIN, nao abre o painel.
async function authenticatePanel(req, _res, next) {
  try {
    const credential = readToken(req);
    const identity = isSessionToken(credential) ? await authenticateSession(credential) : null;

    if (!identity) {
      next(unauthorized("Entre com usuario e senha para acessar o painel."));
      return;
    }

    req.auth = identity;
    next();
  } catch (error) {
    next(error);
  }
}

// Filtros de relatorio com o recorte da identidade por cima: o valor vem
// SEMPRE de req.auth, nunca da query — senao bastaria mandar ?scopeAttendant=
// para ver o que nao e seu.
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
    "[Auth] Nenhum token de extensao ativo: as rotas da extensao estao em modo aberto (todo mundo ve tudo). Emita os tokens no painel ou com `npm run token -- criar ...`."
  );
}

function unauthorized(message) {
  const error = new Error(message);
  error.statusCode = 401;
  error.publicMessage = message;
  return error;
}

module.exports = {
  authenticate,
  authenticatePanel,
  readToken,
  scopedFilters
};
