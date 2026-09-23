// Carga do .env e mensagem de erro dos scripts de linha de comando.
//
// Na VPS estes scripts rodam como o usuario do servico (`sudo -u tag-monitor
// node ...`), enquanto o systemd le o mesmo .env como root. Se o arquivo nao
// for legivel para esse usuario, o dotenv nao reclama — apenas devolve o erro
// e segue. Sem o .env o SQLITE_PATH fica vazio, o banco cai no caminho padrao
// dentro da pasta do deploy (onde o usuario do servico nao escreve) e o que
// aparece e um `EACCES: permission denied, mkdir` que nao diz nada sobre a
// causa. Aqui o erro vira instrucao.

const os = require("node:os");
const path = require("node:path");

let envError;

function loadEnv() {
  envError = require("dotenv").config().error;
}

// Mensagem final do script: o erro cru mais a causa, quando ela for conhecida.
function explainError(error) {
  const linhas = [error.message];

  if (isPermissionError(error) && envError) {
    const arquivo = path.resolve(process.cwd(), ".env");
    linhas.push(
      "",
      `Causa provavel: o ${arquivo} nao foi lido (${envError.code || envError.message}), entao o SQLITE_PATH ficou`,
      "vazio e o banco caiu no caminho padrao, dentro da pasta do deploy.",
      "",
      `Na VPS, libere a leitura para o grupo de quem roda o script (${currentUser()}):`,
      `  sudo chown root:${currentUser()} ${arquivo} && sudo chmod 640 ${arquivo}`,
      "ou passe o caminho do banco na propria linha de comando:",
      "  env SQLITE_PATH=/var/lib/tag-monitor/monitor.sqlite node <script> ..."
    );
  }

  return linhas.join("\n");
}

// `useradd --user-group` cria o grupo com o mesmo nome do usuario, que e como
// o guia da VPS monta o usuario do servico.
function currentUser() {
  try {
    return os.userInfo().username;
  } catch {
    return "tag-monitor";
  }
}

function isPermissionError(error) {
  return ["EACCES", "EPERM", "EROFS"].includes(error?.code);
}

module.exports = {
  explainError,
  loadEnv
};
