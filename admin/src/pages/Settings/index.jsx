import { useEffect, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { api, getApiBaseUrl, setApiBaseUrl } from "../../services/api";
import { formatDateTime } from "../../services/datetime";
import TokenManager from "../../components/TokenManager";
import ExtensionDownload from "../../components/ExtensionDownload";

export default function SettingsPage() {
  const [apiUrl, setApiUrl] = useState(getApiBaseUrl());
  const [feedback, setFeedback] = useState("");
  const [mtalk, setMtalk] = useState(null);
  const [mtalkError, setMtalkError] = useState("");
  const [collecting, setCollecting] = useState(false);

  async function loadStatus() {
    try {
      setMtalk(await api.mtalkStatus());
      setMtalkError("");
    } catch (error) {
      setMtalkError(error.message);
    }
  }

  useEffect(() => {
    loadStatus();
  }, []);

  function save(event) {
    event.preventDefault();
    setApiBaseUrl(apiUrl);
    setFeedback("Configuracao salva. Atualize os dados para usar a nova API.");
  }

  async function collectNow() {
    setCollecting(true);
    setFeedback("");
    try {
      const result = await api.mtalkCollect();
      setFeedback(`Coleta concluida: ${result.totalTickets} tickets, ${result.totalWithoutTag} sem TAG.`);
      setMtalkError("");
    } catch (error) {
      setMtalkError(error.message);
    } finally {
      setCollecting(false);
      loadStatus();
    }
  }

  const sessao = mtalk?.sessao || {};
  const execucao = mtalk?.coletaAutomatica?.ultimaExecucao || {};

  return (
    <section className="page-stack">
      <div className="section-toolbar">
        <div>
          <h2>Configuracoes</h2>
          <p>Coleta pela API oficial do MTalk e ajustes do painel.</p>
        </div>
        <button className="secondary-button" type="button" onClick={collectNow} disabled={collecting}>
          <RefreshCw aria-hidden="true" size={17} />
          {collecting ? "Coletando..." : "Coletar agora"}
        </button>
      </div>

      {feedback ? <p className="notice success">{feedback}</p> : null}
      {mtalkError ? <p className="notice error">{mtalkError}</p> : null}

      <div className="table-panel">
        <h3>Integracao MTalk (API oficial)</h3>
        <div className="table-scroll">
          {!mtalk ? (
            <p className="notice">{mtalkError ? "Status indisponivel." : "Carregando..."}</p>
          ) : (
            <table>
              <tbody>
                <tr>
                  <td>Token</td>
                  <td>
                    <span className={`badge${mtalk.configurado ? " ativo" : ""}`}>
                      {mtalk.configurado ? "MTALK_TOKEN configurado" : "defina MTALK_TOKEN no .env"}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>Token aceito pelo MTalk</td>
                  <td>
                    {sessao.ultimoErro
                      ? sessao.ultimoErro
                      : sessao.ultimaRespostaOkEm
                        ? `sim (ultima resposta ${formatDateTime(sessao.ultimaRespostaOkEm)})`
                        : "ainda nao testado"}
                  </td>
                </tr>
                <tr>
                  <td>Coleta automatica</td>
                  <td>
                    {mtalk.coletaAutomatica?.ativa ? `a cada ${mtalk.coletaAutomatica.intervaloSegundos}s` : "desligada"}
                  </td>
                </tr>
                <tr>
                  <td>Ultima execucao</td>
                  <td>
                    {execucao.finishedAt
                      ? `${formatDateTime(execucao.finishedAt)} — ${execucao.ok ? "ok" : `falhou: ${execucao.error}`}`
                      : "-"}
                  </td>
                </tr>
                <tr>
                  <td>Ultima coleta gravada</td>
                  <td>
                    {mtalk.ultimaColeta
                      ? `${formatDateTime(mtalk.ultimaColeta.coletadoEm)} — ${mtalk.ultimaColeta.totalTickets} tickets em ${mtalk.ultimaColeta.diagnostico?.requisicoes ?? 0} requisicao(oes)`
                      : "-"}
                  </td>
                </tr>
                <tr>
                  <td>Endereco da API</td>
                  <td>{mtalk.baseUrl}</td>
                </tr>
                <tr>
                  <td>Filas monitoradas</td>
                  <td>{(mtalk.filasMonitoradas || []).join(", ")}</td>
                </tr>
                <tr>
                  <td>Filas encontradas no MTalk</td>
                  <td>{(mtalk.cacheFilas?.filas || []).join(", ") || "-"}</td>
                </tr>
                <tr>
                  <td>Status lidos</td>
                  <td>{(mtalk.statusMonitorados || []).join(", ")}</td>
                </tr>
                <tr>
                  <td>Limite de inatividade</td>
                  <td>{mtalk.limiteInatividadeMinutos} min</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      </div>

      <ExtensionDownload />

      <TokenManager />

      <form className="settings-form" onSubmit={save}>
        <label>
          URL da API
          <input
            value={apiUrl}
            onChange={(event) => setApiUrl(event.target.value)}
            placeholder="Deixe vazio para usar a mesma origem do painel"
          />
          <small>
            Vazio = o painel chama <code>/api</code> na propria origem (em <code>npm run dev</code> o Vite repassa para{" "}
            <code>http://localhost:3333</code>). Preencha apenas se a API estiver em outro endereco.
          </small>
        </label>
        <button className="primary-button" type="submit">
          <Save aria-hidden="true" size={17} />
          Salvar
        </button>
      </form>
    </section>
  );
}
