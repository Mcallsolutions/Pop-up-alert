import React, { useEffect, useId, useState } from "react";
import { FileText, FileType2, Filter, RotateCcw } from "lucide-react";
import { api } from "../services/api";

export const emptyFilters = {
  day: "",
  attendant: "",
  queue: "",
  company: "",
  clientName: ""
};

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

  // As opcoes dependem so do recorte de dia: filtrar por atendente nao pode
  // sumir com as empresas disponiveis na lista.
  useEffect(() => {
    let active = true;
    api
      .filterOptions({ day: filters.day })
      .then((data) => {
        if (active) setOptions({ ...emptyOptions, ...data });
      })
      .catch(() => {
        if (active) setOptions(emptyOptions);
      });
    return () => {
      active = false;
    };
  }, [filters.day]);

  function handleSubmit(event) {
    event.preventDefault();
    onApply(filters);
  }

  return (
    <form className="filters" onSubmit={handleSubmit}>
      <label>
        Dia
        <input type="date" value={filters.day} onChange={(event) => onChange("day", event.target.value)} />
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

      <div className="filter-actions">
        <button className="primary-button" type="submit">
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
