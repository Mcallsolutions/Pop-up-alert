import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../../services/api";

export default function Dashboard() {
  const [summary, setSummary] = useState(null);
  const [attendants, setAttendants] = useState([]);
  const [queues, setQueues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [summaryData, attendantData, queueData] = await Promise.all([
        api.summary(),
        api.byAttendant(),
        api.byQueue()
      ]);
      setSummary(summaryData);
      setAttendants(attendantData.items || []);
      setQueues(queueData.items || []);
    } catch (requestError) {
      setError(requestError.message || "Falha ao carregar dashboard");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <section className="page-stack">
      <div className="section-toolbar">
        <div>
          <h2>Resumo geral</h2>
          <p>Indicadores consolidados das leituras recebidas pela API.</p>
        </div>
        <button className="secondary-button" type="button" onClick={load}>
          <RefreshCw aria-hidden="true" size={17} />
          Atualizar
        </button>
      </div>

      {error ? <p className="notice error">{error}</p> : null}

      <div className="metric-grid">
        <Metric label="Tickets analisados" value={summary?.totalTicketsProcessed || 0} />
        <Metric label="Tickets com TAG" value={summary?.totalWithTag || 0} />
        <Metric label="Tickets sem TAG" value={summary?.totalWithoutTag || 0} tone="danger" />
        <Metric label="Inativos +15 min" value={summary?.totalInactive || 0} tone="warning" />
        <Metric label="Conformidade" value={`${summary?.compliancePercent || 0}%`} tone="success" />
        <Metric label="Leituras recebidas" value={summary?.totalReadings || 0} />
        <Metric label="Ultima atualizacao" value={formatDate(summary?.lastCollectedAt)} compact />
      </div>

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

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(date);
}
