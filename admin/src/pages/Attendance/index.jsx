import { useEffect, useState } from "react";
import { AlertTriangle, Headset, RefreshCw, RotateCw, ShieldAlert, X } from "lucide-react";
import FilterBar, { emptyFilters } from "../../components/FilterBar";
import { api } from "../../services/api";
import { buildFileName, exportDocx, exportPdf } from "../../services/export";
import { formatDateTime, formatMinutes } from "../../services/datetime";

// Analise de atendimento por IA. Tudo o que aparece aqui ja foi mascarado na
// entrada ([CPF], [ENDERECO], ...): a transcricao nunca traz o texto original.
// O nome do cliente vem da coleta de tickets e so existe no painel — ele nao
// vai para a IA.

const emptyExtra = { riscoCancelamento: "", sentimentoCliente: "", notaMax: "" };

const SENTIMENTOS = { POSITIVO: "Positivo", NEUTRO: "Neutro", NEGATIVO: "Negativo", MUITO_NEGATIVO: "Muito negativo" };
const RISCOS = { BAIXO: "Baixo", MEDIO: "Medio", ALTO: "Alto" };
const RESOLVIDO = { SIM: "Sim", NAO: "Nao", INCERTO: "Incerto" };
const ASSUNTOS = {
  SUPORTE_TECNICO: "Suporte tecnico",
  FINANCEIRO: "Financeiro",
  COMERCIAL: "Comercial",
  CANCELAMENTO: "Cancelamento",
  INSTALACAO_OU_VISITA: "Instalacao ou visita",
  RECLAMACAO: "Reclamacao",
  OUTRO: "Outro"
};
const AUTORES = { CLIENTE: "Cliente", ATENDENTE: "Atendente", EMPRESA: "Empresa", AUTOMATICA: "Automatica" };
const ALERTAS = {
  CLIENTE_AGUARDANDO: "Cliente aguardando resposta",
  CANCELAMENTO: "Pedido de cancelamento",
  ORGAO_EXTERNO: "Orgao externo citado",
  ANALISE_BLOQUEADA: "Analise bloqueada: dado pessoal no envio",
  RISCO_CANCELAMENTO: "Risco de cancelamento",
  INFORMACAO_INCORRETA: "Informacao incorreta",
  LINGUAGEM_INADEQUADA: "Linguagem inadequada",
  PROMESSA_SEM_PRAZO: "Promessa sem prazo",
  DADO_SENSIVEL_EXPOSTO: "Dado sensivel exposto",
  TENTATIVA_DE_MANIPULACAO: "Tentativa de manipulacao",
  OUTRO: "Outro"
};
const RISCO_BADGE = { BAIXO: "risco-baixo", MEDIO: "risco-medio", ALTO: "risco-alto" };

const EXPORT_HEADERS = [
  "Data",
  "Cliente",
  "Atendente",
  "Fila",
  "Nota",
  "Sentimento",
  "Risco",
  "Resolvido",
  "Assunto",
  "1a resposta",
  "Maior espera do cliente",
  "Resumo"
];

export default function AttendancePage() {
  const [filters, setFilters] = useState(emptyFilters);
  const [extra, setExtra] = useState(emptyExtra);
  const [status, setStatus] = useState(null);
  const [analyses, setAnalyses] = useState([]);
  const [totais, setTotais] = useState(null);
  const [attendants, setAttendants] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");

  async function load(activeFilters = filters, activeExtra = extra) {
    const query = { ...activeFilters, ...activeExtra };
    setLoading(true);
    setError("");
    try {
      const [statusData, analysisData, attendantData] = await Promise.all([
        api.attendanceStatus(),
        api.attendanceAnalyses(query),
        api.attendanceByAttendant(query)
      ]);
      setStatus(statusData);
      setAnalyses(analysisData.items || []);
      setTotais(analysisData.totais || null);
      setAttendants(attendantData.items || []);
    } catch (requestError) {
      setError(requestError.message || "Falha ao carregar as analises de atendimento");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function updateFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function updateExtra(key, value) {
    const next = { ...extra, [key]: value };
    setExtra(next);
    load(filters, next);
  }

  function clearFilters() {
    setFilters(emptyFilters);
    setExtra(emptyExtra);
    load(emptyFilters, emptyExtra);
  }

  async function openDetail(id) {
    setDetailLoading(true);
    setError("");
    setFeedback("");
    try {
      setSelected(await api.attendanceAnalysis(id));
    } catch (requestError) {
      setError(requestError.message || "Falha ao abrir a analise");
    } finally {
      setDetailLoading(false);
    }
  }

  async function reanalyze() {
    if (!selected) return;
    setAnalyzing(true);
    setError("");
    setFeedback("");
    try {
      const created = await api.analyzeTicket(selected.ticketId);
      setSelected(created);
      setFeedback(
        created.status === "BLOQUEADA"
          ? "A verificacao final encontrou dado pessoal no que seria enviado: nada foi mandado para a IA."
          : "Analise gerada com sucesso."
      );
      await load();
    } catch (requestError) {
      setError(requestError.message || "Falha ao analisar o atendimento");
    } finally {
      setAnalyzing(false);
    }
  }

  function buildExportMeta() {
    return {
      title: "Analise de atendimento (IA)",
      subtitle: describeFilters({ ...filters, ...extra }),
      headers: EXPORT_HEADERS,
      rows: analyses.map((item) => [
        formatDateTime(item.createdAt),
        item.clientName || "-",
        item.attendant || "-",
        item.queue || "-",
        item.status === "BLOQUEADA" ? "Bloqueada" : item.content?.nota ?? "-",
        SENTIMENTOS[item.content?.sentimentoCliente] || "-",
        RISCOS[item.content?.riscoCancelamento] || "-",
        RESOLVIDO[item.content?.resolvido] || "-",
        ASSUNTOS[item.content?.assunto] || "-",
        formatMinutes(item.metrics?.primeiraRespostaMinutos),
        formatMinutes(item.metrics?.maiorEsperaClienteMinutos),
        item.content?.resumo || ""
      ])
    };
  }

  async function handleExportPdf() {
    try {
      await exportPdf({ ...buildExportMeta(), fileName: buildFileName("analise-atendimento", "pdf") });
    } catch (exportError) {
      setError(exportError.message || "Falha ao gerar o arquivo PDF");
    }
  }

  async function handleExportDocx() {
    try {
      await exportDocx({ ...buildExportMeta(), fileName: buildFileName("analise-atendimento", "docx") });
    } catch (exportError) {
      setError(exportError.message || "Falha ao gerar o arquivo DOCX");
    }
  }

  return (
    <section className="page-stack">
      <div className="section-toolbar">
        <div>
          <h2>Analise de atendimento</h2>
          <p>Avaliacao de cada conversa pela IA, com os dados pessoais trocados por marcadores antes de qualquer gravacao.</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => load()}>
          <RefreshCw aria-hidden="true" size={17} />
          Atualizar
        </button>
      </div>

      <StatusNotice status={status} />

      <FilterBar
        filters={filters}
        onChange={updateFilter}
        onApply={() => load()}
        onClear={clearFilters}
        onExportPdf={handleExportPdf}
        onExportDocx={handleExportDocx}
        exportDisabled={!analyses.length}
      />

      <div className="filters attendance-filters">
        <label>
          Risco de cancelamento
          <select value={extra.riscoCancelamento} onChange={(event) => updateExtra("riscoCancelamento", event.target.value)}>
            <option value="">Todos</option>
            {Object.entries(RISCOS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sentimento do cliente
          <select value={extra.sentimentoCliente} onChange={(event) => updateExtra("sentimentoCliente", event.target.value)}>
            <option value="">Todos</option>
            {Object.entries(SENTIMENTOS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Nota ate
          <select value={extra.notaMax} onChange={(event) => updateExtra("notaMax", event.target.value)}>
            <option value="">Todas</option>
            {[1, 2, 3, 4].map((nota) => (
              <option key={nota} value={nota}>
                {nota}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? <p className="notice error">{error}</p> : null}
      {feedback ? <p className="notice success">{feedback}</p> : null}

      <div className="metric-grid">
        <Metric label="Analisadas" value={totais?.analisadas ?? 0} />
        <Metric label="Nota media" value={totais?.notaMedia ?? "-"} tone="success" />
        <Metric label="Sentimento negativo" value={`${totais?.percentNegativo ?? 0}%`} tone="warning" />
        <Metric label="Risco alto" value={totais?.riscoAlto ?? 0} tone="danger" />
        <Metric label="Orgao externo" value={totais?.orgaoExterno ?? 0} tone="danger" />
        <Metric label="1a resposta media" value={formatMinutes(totais?.primeiraRespostaMedia)} />
      </div>

      {detailLoading ? <p className="notice">Carregando analise...</p> : null}
      {selected ? (
        <AnalysisDetail analysis={selected} analyzing={analyzing} onReanalyze={reanalyze} onClose={() => setSelected(null)} />
      ) : null}

      <section className="table-panel">
        <h3>Analises</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Cliente</th>
                <th>Atendente</th>
                <th>Fila</th>
                <th>Nota</th>
                <th>Sentimento</th>
                <th>Risco</th>
                <th>Resolvido</th>
                <th>Alertas</th>
                <th>Acao</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="10">Carregando...</td>
                </tr>
              ) : analyses.length ? (
                analyses.map((item) => (
                  <tr key={item.id}>
                    <td>{formatDateTime(item.createdAt)}</td>
                    <td>{item.clientName || "-"}</td>
                    <td>{item.attendant || "-"}</td>
                    <td>{item.queue || "-"}</td>
                    <td>{item.status === "BLOQUEADA" ? <span className="badge">Bloqueada</span> : item.content?.nota ?? "-"}</td>
                    <td>{SENTIMENTOS[item.content?.sentimentoCliente] || "-"}</td>
                    <td>
                      {item.content?.riscoCancelamento ? (
                        <span className={`badge ${RISCO_BADGE[item.content.riscoCancelamento] || ""}`}>
                          {RISCOS[item.content.riscoCancelamento]}
                        </span>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td>{RESOLVIDO[item.content?.resolvido] || "-"}</td>
                    <td>{countAlerts(item) || "-"}</td>
                    <td>
                      <button className="link-button" type="button" onClick={() => openDetail(item.id)}>
                        Ver
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="10">Nenhuma analise encontrada para este recorte.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="table-panel">
        <h3>Por atendente</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Atendente</th>
                <th>Analisadas</th>
                <th>Nota media</th>
                <th>Sentimento negativo</th>
                <th>1a resposta media</th>
                <th>Risco alto</th>
                <th>Orgao externo</th>
              </tr>
            </thead>
            <tbody>
              {attendants.length ? (
                attendants.map((row) => (
                  <tr key={row.attendant}>
                    <td>{row.attendant}</td>
                    <td>{row.analisadas}</td>
                    <td>{row.notaMedia ?? "-"}</td>
                    <td>{row.percentNegativo}%</td>
                    <td>{formatMinutes(row.primeiraRespostaMedia)}</td>
                    <td>{row.riscoAlto}</td>
                    <td>{row.orgaoExterno}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="7">Sem dados.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

function StatusNotice({ status }) {
  if (!status) return null;

  if (!status.ligada) {
    return (
      <p className="notice warning">
        A analise esta desligada: nenhuma mensagem e lida do MTalk. Para ligar, defina AI_ATTENDANCE_ANALYSIS=1 no .env da API e
        reinicie. As analises ja gravadas continuam aqui ate a retencao apagar.
      </p>
    );
  }

  if (!status.openaiConfigurado) {
    return (
      <p className="notice warning">
        A leitura das mensagens esta ligada, mas OPENAI_API_KEY nao esta configurada: nenhuma conversa e analisada.
      </p>
    );
  }

  const ultima = status.leitura?.ultima;
  return (
    <p className="notice success">
      <Headset aria-hidden="true" size={16} /> Ligada — {status.orcamentoHora?.usadas ?? 0} de {status.orcamentoHora?.limite ?? 0}{" "}
      analises usadas na ultima hora, {status.mensagensNoBanco} mensagens mascaradas no banco
      {ultima?.fim ? `, ultima leitura ${formatDateTime(ultima.fim)}${ultima.ok ? "" : ` (falhou: ${ultima.erro})`}` : ""}.
    </p>
  );
}

function AnalysisDetail({ analysis, analyzing, onReanalyze, onClose }) {
  const content = analysis.content || {};
  const metrics = analysis.metrics || {};
  const bloqueada = analysis.status === "BLOQUEADA";
  const alertas = [
    ...(analysis.systemAlerts || []).map((alerta) => ({ ...alerta, origem: "Sistema", descricao: describeSystemAlert(alerta) })),
    ...(content.alertas || []).map((alerta) => ({ ...alerta, origem: "IA" }))
  ];

  return (
    <section className="table-panel ai-summary attendance-detail">
      <h3>
        <Headset aria-hidden="true" size={17} />
        Atendimento de {analysis.clientName || `ticket ${analysis.ticketId}`}
      </h3>

      <div className="ai-summary-body">
        <div className="ai-meta">
          <span>Analisado em {formatDateTime(analysis.createdAt)}</span>
          <span>Atendente: {analysis.attendant || "-"}</span>
          <span>Fila: {analysis.queue || "-"}</span>
          <span>{analysis.trigger === "MANUAL" ? `Manual (${analysis.createdBy || "-"})` : "Automatica"}</span>
          {analysis.model ? <span>Modelo: {analysis.model}</span> : null}
          {analysis.usage?.totalTokens ? <span>{analysis.usage.totalTokens} tokens</span> : null}
          <span>{analysis.messageCount} mensagens{metrics.truncada ? " (janela cortada)" : ""}</span>
        </div>

        <div className="filter-actions">
          <button className="primary-button" type="button" onClick={onReanalyze} disabled={analyzing}>
            <RotateCw aria-hidden="true" size={17} />
            {analyzing ? "Analisando..." : "Analisar de novo"}
          </button>
          <button className="secondary-button" type="button" onClick={onClose}>
            <X aria-hidden="true" size={17} />
            Fechar
          </button>
        </div>

        {bloqueada ? (
          <p className="notice warning ai-stale">
            <ShieldAlert aria-hidden="true" size={16} /> A verificacao final encontrou dado pessoal no que seria enviado. Nada foi
            mandado para a IA; o registro guarda so o tipo e a quantidade.
          </p>
        ) : (
          <>
            <div className="attendance-badges">
              <span className="badge">Nota {content.nota ?? "-"}</span>
              <span className="badge">Sentimento: {SENTIMENTOS[content.sentimentoCliente] || "-"}</span>
              <span className={`badge ${RISCO_BADGE[content.riscoCancelamento] || ""}`}>
                Risco {RISCOS[content.riscoCancelamento] || "-"}
              </span>
              <span className="badge">Resolvido: {RESOLVIDO[content.resolvido] || "-"}</span>
              <span className="badge">{ASSUNTOS[content.assunto] || "-"}</span>
              {content.mencionaOrgaoExterno ? <span className="badge risco-alto">Orgao externo</span> : null}
            </div>
            <p className="ai-text">{content.resumo || "A IA nao devolveu o resumo."}</p>
            <ListBlock title="Pontos positivos" items={content.pontosPositivos} />
            <ListBlock title="Pontos de melhoria" items={content.pontosDeMelhoria} />
          </>
        )}

        {alertas.length ? (
          <div className="ai-block">
            <h4>Alertas</h4>
            <ul>
              {alertas.map((alerta, index) => (
                <li key={`${alerta.tipo}-${index}`}>
                  <strong>{ALERTAS[alerta.tipo] || alerta.tipo}</strong> ({alerta.origem})
                  {alerta.descricao ? ` — ${alerta.descricao}` : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="ai-block">
          <h4>Metricas (calculadas pelo sistema)</h4>
          <dl className="attendance-metrics">
            <Stat label="1a resposta" value={formatMinutes(metrics.primeiraRespostaMinutos)} />
            <Stat label="Tempo medio de resposta" value={formatMinutes(metrics.tempoMedioRespostaMinutos)} />
            <Stat label="Maior espera do cliente" value={formatMinutes(metrics.maiorEsperaClienteMinutos)} />
            <Stat label="Maior espera pelo cliente" value={formatMinutes(metrics.maiorEsperaAtendenteMinutos)} />
            <Stat label="Duracao" value={formatMinutes(metrics.duracaoMinutos)} />
            <Stat
              label="Mensagens"
              value={`${metrics.mensagensCliente ?? 0} cliente, ${metrics.mensagensAtendente ?? 0} atendente, ${
                metrics.mensagensEmpresa ?? 0
              } empresa, ${metrics.mensagensAutomaticas ?? 0} automaticas`}
            />
            <Stat label="Transferencia" value={metrics.teveTransferencia ? "Sim" : "Nao"} />
          </dl>
        </div>

        <div className="ai-block">
          <h4>Conversa (mascarada)</h4>
          {analysis.transcricaoExpirada ? (
            <p className="ai-empty">As mensagens desta janela ja foram apagadas pela retencao; a analise continua valendo.</p>
          ) : (
            <ol className="transcript">
              {(analysis.transcricao || []).map((item) => (
                <li
                  key={item.id}
                  className={`transcript-item ${String(item.autor || "").toLowerCase()}${item.evidencia ? " evidence" : ""}`}
                >
                  <div className="transcript-meta">
                    <span>{AUTORES[item.autor] || item.autor}</span>
                    {item.autor !== "CLIENTE" && item.atendente ? <span>{item.atendente}</span> : null}
                    <span>min {item.minuto ?? "-"}</span>
                    {item.editada ? <span>editada</span> : null}
                    {(item.sinais || []).map((sinal) => (
                      <span key={sinal} className="badge risco-alto">
                        {ALERTAS[sinal] || sinal}
                      </span>
                    ))}
                  </div>
                  <p>{item.apagada ? <em>Mensagem apagada</em> : item.texto || <em>(sem texto)</em>}</p>
                  {item.evidencia ? (
                    <small>
                      <AlertTriangle aria-hidden="true" size={13} /> Evidencia: {item.evidencia.motivo || "citada pela IA"}
                    </small>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}

function ListBlock({ title, items }) {
  const rows = (items || []).filter((item) => String(item || "").trim());
  if (!rows.length) return null;
  return (
    <div className="ai-block">
      <h4>{title}</h4>
      <ul>
        {rows.map((row, index) => (
          <li key={`${title}-${index}`}>{row}</li>
        ))}
      </ul>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Metric({ label, value, tone = "default" }) {
  return (
    <article className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function countAlerts(item) {
  return (item.systemAlerts?.length || 0) + (item.content?.alertas?.length || 0);
}

function describeSystemAlert(alerta) {
  if (alerta.tipo === "CLIENTE_AGUARDANDO") {
    return `${alerta.minutos} min sem resposta humana${alerta.emAberto ? " (ainda aguardando no fim da janela)" : ""}`;
  }
  if (alerta.tipo === "ANALISE_BLOQUEADA") {
    return Object.entries(alerta.tipos || {})
      .map(([tipo, total]) => `${tipo}: ${total}`)
      .join(", ");
  }
  if (Array.isArray(alerta.mensagens)) {
    return `${alerta.mensagens.length} mensagem(ns) do cliente`;
  }
  return "";
}

function describeFilters(filters) {
  const labels = {
    day: "Dia",
    attendant: "Atendente",
    company: "Empresa",
    queue: "Fila",
    clientName: "Cliente",
    riscoCancelamento: "Risco",
    sentimentoCliente: "Sentimento",
    notaMax: "Nota ate"
  };
  const active = Object.entries(labels)
    .filter(([key]) => String(filters[key] || "").trim())
    .map(([key, label]) => `${label}: ${filters[key]}`);
  return active.length ? active.join("  |  ") : "Sem filtros aplicados";
}
