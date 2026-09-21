// Usuarios do painel de administracao (login e senha), pela linha de comando.
//
// Nao ha cadastro pela web: o primeiro usuario sai daqui, e sem nenhum o
// painel simplesmente nao abre.
//
//   npm run admin -- criar --login supervisao --nome "Supervisao"
//   npm run admin -- senha --login supervisao
//   npm run admin -- desativar --login supervisao
//   npm run admin -- ativar --login supervisao
//   npm run admin -- listar
//
// A senha e pedida no terminal, sem eco — assim ela nao fica no historico do
// shell. Para automacao, --senha "<valor>" tambem funciona.

require("dotenv").config();

const readline = require("node:readline");
const { initializeDatabase } = require("../database");
const {
  MIN_PASSWORD_LENGTH,
  createAdminUser,
  listAdminUsers,
  setAdminActive,
  setAdminPassword
} = require("../services/admin-auth.service");

const USO = `
Uso: npm run admin -- <comando> [opcoes]

Comandos:
  listar                                       lista os usuarios do painel
  criar --login <login> [--nome "<nome>"]      cria um usuario (pede a senha)
  senha --login <login>                        troca a senha e encerra as sessoes abertas
  desativar --login <login>                    bloqueia o acesso e encerra as sessoes
  ativar --login <login>                       libera de novo um usuario desativado
`.trim();

main().catch((error) => {
  console.error(`\n[admin] ${error.message}\n`);
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
      const user = await createAdminUser({ username: exigirLogin(args), name: args.nome, password: await lerSenha(args) });
      console.log(`\nUsuario "${user.username}" (${user.name}) criado. Ja pode entrar no painel.\n`);
    } else if (comando === "senha") {
      const user = await setAdminPassword(exigirLogin(args), await lerSenha(args));
      console.log(`\nSenha de "${user.username}" trocada. As sessoes abertas foram encerradas.\n`);
    } else if (comando === "desativar" || comando === "ativar") {
      const user = await setAdminActive(exigirLogin(args), comando === "ativar");
      console.log(`\nUsuario "${user.username}" ${user.isActive ? "ativado" : "desativado"}.\n`);
    } else {
      console.log(`\n${USO}\n`);
      process.exitCode = comando ? 1 : 0;
    }
  } finally {
    database.close();
  }
}

async function comandoListar() {
  const users = await listAdminUsers();

  if (!users.length) {
    console.log('\nNenhum usuario cadastrado: o painel nao abre. Crie um com `npm run admin -- criar --login <login>`.\n');
    return;
  }

  console.log("");
  for (const user of users) {
    console.log(
      `#${user.id} ${user.username} (${user.name}) — ${user.isActive ? "ativo" : "desativado"}` +
        ` — ultimo login: ${user.lastLoginAt ? formatarData(user.lastLoginAt) : "nunca"}`
    );
  }
  console.log("");
}

function exigirLogin(args) {
  if (typeof args.login !== "string" || !args.login.trim()) {
    throw new Error("Informe --login <login>.");
  }
  return args.login;
}

async function lerSenha(args) {
  if (typeof args.senha === "string") {
    return args.senha;
  }

  if (!process.stdin.isTTY) {
    throw new Error("Sem terminal interativo para pedir a senha: use --senha.");
  }

  const senha = await perguntarOculto(`Senha (minimo ${MIN_PASSWORD_LENGTH} caracteres): `);
  const confirmacao = await perguntarOculto("Repita a senha: ");
  if (senha !== confirmacao) {
    throw new Error("As senhas nao conferem.");
  }
  return senha;
}

// Pergunta sem ecoar o que e digitado.
function perguntarOculto(pergunta) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let mostrouPergunta = false;

    rl._writeToOutput = (texto) => {
      if (!mostrouPergunta) {
        mostrouPergunta = true;
        rl.output.write(texto);
      }
    };

    rl.question(pergunta, (resposta) => {
      rl.output.write("\n");
      rl.close();
      resolve(resposta);
    });
  });
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
