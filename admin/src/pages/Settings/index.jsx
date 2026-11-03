import { useEffect, useState } from "react";
import { MessageCircle, RefreshCw, Save } from "lucide-react";
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
  const [attendance, setAttendance] = useState(null);
  const [whatsapp, setWhatsapp] = useState(null);

  async function loadStatus() {
    try {
      setMtalk(await api.mtalkStatus());
      setMtalkError("");
    } catch (error) {
      setMtalkError(error.message);
    }
    // Status da analise de atendimento: falha aqui nao esconde o do MTalk.
    api
      .attendanceStatus()
      .then(setAttendance)
      .catch(() => setAttendance(null));
    api
      .whatsappStatus()
      .then(setWhatsapp)
      .catch(() => setWhatsapp(null));
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
            <table className="kv-table">
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

      <AttendanceStatus status={attendance} />

      <WhatsappStatus status={whatsapp} onTested={loadStatus} />

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

// Alertas de inatividade no WhatsApp: desligados por padrao (WHATSAPP_ALERTS).
// Numero e chave ficam so no .env; aqui aparecem mascarados.
function WhatsappStatus({ status, onTested }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  if (!status) {
    return null;
  }

  async function sendTest() {
    setTesting(true);
    setError("");
    setResult(null);
    try {
      setResult(await api.whatsappTest());
    } catch (requestError) {
      setError(requestError.message || "Falha ao enviar a mensagem de teste");
    } finally {
      setTesting(false);
      onTested();
    }
  }

  const ultimo = status.ultimoEnvio;
  const podeTestar = status.ligado && !status.problema;

  return (
    <div className="table-panel">
      <h3>Alertas no WhatsApp</h3>

      {error ? <p className="notice error">{error}</p> : null}
      {result ? (
        <p className={result.ok ? "notice success" : "notice warning"}>
          {result.ok
            ? `Teste enviado para ${result.enviados} destinatario(s).`
            : `Teste: ${result.enviados} enviado(s), ${result.falhas} com falha — ${result.destinatarios
                .filter((item) => !item.ok)
                .map((item) => `${item.destinatario}: ${item.erro}`)
                .join("; ")}`}
        </p>
      ) : null}

      <div className="table-scroll">
        <table className="kv-table">
          <tbody>
            <tr>
              <td>Situacao</td>
              <td>
                <span className={`badge${status.ligado && !status.problema ? " ativo" : ""}`}>
                  {status.ligado ? (status.problema ? "ligado, com pendencia" : "ligado") : "desligado (WHATSAPP_ALERTS=0)"}
                </span>
                {status.problema ? ` — ${status.problema}` : ""}
              </td>
            </tr>
            <tr>
              <td>Provedor</td>
              <td>{status.provedor || "-"}</td>
            </tr>
            <tr>
              <td>Destinatarios</td>
              <td>{status.destinatarios?.length ? status.destinatarios.join(", ") : "nenhum (WHATSAPP_RECIPIENTS)"}</td>
            </tr>
            <tr>
              <td>Quando avisa</td>
              <td>
                uma vez quando o cliente passa do limite de inatividade
                {status.lembreteMinutos ? `, com lembrete a cada ${status.lembreteMinutos} min enquanto continuar parado` : ""}
                {status.incluiNomeCliente ? " — com o nome do cliente" : " — sem o nome do cliente"}
              </td>
            </tr>
            <tr>
              <td>Limite da hora</td>
              <td>
                {status.orcamentoHora?.usadas ?? 0} de {status.orcamentoHora?.limite ?? 0} mensagem(ns) por destinatario
              </td>
            </tr>
            <tr>
              <td>Ultimo envio</td>
              <td>
                {ultimo?.em
                  ? `${formatDateTime(ultimo.em)} — ${ultimo.ok ? "ok" : `falhou: ${ultimo.erro}`}${ultimo.tickets ? `, ${ultimo.tickets} ticket(s)` : ""}${ultimo.semOrcamento ? " (limite da hora atingido depois)" : ""}`
                  : ultimo?.semOrcamento
                    ? "limite da hora atingido"
                    : "-"}
                {status.aguardandoAposFalhaAte ? ` — nova tentativa apos ${formatDateTime(status.aguardandoAposFalhaAte)}` : ""}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="extension-download">
        <div className="extension-info">
          <MessageCircle aria-hidden="true" size={18} />
          <div>
            <strong>Mensagem de teste</strong>
            <span>Manda uma mensagem curta para todos os destinatarios configurados.</span>
          </div>
        </div>
        <button className="secondary-button" type="button" onClick={sendTest} disabled={testing || !podeTestar}>
          <MessageCircle aria-hidden="true" size={17} />
          {testing ? "Enviando..." : "Enviar teste"}
        </button>
      </div>
    </div>
  );
}

// Analise de atendimento por IA: desligada por padrao (AI_ATTENDANCE_ANALYSIS).
function AttendanceStatus({ status }) {
  if (!status) {
    return null;
  }

  const leitura = status.leitura?.ultima;
  const automatica = status.analiseAutomatica?.ultima;
  const config = status.config || {};
  const vinculados = status.recorte?.atendentesVinculados || [];

  return (
    <div className="table-panel">
      <h3>Analise de atendimento (IA)</h3>
      <div className="table-scroll">
        <table className="kv-table">
          <tbody>
            <tr>
              <td>Situacao</td>
              <td>
                <span className={`badge${status.ligada ? " ativo" : ""}`}>
                  {status.ligada ? "ligada" : "desligada (AI_ATTENDANCE_ANALYSIS=0)"}
                </span>
                {status.ligada && !status.openaiConfigurado ? " — OPENAI_API_KEY nao configurada" : ""}
              </td>
            </tr>
            <tr>
              <td>Recorte da IA</td>
              <td>
                {vinculados.length
                  ? `${vinculados.join(", ")} (tokens de atendente ativos)`
                  : "nenhum atendente vinculado — emita um token de atendente para a IA ler as conversas dele"}
                {" — filas "}
                {(status.recorte?.filas || []).join(", ")}
              </td>
            </tr>
            <tr>
              <td>Orcamento da hora</td>
              <td>
                {status.orcamentoHora?.usadas ?? 0} de {status.orcamentoHora?.limite ?? 0} analises (modelo {status.modelo})
              </td>
            </tr>
            <tr>
              <td>Mensagens mascaradas no banco</td>
              <td>
                {status.mensagensNoBanco} em {status.ticketsAcompanhados} ticket(s) acompanhados — retencao de{" "}
                {config.retencaoMensagensDias} dias
              </td>
            </tr>
            <tr>
              <td>Ultima leitura de mensagens</td>
              <td>
                {leitura?.fim
                  ? `${formatDateTime(leitura.fim)} — ${leitura.ok ? "ok" : `falhou: ${leitura.erro}`}, ${leitura.requisicoes} requisicao(oes), ${leitura.mensagensGravadas} mensagem(ns) gravada(s), ${leitura.mensagensForaDoRecorte ?? 0} fora do recorte, ${leitura.ticketsForaDoRecorte ?? 0} ticket(s) sem trecho vinculado`
                  : "-"}
              </td>
            </tr>
            <tr>
              <td>Ultima rodada automatica</td>
              <td>
                {automatica?.fim
                  ? `${formatDateTime(automatica.fim)} — ${automatica.analisadas} analisada(s), ${automatica.bloqueadas} bloqueada(s), ${automatica.erros} erro(s)${automatica.semOrcamento ? ", orcamento da hora esgotado" : ""}${automatica.erro ? ` (${automatica.erro})` : ""}`
                  : "-"}
              </td>
            </tr>
            <tr>
              <td>Travas</td>
              <td>
                ate {config.maxLeiturasPorColeta} leitura(s) por coleta; analisa conversa parada ha {config.minutosParado} min ou
                fechada, com {config.minMensagens} a {config.maxMensagens} mensagens
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
