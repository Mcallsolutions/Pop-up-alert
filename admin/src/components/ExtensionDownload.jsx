import { useEffect, useState } from "react";
import { Download, Package } from "lucide-react";
import { api } from "../services/api";
import { formatDateTime } from "../services/datetime";

// Baixa a pasta /extension compactada pela API, para instalar em outra maquina
// ou mandar para alguem sem precisar do repositorio.
export default function ExtensionDownload() {
  const [pacote, setPacote] = useState(null);
  const [erro, setErro] = useState("");
  const [feedback, setFeedback] = useState("");
  const [baixando, setBaixando] = useState(false);

  useEffect(() => {
    api
      .extensionPackage()
      .then((dados) => {
        setPacote(dados);
        setErro("");
      })
      .catch((error) => setErro(error.message));
  }, []);

  async function baixar() {
    setBaixando(true);
    setFeedback("");
    try {
      const { fileName } = await api.downloadExtension();
      setFeedback(`${fileName} baixado. Descompacte antes de carregar no Chrome.`);
      setErro("");
    } catch (error) {
      setErro(error.message);
    } finally {
      setBaixando(false);
    }
  }

  return (
    <div className="table-panel">
      <h3>Extensao do Chrome</h3>

      {erro ? <p className="notice error">{erro}</p> : null}
      {feedback ? <p className="notice success">{feedback}</p> : null}

      <div className="extension-download">
        <div className="extension-info">
          <Package aria-hidden="true" size={18} />
          <div>
            <strong>{pacote ? `${pacote.nome} v${pacote.versao}` : "Mcall Ticket Tag Monitor"}</strong>
            <span>
              {pacote
                ? `${pacote.arquivo} — ${pacote.totalArquivos} arquivos, ${formatBytes(pacote.totalBytes)} (atualizada em ${formatDateTime(pacote.atualizadoEm)})`
                : erro
                  ? "Pacote indisponivel."
                  : "Carregando..."}
            </span>
          </div>
        </div>

        <button className="primary-button" type="button" onClick={baixar} disabled={baixando || Boolean(erro)}>
          <Download aria-hidden="true" size={17} />
          {baixando ? "Gerando..." : "Baixar extensao (.zip)"}
        </button>
      </div>

      <ol className="extension-steps">
        <li>Descompacte o .zip em uma pasta fixa (mover a pasta depois desinstala a extensao).</li>
        <li>
          Abra <code>chrome://extensions</code> e ligue o <strong>Modo do desenvolvedor</strong>.
        </li>
        <li>
          Clique em <strong>Carregar sem compactacao</strong> e escolha a pasta descompactada.
        </li>
        <li>
          Em <strong>Opcoes</strong> da extensao, informe a URL da API e o token de acesso da pessoa.
        </li>
      </ol>

      <p className="extension-aviso">
        O pacote sai direto da pasta <code>extension</code> do servidor e <strong>nao leva token nem .env dentro</strong>
        : cada pessoa configura o proprio token depois de instalar.
      </p>
    </div>
  );
}

function formatBytes(total) {
  const bytes = Number(total) || 0;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}
