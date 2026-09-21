// Gestao dos tokens da extensao (pop-up) pela linha de comando. O painel de
// administracao nao usa token: entra com usuario e senha (npm run admin).
//
// Enquanto nao existe nenhum token ativo, as rotas da extensao ficam em modo
// aberto. Os tokens tambem podem ser emitidos pelo painel, em Configuracoes.
//
//   npm run token -- listar
//   npm run token -- criar --nome "Stephanie" --atendente "Stephanie"
//   npm run token -- criar --nome "Supervisao" --admin
//   npm run token -- revogar --id 3
//
// O token aparece UMA vez, na criacao. Perdeu, revoga e emite outro.

require("dotenv").config();

const { initializeDatabase } = require("../database");
const { createToken, listTokens, revokeToken } = require("../services/token.service");

const USO = `
Uso: npm run token -- <comando> [opcoes]

Comandos:
  listar                                     lista os tokens (sem revelar nenhum)
  criar --nome "<rotulo>" --atendente "<nome>"   token de atendente
  criar --nome "<rotulo>" --admin                token que ve todos os alertas
  revogar --id <id>                          desativa um token
`.trim();

main().catch((error) => {
  console.error(`\n[token] ${error.message}\n`);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const comando = String(args._[0] || "").toLowerCase();

  const database = await initializeDatabase();

  try {
    if (comando === "listar") {
      await comandoListar();
    } else if (comando === "criar") {
      await comandoCriar(args);
    } else if (comando === "revogar") {
      await comandoRevogar(args);
    } else {
      console.log(`\n${USO}\n`);
      process.exitCode = comando ? 1 : 0;
    }
  } finally {
    database.close();
  }
}

async function comandoListar() {
  const { items } = await listTokens();

  if (!items.length) {
    console.log("\nNenhum token cadastrado: a extensao esta em modo aberto (todo mundo ve tudo).\n");
    return;
  }

  console.log("");
  for (const item of items) {
    const escopo = item.role === "ADMIN" ? "ve tudo" : `so os tickets de ${item.attendant} (mais os sem atendente)`;
    const situacao = item.isActive ? "ativo" : `revogado em ${formatarData(item.revokedAt)}`;
    console.log(
      `#${item.id} ${item.name} [${item.role}] ${item.tokenHint} — ${escopo} — ${situacao}` +
        ` — ultimo uso: ${item.lastUsedAt ? formatarData(item.lastUsedAt) : "nunca"}`
    );
  }
  console.log("");
}

async function comandoCriar(args) {
  const role = args.admin ? "ADMIN" : "ATENDENTE";
  const { token, record } = await createToken({
    name: args.nome,
    attendant: args.atendente,
    role
  });

  const escopo =
    record.role === "ADMIN"
      ? "Ve os alertas de todos os atendentes."
      : `Ve os tickets de ${record.attendant} e todos os que estao sem atendente.`;

  console.log(`\nToken #${record.id} criado para ${record.name} [${record.role}].`);
  console.log(escopo);
  console.log("\n  " + token + "\n");
  console.log("Ele nao volta a aparecer. Cole nas opcoes da extensao (ou no popup).\n");
}

async function comandoRevogar(args) {
  const item = await revokeToken(args.id);
  console.log(`\nToken #${item.id} (${item.name}) revogado.\n`);
}

// --chave valor e --flag. Sem magica: o que nao for --chave vira posicional.
function parseArgs(argv) {
  const args = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }

    const chave = item.slice(2);
    const proximo = argv[index + 1];
    if (proximo === undefined || proximo.startsWith("--")) {
      args[chave] = true;
      continue;
    }

    args[chave] = proximo;
    index += 1;
  }

  return args;
}

function formatarData(value) {
  if (!value) return "-";
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("pt-BR");
}
