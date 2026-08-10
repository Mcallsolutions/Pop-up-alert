import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import FilterBar, { emptyFilters } from "../../components/FilterBar";
import { api } from "../../services/api";
import { buildFileName, exportDocx, exportPdf } from "../../services/export";

const EXPORT_HEADERS = ["Cliente", "Fila", "Atendente", "Empresa", "Horario", "Minutos sem resposta", "Coletado em", "URL"];

export default function Inactivity() {
  const [filters, setFilters] = useState(emptyFilters);
  const [summary, setSummary] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [attendants, setAttendants] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load(activeFilters = filters) {
    setLoading(true);
    setError("");
    try {
      const [summaryData, ticketData, attendantData, companyData] = await Promise.all([
        api.inactivitySummary(activeFilters),
        api.inactiveTickets(activeFilters),
        api.inactivityByAttendant(activeFilters),
        api.inactivityByCompany(activeFilters)
      ]);
      setSummary(summaryData);
      setTickets(ticketData.items || []);
      setAttendants(attendantData.items || []);
      setCompanies(companyData.items || []);
    } catch (requestError) {
      setError(requestError.message || "Falha ao carregar inatividade");
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

  function clearFilters() {
    setFilters(emptyFilters);
    load(emptyFilters);
  }

  function buildExportMeta() {
    return {
      title: "Clientes sem resposta",
      subtitle: [describeFilters(filters), `Limite: ${summary?.thresholdMinutes || 15} min`].join("  |  "),
      headers: EXPORT_HEADERS,
      rows: tickets.map((ticket) => [
        ticket.clientName,
        ticket.queue,
        ticket.attendant || "-",
        ticket.company || "-",
        ticket.displayTime || "-",
        ticket.inactivityMinutes ?? "",
        formatDate(ticket.collectedAt),
        ticket.url || ""
      ])
    };
  }

  async function handleExportPdf() {
    try {
      await exportPdf({ ...buildExportMeta(), fileName: buildFileName("tickets-inativos", "pdf") });
    } catch (exportError) {
      setError(exportError.message || "Falha ao gerar o arquivo PDF");
    }
  }

  async function handleExportDocx() {
    try {
      await exportDocx({ ...buildExportMeta(), fileName: buildFileName("tickets-inativos", "docx") });
    } catch (exportError) {
      setError(exportError.message || "Falha ao gerar o arquivo DOCX");
    }
  }

  return (
    <section className="page-stack">
      <div className="section-toolbar">
        <div>
          <h2>Dashboard de inatividade</h2>
          <p>Clientes identificados sem resposta ha mais de {summary?.thresholdMinutes || 15} minutos.</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => load()}>
          <RefreshCw aria-hidden="true" size={17} />
          Atualizar
        </button>
      </div>

      <FilterBar
        filters={filters}
        onChange={updateFilter}
        onApply={load}
        onClear={clearFilters}
        onExportPdf={handleExportPdf}
        onExportDocx={handleExportDocx}
        exportDisabled={!tickets.length}
      />

      {error ? <p className="notice error">{error}</p> : null}

      <div className="metric-grid">
        <Metric label="Clientes inativos" value={summary?.inactiveTickets || 0} tone="warning" />
        <Metric label="Maior espera" value={formatMinutes(summary?.maxInactivityMinutes)} tone="danger" />
        <Metric label="Media de espera" value={formatMinutes(summary?.averageInactivityMinutes)} />
        <Metric label="Limite" value={`${summary?.thresholdMinutes || 15} min`} />
        <Metric label="Ultima coleta" value={formatDate(summary?.lastCollectedAt)} compact />
      </div>

      <section className="table-panel">
        <h3>Clientes sem resposta</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Fila</th>
                <th>Atendente</th>
                <th>Empresa</th>
                <th>Horario</th>
                <th>Sem resposta</th>
                <th>Coleta</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="7">Carregando...</td>
                </tr>
              ) : tickets.length ? (
                tickets.map((ticket) => (
                  <tr key={ticket.id}>
                    <td>{ticket.clientName}</td>
                    <td>{ticket.queue}</td>
                    <td>{ticket.attendant || "-"}</td>
                    <td>{ticket.company || "-"}</td>
                    <td>{ticket.displayTime || "-"}</td>
                    <td>{formatMinutes(ticket.inactivityMinutes)}</td>
                    <td>{formatDate(ticket.collectedAt)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="7">Nenhum cliente inativo encontrado.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="two-column">
        <MiniReport title="Inatividade por atendente" rows={attendants} labelKey="attendant" />
        <MiniReport title="Inatividade por empresa" rows={companies} labelKey="company" />
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

function MiniReport({ title, rows, labelKey }) {
  return (
    <section className="table-panel">
      <h3>{title}</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>Inativos</th>
              <th>Maior espera</th>
              <th>Media</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row) => (
                <tr key={row[labelKey] || "sem-identificacao"}>
                  <td>{row[labelKey] || "-"}</td>
                  <td>{row.inactiveTickets}</td>
                  <td>{formatMinutes(row.maxInactivityMinutes)}</td>
                  <td>{formatMinutes(row.averageInactivityMinutes)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan="4">Sem dados.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Resume os filtros ativos para aparecer no cabecalho do PDF/DOCX exportado.
function describeFilters(filters) {
  const labels = {
    day: "Dia",
    attendant: "Atendente",
    company: "Empresa",
    queue: "Fila",
    clientName: "Cliente"
  };
  const active = Object.entries(labels)
    .filter(([key]) => String(filters[key] || "").trim())
    .map(([key, label]) => `${label}: ${filters[key]}`);
  return active.length ? active.join("  |  ") : "Sem filtros aplicados";
}

function formatMinutes(value) {
  const minutes = Number(value || 0);
  return minutes ? `${minutes} min` : "-";
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
