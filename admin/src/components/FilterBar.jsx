import { useEffect, useId, useRef, useState } from "react";
import { FileText, FileType2, Filter, RotateCcw } from "lucide-react";
import { api } from "../services/api";
import { addDays, formatDay, todayIsoDate } from "../services/datetime";

// Recorte das telas: um periodo (startDate ate endDate, inclusivos; o mesmo dia
// nos dois = um dia so) e, se quiser, um ou mais atendentes, fila, empresa e
// cliente. attendant e sempre uma lista.
export const emptyFilters = {
  startDate: "",
  endDate: "",
  attendant: [],
  queue: "",
  company: "",
  clientName: ""
};

const TEXT_KEYS = ["queue", "company", "clientName"];

// Resumos de IA gravados antes do periodo unico trazem `day` e `attendant` em
// texto: viram startDate/endDate e lista.
export function normalizeFilters(filters) {
  const source = filters || {};
  const day = String(source.day || "").trim();
  return {
    ...emptyFilters,
    startDate: day || String(source.startDate || "").trim(),
    endDate: day || String(source.endDate || "").trim(),
    attendant: toList(source.attendant),
    queue: String(source.queue || "").trim(),
    company: String(source.company || "").trim(),
    clientName: String(source.clientName || "").trim()
  };
}

function toList(value) {
  const items = Array.isArray(value) ? value : [value];
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

// Recorte padrao de quem precisa falar do agora (pagina de IA): o dia corrente.
// Sem periodo, a consulta varre TODO o historico e o resumo sai misturando semanas.
export function todayFilters() {
  const today = todayIsoDate();
  return { ...emptyFilters, startDate: today, endDate: today };
}

// Dois recortes sao o mesmo quando todos os campos batem. Campo vazio e campo
// ausente contam como iguais: o servidor grava apenas os preenchidos.
export function sameFilters(left, right) {
  const a = normalizeFilters(left);
  const b = normalizeFilters(right);
  return (
    a.startDate === b.startDate &&
    a.endDate === b.endDate &&
    toList(a.attendant).sort().join("|") === toList(b.attendant).sort().join("|") &&
    TEXT_KEYS.every((key) => a[key] === b[key])
  );
}

// Periodo com o inicio depois do fim: a API nao devolveria nada.
export function isInvertedRange(filters) {
  const start = String(filters?.startDate || "");
  const end = String(filters?.endDate || "");
  return Boolean(start && end && start > end);
}

const BASE_LABELS = { queue: "Fila", company: "Empresa", clientName: "Cliente" };

// Resume os filtros ativos para o cabecalho do PDF/DOCX exportado. extraLabels
// acrescenta campos de uma pagina especifica ({ desfecho: "Desfecho" }).
export function describeFilters(filters, extraLabels = {}) {
  const current = normalizeFilters(filters);
  const parts = [];

  if (current.startDate && current.startDate === current.endDate) {
    parts.push(`Dia: ${formatDay(current.startDate)}`);
  } else if (current.startDate && current.endDate) {
    parts.push(`Periodo: ${formatDay(current.startDate)} a ${formatDay(current.endDate)}`);
  } else if (current.startDate) {
    parts.push(`A partir de: ${formatDay(current.startDate)}`);
  } else if (current.endDate) {
    parts.push(`Ate: ${formatDay(current.endDate)}`);
  }

  if (current.attendant.length) {
    parts.push(`${current.attendant.length > 1 ? "Atendentes" : "Atendente"}: ${current.attendant.join(", ")}`);
  }
  for (const [key, label] of Object.entries({ ...BASE_LABELS, ...extraLabels })) {
    const value = String(filters?.[key] ?? "").trim();
    if (value) parts.push(`${label}: ${value}`);
  }
  return parts.length ? parts.join("  |  ") : "Sem filtros aplicados";
}

const PRESETS = [
  { label: "Hoje", days: 0 },
  { label: "7 dias", days: 6 },
  { label: "30 dias", days: 29 }
];

const emptyOptions = { attendants: [], queues: [], companies: [], clients: [] };

// Barra unica de filtros usada pelo dashboard, relatorios, inatividade, IA e
// atendimento. Fila, empresa e cliente sao input + datalist (sugestao do que
// existe no banco, mas aceita busca parcial); atendente e uma lista com marcas.
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

  // As opcoes dependem so do periodo: filtrar por atendente nao pode sumir com
  // as empresas disponiveis na lista.
  useEffect(() => {
    let active = true;
    api
      .filterOptions({ startDate, endDate })
      .then((data) => {
        if (active) setOptions({ ...emptyOptions, ...data });
      })
      .catch(() => {
        if (active) setOptions(emptyOptions);
      });
    return () => {
      active = false;
    };
  }, [startDate, endDate]);

  function handleSubmit(event) {
    event.preventDefault();
    if (invertedRange) return;
    onApply(filters);
  }

  function applyPreset(days) {
    onChange("startDate", addDays(todayIsoDate(), -days));
    onChange("endDate", todayIsoDate());
  }

  return (
    <form className="filters" onSubmit={handleSubmit}>
      <label>
        De
        <input
          type="date"
          value={startDate}
          max={endDate || undefined}
          onChange={(event) => onChange("startDate", event.target.value)}
        />
      </label>
      <label>
        Ate
        <input
          type="date"
          value={endDate}
          min={startDate || undefined}
          onChange={(event) => onChange("endDate", event.target.value)}
        />
      </label>

      <AttendantPicker
        value={toList(filters.attendant)}
        options={options.attendants}
        onChange={(value) => onChange("attendant", value)}
      />
      <ComboField
        label="Empresa"
        listId={`${listId}-company`}
        value={filters.company || ""}
        options={options.companies}
        onChange={(value) => onChange("company", value)}
      />
      <ComboField
        label="Fila"
        listId={`${listId}-queue`}
        value={filters.queue || ""}
        options={options.queues}
        onChange={(value) => onChange("queue", value)}
      />
      <ComboField
        label="Cliente"
        listId={`${listId}-client`}
        value={filters.clientName || ""}
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
        {PRESETS.map((preset) => (
          <button key={preset.label} className="secondary-button" type="button" onClick={() => applyPreset(preset.days)}>
            {preset.label}
          </button>
        ))}
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

// Varios atendentes no mesmo filtro: lista com marcas num painel que fecha ao
// clicar fora. Nada marcado = todos.
function AttendantPicker({ value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function close(event) {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // Mantem marcado o que ja esta no filtro mesmo que a lista nao o traga.
  const names = [...new Set([...options, ...value])].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const summary = !value.length ? "Todos" : value.length === 1 ? value[0] : `${value.length} atendentes`;

  function toggle(name) {
    onChange(value.includes(name) ? value.filter((item) => item !== name) : [...value, name]);
  }

  return (
    <div className="field multi-select" ref={rootRef}>
      <span>Atendente</span>
      <button
        type="button"
        className="multi-select__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {summary}
      </button>
      {open ? (
        <div className="multi-select__panel" role="listbox" aria-multiselectable="true">
          {names.length ? (
            names.map((name) => (
              <label key={name} className="checkbox-field">
                <input type="checkbox" checked={value.includes(name)} onChange={() => toggle(name)} />
                {name}
              </label>
            ))
          ) : (
            <p className="table-note">Sem atendentes no periodo.</p>
          )}
          {value.length ? (
            <button type="button" className="secondary-button" onClick={() => onChange([])}>
              Limpar selecao
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
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
