import { useEffect, useId, useState } from "react";
import { FileText, FileType2, Filter, RotateCcw } from "lucide-react";
import { api } from "../services/api";
import { formatDay, todayIsoDate } from "../services/datetime";

// day = um dia so; startDate/endDate = periodo personalizado (De/Ate, ambos
// inclusivos). Na API o dia tem prioridade, por isso a barra nunca deixa os dois
// preenchidos ao mesmo tempo.
export const emptyFilters = {
  day: "",
  startDate: "",
  endDate: "",
  attendant: "",
  queue: "",
  company: "",
  clientName: ""
};

// Chaves de recorte que o servidor aceita (ai.service.cleanFilters). startDate/
// endDate nao tem campo na barra, mas chegam nos filtros gravados junto do
// resumo — entram aqui para a comparacao nao ignora-los.
const FILTER_KEYS = ["day", "startDate", "endDate", "attendant", "queue", "company", "clientName"];

// Recorte padrao de quem precisa falar do agora (pagina de IA): o dia corrente.
// Sem dia, a consulta varre TODO o historico e o resumo sai misturando semanas.
export function todayFilters() {
  return { ...emptyFilters, day: todayIsoDate() };
}

const DESCRIPTION_LABELS = {
  attendant: "Atendente",
  company: "Empresa",
  queue: "Fila",
  clientName: "Cliente"
};

// Resume os filtros ativos para o cabecalho do PDF/DOCX exportado.
export function describeFilters(filters) {
  const parts = [];
  if (String(filters?.day || "").trim()) {
    parts.push(`Dia: ${formatDay(filters.day)}`);
  } else {
    const start = String(filters?.startDate || "").trim();
    const end = String(filters?.endDate || "").trim();
    if (start && end) parts.push(`Periodo: ${formatDay(start)} a ${formatDay(end)}`);
    else if (start) parts.push(`A partir de: ${formatDay(start)}`);
    else if (end) parts.push(`Ate: ${formatDay(end)}`);
  }
  for (const [key, label] of Object.entries(DESCRIPTION_LABELS)) {
    if (String(filters?.[key] || "").trim()) parts.push(`${label}: ${filters[key]}`);
  }
  return parts.length ? parts.join("  |  ") : "Sem filtros aplicados";
}

// Periodo com o inicio depois do fim: a API nao devolveria nada.
export function isInvertedRange(filters) {
  const start = String(filters.startDate || "");
  const end = String(filters.endDate || "");
  return Boolean(start && end && start > end);
}

// Dois recortes sao o mesmo quando todos os campos batem. Campo vazio e campo
// ausente contam como iguais: o servidor grava apenas os preenchidos.
export function sameFilters(left, right) {
  return FILTER_KEYS.every((key) => String(left?.[key] || "").trim() === String(right?.[key] || "").trim());
}

const emptyOptions = {
  attendants: [],
  queues: [],
  companies: [],
  clients: []
};

// Barra unica de filtros usada pelo dashboard, relatorios e inatividade.
// Os campos sao input + datalist: o valor vem sugerido a partir do que existe
// no banco, mas continua aceitando busca parcial digitada a mao.
export default function FilterBar({
  filters,
  onChange,
  onApply,
  onClear,
  onExportPdf,
  onExportDocx,
  exportDisabled = true
}) {
  const [options, setOptions] = useState(emptyOptions);
  const listId = useId();

  const startDate = filters.startDate || "";
  const endDate = filters.endDate || "";
  const invertedRange = isInvertedRange(filters);

  // As opcoes dependem so do recorte de datas: filtrar por atendente nao pode
  // sumir com as empresas disponiveis na lista.
  useEffect(() => {
    let active = true;
    api
      .filterOptions({ day: filters.day, startDate, endDate })
      .then((data) => {
        if (active) setOptions({ ...emptyOptions, ...data });
      })
      .catch(() => {
        if (active) setOptions(emptyOptions);
      });
    return () => {
      active = false;
    };
  }, [filters.day, startDate, endDate]);

  function handleSubmit(event) {
    event.preventDefault();
    if (invertedRange) return;
    onApply(filters);
  }

  // Dia e periodo se excluem: escolher um limpa o outro.
  function changeDay(value) {
    onChange("day", value);
    if (value) {
      onChange("startDate", "");
      onChange("endDate", "");
    }
  }

  function changePeriod(key, value) {
    onChange(key, value);
    if (value) onChange("day", "");
  }

  return (
    <form className="filters" onSubmit={handleSubmit}>
      <label>
        Dia
        <input type="date" value={filters.day || ""} onChange={(event) => changeDay(event.target.value)} />
      </label>
      <label>
        Periodo: de
        <input
          type="date"
          value={startDate}
          max={endDate || undefined}
          onChange={(event) => changePeriod("startDate", event.target.value)}
        />
      </label>
      <label>
        Periodo: ate
        <input
          type="date"
          value={endDate}
          min={startDate || undefined}
          onChange={(event) => changePeriod("endDate", event.target.value)}
        />
      </label>

      <ComboField
        label="Atendente"
        listId={`${listId}-attendant`}
        value={filters.attendant}
        options={options.attendants}
        onChange={(value) => onChange("attendant", value)}
      />
      <ComboField
        label="Empresa"
        listId={`${listId}-company`}
        value={filters.company}
        options={options.companies}
        onChange={(value) => onChange("company", value)}
      />
      <ComboField
        label="Fila"
        listId={`${listId}-queue`}
        value={filters.queue}
        options={options.queues}
        onChange={(value) => onChange("queue", value)}
      />
      <ComboField
        label="Cliente"
        listId={`${listId}-client`}
        value={filters.clientName}
        options={options.clients}
        onChange={(value) => onChange("clientName", value)}
      />

      {invertedRange ? (
        <p className="filter-hint" role="alert">
          A data inicial do periodo e depois da final.
        </p>
      ) : null}

      <div className="filter-actions">
        <button className="primary-button" type="submit" disabled={invertedRange}>
          <Filter aria-hidden="true" size={17} />
          Filtrar
        </button>
        <button className="secondary-button" type="button" onClick={onClear}>
          <RotateCcw aria-hidden="true" size={17} />
          Limpar
        </button>
        {onExportPdf ? (
          <button className="secondary-button" type="button" onClick={onExportPdf} disabled={exportDisabled}>
            <FileText aria-hidden="true" size={17} />
            PDF
          </button>
        ) : null}
        {onExportDocx ? (
          <button className="secondary-button" type="button" onClick={onExportDocx} disabled={exportDisabled}>
            <FileType2 aria-hidden="true" size={17} />
            DOCX
          </button>
        ) : null}
      </div>
    </form>
  );
}

function ComboField({ label, listId, value, options, onChange }) {
  return (
    <label>
      {label}
      <input
        list={listId}
        value={value}
        placeholder={options.length ? "Todos" : "Sem dados"}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
    </label>
  );
}
