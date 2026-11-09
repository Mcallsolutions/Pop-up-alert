import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import FilterBar, { describeFilters, emptyFilters } from "../../components/FilterBar";
import { api } from "../../services/api";
import { buildFileName, exportDocx, exportPdf } from "../../services/export";
import { formatDateTime, formatMinutes, formatTicketDateTime } from "../../services/datetime";
import { describeStandard, formatPercent, standardTone } from "../../services/standard";

// A inatividade vem do updatedAt do ticket, que nao diz quem estava esperando
// (cliente ou atendente): por isso "parado", e nao "sem resposta". De cada
// ticket vale a maior parada no periodo, com o atendente daquele momento.
const EXPORT_HEADERS = ["Cliente", "Fila", "Atendente", "Empresa", "Parado desde", "Maior parada", "URL"];
// A exportacao leva a lista inteira do recorte, nao so a pagina da tela.
const EXPORT_PAGE_SIZE = 1000;

export default function Inactivity() {
  const [filters, setFilters] = useState(emptyFilters);
  // Recorte da lista que esta na tela: trocar de pagina usa este, e nao o que
  // foi digitado na barra e ainda nao aplicado.
  const [applied, setApplied] = useState(emptyFilters);
  const [summary, setSummary] = useState(null);
  const [standard, setStandard] = useState(null);
  const [tickets, setTickets] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [attendants, setAttendants] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // fresh: o botao Atualizar pula o cache de relatorios da API.
  async function load(activeFilters = filters, targetPage = 1, { fresh = false } = {}) {
    const query = fresh ? { ...activeFilters, fresh: 1 } : activeFilters;
    setLoading(true);
    setError("");
    setApplied(activeFilters);
    try {
      const [summaryData, ticketData, attendantData, companyData, standardData] = await Promise.all([
        api.inactivitySummary(query),
        api.inactiveTickets({ ...query, page: targetPage }),
        api.inactivityByAttendant(query),
        api.inactivityByCompany(query),
        api.serviceStandard(query)
      ]);
      setSummary(summaryData);
      setTickets(ticketData.items || []);
      setPagination(ticketData.paginacao || null);
      setAttendants(attendantData.items || []);
      setCompanies(companyData.items || []);
      setStandard(standardData);
    } catch (requestError) {
      setError(requestError.message || "Falha ao carregar inatividade");
    } finally {
      setLoading(false);
    }
  }

  // So a lista muda de pagina; o resumo e os relatorios por atendente e por
  // empresa ficam.
  async function changePage(targetPage) {
    setLoading(true);
    setError("");
    try {
      const ticketData = await api.inactiveTickets({ ...applied, page: targetPage });
      setTickets(ticketData.items || []);
      setPagination(ticketData.paginacao || null);
    } catch (requestError) {
      setError(requestError.message || "Falha ao carregar a pagina");
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

  async function buildExportMeta() {
    const data = await api.inactiveTickets({ ...applied, pageSize: EXPORT_PAGE_SIZE });
    return {
      title: "Tickets parados",
      subtitle: [describeFilters(applied), `Limite: ${summary?.thresholdMinutes || 15} min`].join("  |  "),
      headers: EXPORT_HEADERS,
      rows: (data.items || []).map((ticket) => [
        ticket.clientName,
        ticket.queue,
        ticket.attendant || "-",
        ticket.company || "-",
        formatTicketDateTime(ticket),
        formatMinutes(ticket.inactivityMinutes),
        ticket.url || ""
      ])
    };
  }

  async function handleExportPdf() {
    try {
      await exportPdf({ ...(await buildExportMeta()), fileName: buildFileName("tickets-inativos", "pdf") });
    } catch (exportError) {
      setError(exportError.message || "Falha ao gerar o arquivo PDF");
    }
  }

  async function handleExportDocx() {
    try {
      await exportDocx({ ...(await buildExportMeta()), fileName: buildFileName("tickets-inativos", "docx") });
    } catch (exportError) {
      setError(exportError.message || "Falha ao gerar o arquivo DOCX");
    }
  }

  return (
    <section className="page-stack">
      <div className="section-toolbar">
        <div>
          <h2>Dashboard de inatividade</h2>
          <p>
            Tickets de clientes identificados que ficaram mais de {summary?.thresholdMinutes || 15} minutos sem nenhuma
            atividade no periodo (a maior parada de cada um).
          </p>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={loading}
          onClick={() => load(applied, pagination?.pagina || 1, { fresh: true })}
        >
          <RefreshCw aria-hidden="true" size={17} />
          Atualizar
        </button>
      </div>

      <FilterBar
        filters={filters}
        onChange={updateFilter}
        onApply={(activeFilters) => load(activeFilters)}
        onClear={clearFilters}
        onExportPdf={handleExportPdf}
        onExportDocx={handleExportDocx}
        exportDisabled={!pagination?.total}
      />

      {error ? <p className="notice error">{error}</p> : null}

      <div className="metric-grid">
        <Metric
          label="Padrao de atendimento"
          value={formatPercent(standard?.percent)}
          tone={standardTone(standard?.percent)}
        />
        <Metric label="Clientes inativos" value={summary?.inactiveTickets || 0} tone="warning" />
        <Metric label="Maior parada" value={formatMinutes(summary?.maxInactivityMinutes)} tone="danger" />
        <Metric label="Media das paradas" value={formatMinutes(summary?.averageInactivityMinutes)} />
        <Metric label="Limite" value={`${summary?.thresholdMinutes || 15} min`} />
        <Metric label="Ultima coleta" value={formatDateTime(summary?.lastCollectedAt)} compact />
      </div>

      <section className="table-panel">
        <h3>Tickets parados ({pagination?.total ?? tickets.length})</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Fila</th>
                <th>Atendente</th>
                <th>Empresa</th>
                <th>Parado desde</th>
                <th>Maior parada</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="6">Carregando...</td>
                </tr>
              ) : tickets.length ? (
                tickets.map((ticket) => (
                  <tr key={ticket.id}>
                    <td>{ticket.clientName}</td>
                    <td>{ticket.queue}</td>
                    <td>{ticket.attendant || "-"}</td>
                    <td>{ticket.company || "-"}</td>
                    <td>{formatTicketDateTime(ticket)}</td>
                    <td>{formatMinutes(ticket.inactivityMinutes)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="6">Nenhum cliente inativo encontrado.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {pagination && pagination.totalPaginas > 1 ? (
          <nav className="pagination" aria-label="Paginacao dos tickets parados">
            <button
              className="secondary-button"
              type="button"
              disabled={loading || pagination.pagina <= 1}
              onClick={() => changePage(pagination.pagina - 1)}
            >
              Anterior
            </button>
            <span>
              Pagina {pagination.pagina} de {pagination.totalPaginas} ({pagination.total}{" "}
              {pagination.total === 1 ? "cliente" : "clientes"})
            </span>
            <button
              className="secondary-button"
              type="button"
              disabled={loading || pagination.pagina >= pagination.totalPaginas}
              onClick={() => changePage(pagination.pagina + 1)}
            >
              Proxima
            </button>
          </nav>
        ) : null}
      </section>

      <StandardPanel standard={standard} />

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

// Padrao de atendimento por atendente: do pior para o melhor.
function StandardPanel({ standard }) {
  const rows = standard?.items || [];
  return (
    <section className="table-panel">
      <h3>Padrao de atendimento por atendente</h3>
      <p className="table-note">{describeStandard(standard)}</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Atendente</th>
              <th>Tickets</th>
              <th>Padrao</th>
              <th>Inatividade</th>
              <th>TAG</th>
              <th>Parados</th>
              <th>Sem TAG</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row) => (
                <tr key={row.attendant}>
                  <td>{row.attendant}</td>
                  <td>{row.tickets}</td>
                  <td>
                    <strong>{formatPercent(row.percent)}</strong>
                  </td>
                  <td>{formatPercent(row.inactivityPercent)}</td>
                  <td>{formatPercent(row.tagPercent)}</td>
                  <td>{row.inactiveTickets}</td>
                  <td>{row.withoutTag}</td>
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
              <th>Maior parada</th>
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
