import React, { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import FilterBar, { emptyFilters } from "../../components/FilterBar";
import { api } from "../../services/api";
import { buildFileName, exportDocx, exportPdf } from "../../services/export";
import { formatMinutes, formatTicketDateTime } from "../../services/datetime";

const EXPORT_HEADERS = ["Cliente", "Fila", "Atendente", "Empresa", "Horario do ticket", "Sem resposta (min)", "URL"];

export default function Reports() {
  const [filters, setFilters] = useState(emptyFilters);
  const [tickets, setTickets] = useState([]);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [waitingCount, setWaitingCount] = useState(0);
  const [attendants, setAttendants] = useState([]);
  const [queues, setQueues] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load(activeFilters = filters) {
    setLoading(true);
    setError("");
    try {
      const [missingData, attendantData, queueData] = await Promise.all([
        api.missingTags(activeFilters),
        api.byAttendant(activeFilters),
        api.byQueue(activeFilters)
      ]);
      setTickets(missingData.items || []);
      setHiddenCount(Number(missingData.incompletosOcultos || 0));
      setWaitingCount(Number(missingData.semAtendenteOcultos || 0));
      setAttendants(attendantData.items || []);
      setQueues(queueData.items || []);
    } catch (requestError) {
      setError(requestError.message || "Falha ao carregar relatorios");
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

  function buildExportRows() {
    return tickets.map((ticket) => [
      ticket.clientName,
      ticket.queue,
      ticket.attendant || "-",
      ticket.company || "-",
      formatTicketDateTime(ticket),
      ticket.inactivityMinutes ?? "",
      ticket.url || ""
    ]);
  }

  function buildExportMeta() {
    return {
      title: "Tickets sem TAG",
      subtitle: describeFilters(filters),
      headers: EXPORT_HEADERS,
      rows: buildExportRows()
    };
  }

  async function handleExportPdf() {
    try {
      await exportPdf({ ...buildExportMeta(), fileName: buildFileName("tickets-sem-tag", "pdf") });
    } catch (exportError) {
      setError(exportError.message || "Falha ao gerar o arquivo PDF");
    }
  }

  async function handleExportDocx() {
    try {
      await exportDocx({ ...buildExportMeta(), fileName: buildFileName("tickets-sem-tag", "docx") });
    } catch (exportError) {
      setError(exportError.message || "Falha ao gerar o arquivo DOCX");
    }
  }

  return (
    <section className="page-stack">
      <div className="section-toolbar">
        <div>
          <h2>Tickets sem TAG</h2>
          <p>Consulte ocorrencias por dia, atendente, fila, empresa ou cliente.</p>
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

      {hiddenCount ? (
        <p className="notice">
          {hiddenCount} {hiddenCount === 1 ? "registro foi ocultado" : "registros foram ocultados"}: a leitura do MTalk
          reconheceu apenas a fila, sem identificar o cliente.
        </p>
      ) : null}

      {waitingCount ? (
        <p className="notice">
          {waitingCount} {waitingCount === 1 ? "ticket sem TAG esta" : "tickets sem TAG estao"} aguardando na fila, sem
          atendente vinculado, e {waitingCount === 1 ? "ficou" : "ficaram"} fora desta lista: nao ha responsavel a quem
          cobrar a TAG. {waitingCount === 1 ? "Ele continua" : "Eles continuam"} no relatorio de inatividade.
        </p>
      ) : null}

      <section className="table-panel">
        <h3>Lista de tickets sem TAG ({tickets.length})</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Fila</th>
                <th>Atendente</th>
                <th>Empresa</th>
                <th>Horario do ticket</th>
                <th>Sem resposta</th>
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
                  <td colSpan="6">Nenhum ticket sem TAG encontrado.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="two-column">
        <MiniReport title="Falhas por atendente" rows={attendants} labelKey="attendant" />
        <MiniReport title="Falhas por fila" rows={queues} labelKey="queue" />
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
              <th>Total</th>
              <th>Sem TAG</th>
              <th>Falha</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row) => (
                <tr key={row[labelKey]}>
                  <td>{row[labelKey]}</td>
                  <td>{row.totalTickets}</td>
                  <td>{row.totalWithoutTag}</td>
                  <td>{row.failurePercent}%</td>
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
