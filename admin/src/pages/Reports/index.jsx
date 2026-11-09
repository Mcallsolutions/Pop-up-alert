import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import FilterBar, { describeFilters, emptyFilters } from "../../components/FilterBar";
import MiniReport, { tagColumns } from "../../components/MiniReport";
import Pagination from "../../components/Pagination";
import { api } from "../../services/api";
import { buildFileName, exportDocx, exportPdf } from "../../services/export";
import { formatDateTime, formatMinutes, formatTicketDateTime } from "../../services/datetime";

const EXPORT_HEADERS = ["Cliente", "Fila", "Atendente", "Empresa", "Horario do ticket", "Sem resposta", "URL"];
// A exportacao leva a lista inteira do recorte, nao so a pagina da tela.
const EXPORT_PAGE_SIZE = 1000;

export default function Reports() {
  const [filters, setFilters] = useState(emptyFilters);
  // Recorte da lista que esta na tela: trocar de pagina usa este, e nao o que
  // foi digitado na barra e ainda nao aplicado.
  const [applied, setApplied] = useState(emptyFilters);
  const [tickets, setTickets] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [cleanup, setCleanup] = useState(null);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [waitingCount, setWaitingCount] = useState(0);
  const [attendants, setAttendants] = useState([]);
  const [queues, setQueues] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // fresh: o botao Atualizar pula o cache de relatorios da API.
  async function load(activeFilters = filters, targetPage = 1, { fresh = false } = {}) {
    const query = fresh ? { ...activeFilters, fresh: 1 } : activeFilters;
    setLoading(true);
    setError("");
    setApplied(activeFilters);
    try {
      const [missingData, attendantData, queueData] = await Promise.all([
        api.missingTags({ ...query, page: targetPage }),
        api.byAttendant(query),
        api.byQueue(query)
      ]);
      setTickets(missingData.items || []);
      setPagination(missingData.paginacao || null);
      setCleanup(missingData.limpeza || null);
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

  // So a lista muda de pagina; os relatorios por atendente e por fila ficam.
  async function changePage(targetPage) {
    setLoading(true);
    setError("");
    try {
      const missingData = await api.missingTags({ ...applied, page: targetPage });
      setTickets(missingData.items || []);
      setPagination(missingData.paginacao || null);
      setCleanup(missingData.limpeza || null);
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

  async function buildExportRows() {
    const data = await api.missingTags({ ...applied, pageSize: EXPORT_PAGE_SIZE });
    return (data.items || []).map((ticket) => [
      ticket.clientName,
      ticket.queue,
      ticket.attendant || "-",
      ticket.company || "-",
      formatTicketDateTime(ticket),
      formatMinutes(ticket.inactivityMinutes),
      ticket.url || ""
    ]);
  }

  async function buildExportMeta() {
    return {
      title: "Tickets sem TAG",
      subtitle: describeFilters(applied),
      headers: EXPORT_HEADERS,
      rows: await buildExportRows()
    };
  }

  async function handleExportPdf() {
    try {
      await exportPdf({ ...(await buildExportMeta()), fileName: buildFileName("tickets-sem-tag", "pdf") });
    } catch (exportError) {
      setError(exportError.message || "Falha ao gerar o arquivo PDF");
    }
  }

  async function handleExportDocx() {
    try {
      await exportDocx({ ...(await buildExportMeta()), fileName: buildFileName("tickets-sem-tag", "docx") });
    } catch (exportError) {
      setError(exportError.message || "Falha ao gerar o arquivo DOCX");
    }
  }

  return (
    <section className="page-stack">
      <div className="section-toolbar">
        <div>
          <h2>Tickets sem TAG</h2>
          <p>Consulte ocorrencias por dia ou periodo, atendente, fila, empresa ou cliente.</p>
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

      {hiddenCount ? (
        <p className="notice">
          {hiddenCount} {hiddenCount === 1 ? "ticket foi ocultado" : "tickets foram ocultados"}: o contato esta sem nome
          no cadastro do MTalk.
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
        <h3>Lista de tickets sem TAG ({pagination?.total ?? tickets.length})</h3>
        {cleanup ? (
          <p className="table-note">
            {pagination?.porPagina || 15} clientes por pagina. Quem esta na lista ha mais de {cleanup.dias}{" "}
            {cleanup.dias === 1 ? "dia" : "dias"} sem nova leitura sai sozinho (desde {formatDateTime(cleanup.desde)}).
          </p>
        ) : null}
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
        <Pagination pagination={pagination} loading={loading} onPage={changePage} label="Paginacao dos tickets sem TAG" />
      </section>

      <div className="two-column">
        <MiniReport title="Falhas por atendente" rows={attendants} labelKey="attendant" columns={tagColumns} />
        <MiniReport title="Falhas por fila" rows={queues} labelKey="queue" columns={tagColumns} />
      </div>
    </section>
  );
}
