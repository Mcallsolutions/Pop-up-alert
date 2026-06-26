import React, { useEffect, useState } from "react";
import { Download, Filter, RefreshCw } from "lucide-react";
import { api } from "../../services/api";

const emptyFilters = {
  startDate: "",
  endDate: "",
  attendant: "",
  queue: "",
  company: "",
  clientName: ""
};

export default function Reports() {
  const [filters, setFilters] = useState(emptyFilters);
  const [tickets, setTickets] = useState([]);
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

  function handleSubmit(event) {
    event.preventDefault();
    load(filters);
  }

  function clearFilters() {
    setFilters(emptyFilters);
    load(emptyFilters);
  }

  function exportCsv() {
    const headers = ["Cliente", "Fila", "Atendente", "Empresa", "Horario", "Coletado em", "URL"];
    const rows = tickets.map((ticket) => [
      ticket.clientName,
      ticket.queue,
      ticket.attendant,
      ticket.company,
      ticket.displayTime,
      ticket.collectedAt,
      ticket.url
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(";")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `tickets-sem-tag-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="page-stack">
      <div className="section-toolbar">
        <div>
          <h2>Tickets sem TAG</h2>
          <p>Consulte ocorrencias por periodo, atendente, fila, empresa ou cliente.</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => load()}>
          <RefreshCw aria-hidden="true" size={17} />
          Atualizar
        </button>
      </div>

      <form className="filters" onSubmit={handleSubmit}>
        <label>
          Data inicial
          <input type="datetime-local" value={filters.startDate} onChange={(event) => updateFilter("startDate", event.target.value)} />
        </label>
        <label>
          Data final
          <input type="datetime-local" value={filters.endDate} onChange={(event) => updateFilter("endDate", event.target.value)} />
        </label>
        <label>
          Atendente
          <input value={filters.attendant} onChange={(event) => updateFilter("attendant", event.target.value)} />
        </label>
        <label>
          Fila
          <input value={filters.queue} onChange={(event) => updateFilter("queue", event.target.value)} />
        </label>
        <label>
          Empresa
          <input value={filters.company} onChange={(event) => updateFilter("company", event.target.value)} />
        </label>
        <label>
          Cliente
          <input value={filters.clientName} onChange={(event) => updateFilter("clientName", event.target.value)} />
        </label>
        <div className="filter-actions">
          <button className="primary-button" type="submit">
            <Filter aria-hidden="true" size={17} />
            Filtrar
          </button>
          <button className="secondary-button" type="button" onClick={clearFilters}>
            Limpar
          </button>
          <button className="secondary-button" type="button" onClick={exportCsv} disabled={!tickets.length}>
            <Download aria-hidden="true" size={17} />
            CSV
          </button>
        </div>
      </form>

      {error ? <p className="notice error">{error}</p> : null}

      <section className="table-panel">
        <h3>Lista de tickets sem TAG</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Fila</th>
                <th>Atendente</th>
                <th>Empresa</th>
                <th>Horario</th>
                <th>Coleta</th>
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
                    <td>{ticket.clientName || "-"}</td>
                    <td>{ticket.queue || "-"}</td>
                    <td>{ticket.attendant || "-"}</td>
                    <td>{ticket.company || "-"}</td>
                    <td>{ticket.displayTime || "-"}</td>
                    <td>{formatDate(ticket.collectedAt)}</td>
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

function csvCell(value) {
  return `"${String(value || "").replace(/"/g, '""')}"`;
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
