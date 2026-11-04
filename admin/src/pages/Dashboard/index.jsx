import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import FilterBar, { emptyFilters } from "../../components/FilterBar";
import AiSummaryCard from "../../components/AiSummaryCard";
import { api } from "../../services/api";
import { formatDateTime, formatTime } from "../../services/datetime";
import { readPageCache, writePageCache } from "../../services/page-cache";

// O Dashboard se atualiza sozinho a cada 15 minutos enquanto estiver aberto. A
// atualizacao automatica e o botao "Atualizar" pedem dados novos (fresh), sem o
// cache de relatorios da API; abrir a pagina aproveita o que ja esta guardado.
const AUTO_REFRESH_MS = 15 * 60 * 1000;
const CACHE_NAME = "dashboard";

export default function Dashboard() {
  // Volta ao Dashboard com os mesmos filtros e numeros, na hora. Se o que esta
  // guardado ja passou dos 15 minutos, a atualizacao roda logo depois de abrir.
  const [cached] = useState(() => readPageCache(CACHE_NAME));
  const [filters, setFilters] = useState(cached?.filters || emptyFilters);
  const [applied, setApplied] = useState(cached?.filters || emptyFilters);
  const [summary, setSummary] = useState(cached?.data.summary || null);
  const [attendants, setAttendants] = useState(cached?.data.attendants || []);
  const [queues, setQueues] = useState(cached?.data.queues || []);
  const [aiSummary, setAiSummary] = useState(cached?.data.aiSummary || null);
  const [loadedAt, setLoadedAt] = useState(cached?.loadedAt || 0);
  // Ultima tentativa, com ou sem sucesso: a proxima atualizacao conta dela, para
  // a API fora do ar nao virar uma tentativa por segundo.
  const [attemptedAt, setAttemptedAt] = useState(cached?.loadedAt || 0);
  const [loading, setLoading] = useState(!cached);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  // So a consulta mais recente escreve na tela: uma atualizacao automatica que
  // termina depois de um "Aplicar" nao pode trazer de volta o recorte antigo.
  const requestRef = useRef(0);

  // background: atualiza sem trocar as tabelas por "Carregando...".
  async function load(activeFilters = filters, { fresh = false, background = false } = {}) {
    const requestId = ++requestRef.current;
    const query = fresh ? { ...activeFilters, fresh: 1 } : activeFilters;
    setApplied(activeFilters);
    setError("");
    if (background) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      // O resumo da IA e apenas leitura aqui: quem gera um novo e a pagina "IA".
      // Uma falha nele nao pode derrubar o dashboard inteiro.
      const [summaryData, attendantData, queueData, aiSummaryData] = await Promise.all([
        api.summary(query),
        api.byAttendant(query),
        api.byQueue(query),
        api.latestAiSummary().catch(() => null)
      ]);
      if (requestId !== requestRef.current) return;

      const data = {
        summary: summaryData,
        attendants: attendantData.items || [],
        queues: queueData.items || [],
        aiSummary: aiSummaryData
      };
      const now = Date.now();
      setSummary(data.summary);
      setAttendants(data.attendants);
      setQueues(data.queues);
      setAiSummary(data.aiSummary);
      setLoadedAt(now);
      writePageCache(CACHE_NAME, { filters: activeFilters, data, loadedAt: now });
    } catch (requestError) {
      if (requestId !== requestRef.current) return;
      setError(requestError.message || "Falha ao carregar dashboard");
    } finally {
      if (requestId === requestRef.current) {
        setAttemptedAt(Date.now());
        setLoading(false);
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    if (!cached) {
      load(emptyFilters);
    }
  }, []);

  // Agenda a proxima atualizacao a partir da ultima tentativa. Com a aba do
  // navegador em segundo plano o timer pode atrasar um pouco, mas dispara.
  useEffect(() => {
    if (!attemptedAt) return undefined;
    const delay = Math.max(attemptedAt + AUTO_REFRESH_MS - Date.now(), 0);
    const timer = window.setTimeout(() => load(applied, { fresh: true, background: true }), delay);
    return () => window.clearTimeout(timer);
  }, [attemptedAt]);

  function updateFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function clearFilters() {
    setFilters(emptyFilters);
    load(emptyFilters);
  }

  const busy = loading || refreshing;

  return (
    <section className="page-stack">
      <div className="section-toolbar">
        <div>
          <h2>Resumo geral</h2>
          <p>Indicadores consolidados das leituras recebidas pela API.</p>
          <p className="refresh-status" role="status">
            {refreshing
              ? "Atualizando..."
              : loadedAt
                ? `Atualizado as ${formatTime(loadedAt)}. Atualiza sozinho a cada 15 min (proxima as ${formatTime(
                    attemptedAt + AUTO_REFRESH_MS
                  )}).`
                : "Atualiza sozinho a cada 15 min."}
          </p>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={() => load(applied, { fresh: true, background: Boolean(loadedAt) })}
        >
          <RefreshCw aria-hidden="true" size={17} className={refreshing ? "spin" : undefined} />
          {refreshing ? "Atualizando..." : "Atualizar"}
        </button>
      </div>

      <FilterBar filters={filters} onChange={updateFilter} onApply={load} onClear={clearFilters} />

      {error ? <p className="notice error">{error}</p> : null}

      <div className="metric-grid">
        <Metric label="Tickets analisados" value={summary?.totalTicketsProcessed || 0} />
        <Metric label="Tickets com TAG" value={summary?.totalWithTag || 0} />
        <Metric label="Tickets sem TAG" value={summary?.totalWithoutTag || 0} tone="danger" />
        <Metric label="Aguardando atendente" value={summary?.totalWithoutAttendant || 0} />
        <Metric
          label={`Inativos +${summary?.thresholdMinutes || 15} min`}
          value={summary?.totalInactive || 0}
          tone="warning"
        />
        <Metric label="Conformidade" value={`${summary?.compliancePercent || 0}%`} tone="success" />
        <Metric label="Leituras recebidas" value={summary?.totalReadings || 0} />
        <Metric label="Ultima coleta" value={formatDateTime(summary?.lastCollectedAt)} compact />
      </div>

      <AiSummaryCard
        summary={aiSummary}
        emptyMessage="Nenhum resumo gerado ainda. Abra a aba IA para gerar o primeiro."
      />

      <div className="two-column">
        <ReportTable title="Por atendente" rows={attendants} labelKey="attendant" loading={loading} />
        <ReportTable title="Por fila" rows={queues} labelKey="queue" loading={loading} />
      </div>
    </section>
  );
}

function Metric({ label, value, tone = "default", compact = false }) {
  return (
    <article className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong className={compact ? "compact" : ""}>{value}</strong>
    </article>
  );
}

function ReportTable({ title, rows, labelKey, loading }) {
  return (
    <section className="table-panel">
      <h3>{title}</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>Total</th>
              <th>Sem TAG</th>
              <th>Falha</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan="4">Carregando...</td>
              </tr>
            ) : rows.length ? (
              rows.slice(0, 8).map((row) => (
                <tr key={row[labelKey]}>
                  <td>{row[labelKey]}</td>
                  <td>{row.totalTickets}</td>
                  <td>{row.totalWithoutTag}</td>
                  <td>{row.failurePercent}%</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan="4">Sem dados recebidos.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
