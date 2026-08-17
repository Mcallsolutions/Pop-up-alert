import React, { useState } from "react";
import { AlertTriangle, Sparkles } from "lucide-react";
import { sameFilters } from "./FilterBar";
import { formatDateTime, formatDay, isToday } from "../services/datetime";

// Renderiza o JSON devolvido pela OpenAI campo a campo. E o mesmo componente
// usado na pagina de IA e no card de resumo do dashboard.
//
// currentFilters (opcional) e o recorte selecionado agora na tela: quando ele
// nao bate com o do resumo guardado, o card avisa em vez de deixar o texto
// passar por analise do periodo atual.
export default function AiSummaryCard({
  summary,
  loading = false,
  emptyMessage = "Nenhum resumo gerado ainda.",
  currentFilters = null
}) {
  const [showJson, setShowJson] = useState(false);

  if (loading) {
    return (
      <section className="table-panel ai-summary">
        <h3>Resumo da IA</h3>
        <div className="ai-summary-body">
          <p className="ai-empty">Gerando resumo...</p>
        </div>
      </section>
    );
  }

  if (!summary) {
    return (
      <section className="table-panel ai-summary">
        <h3>Resumo da IA</h3>
        <div className="ai-summary-body">
          <p className="ai-empty">{emptyMessage}</p>
        </div>
      </section>
    );
  }

  const content = summary.content || {};
  const risco = String(content.nivelRisco || "").toUpperCase();
  const aviso = buildWarning(summary, currentFilters);
  const outrosFiltros = describeFilters(summary.filters);

  return (
    <section className="table-panel ai-summary">
      <h3>
        <Sparkles aria-hidden="true" size={17} />
        Resumo da IA
      </h3>

      <div className="ai-summary-body">
        <div className="ai-meta">
          <span>Gerado em {formatDateTime(summary.createdAt)}</span>
          <span>{describePeriod(summary.filters)}</span>
          {summary.model ? <span>Modelo: {summary.model}</span> : null}
          {summary.usage?.totalTokens ? <span>{summary.usage.totalTokens} tokens</span> : null}
          {outrosFiltros ? <span>{outrosFiltros}</span> : null}
          {risco ? <span className={`badge risco-${risco.toLowerCase()}`}>Risco {risco}</span> : null}
        </div>

        {aviso ? (
          <p className="notice warning ai-stale">
            <AlertTriangle aria-hidden="true" size={16} /> {aviso}
          </p>
        ) : null}

        <p className="ai-text">{content.resumo || "A IA nao devolveu o campo 'resumo'."}</p>

        <AiList title="Pontos criticos" items={content.pontosCriticos} />
        <AiList title="Atendentes" items={content.atendentes} />
        <AiList title="Filas" items={content.filas} />
        <AiList title="Recomendacoes" items={content.recomendacoes} />

        <button className="link-button" type="button" onClick={() => setShowJson((current) => !current)}>
          {showJson ? "Ocultar JSON" : "Ver JSON completo"}
        </button>

        {showJson ? <pre className="ai-json">{JSON.stringify(content, null, 2)}</pre> : null}
      </div>
    </section>
  );
}

function AiList({ title, items }) {
  const rows = normalizeItems(items);
  if (!rows.length) return null;

  return (
    <div className="ai-block">
      <h4>{title}</h4>
      <ul>
        {rows.map((row, index) => (
          <li key={`${title}-${index}`}>{row}</li>
        ))}
      </ul>
    </div>
  );
}

// A IA pode devolver ["texto"] ou [{ nome, observacao }]. Os dois viram linha.
function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (item === null || item === undefined) return "";
      if (typeof item === "object") {
        return Object.values(item)
          .filter((value) => String(value || "").trim())
          .join(" — ");
      }
      return String(item);
    })
    .filter((item) => item.trim());
}

const FILTER_LABELS = {
  attendant: "Atendente",
  company: "Empresa",
  queue: "Fila",
  clientName: "Cliente"
};

// Filtros de recorte que nao sao data. A data sai separada, em describePeriod,
// porque e ela que diz de QUANDO e o resumo.
function describeFilters(filters) {
  const entries = Object.entries(FILTER_LABELS).filter(([key]) => String(filters?.[key] || "").trim());
  if (!entries.length) return "";
  return entries.map(([key, label]) => `${label}: ${filters[key]}`).join("  |  ");
}

// Periodo que a IA analisou, sempre escrito. Sem dia nem intervalo o resumo
// cobre TODO o historico — era assim que um resumo do dia 10/08 passava por
// resumo do dia de hoje.
function describePeriod(filters) {
  const day = String(filters?.day || "").trim();
  if (day) {
    return `Periodo: ${formatDay(day)}`;
  }

  const inicio = String(filters?.startDate || "").trim();
  const fim = String(filters?.endDate || "").trim();
  if (inicio || fim) {
    return `Periodo: ${inicio ? formatDay(inicio) : "inicio"} ate ${fim ? formatDay(fim) : "hoje"}`;
  }

  return "Periodo: todo o historico";
}

// Duas razoes para o card estar mostrando algo que nao e o agora: o resumo foi
// gerado em outro dia, ou o recorte da tela mudou depois que ele foi gerado.
function buildWarning(summary, currentFilters) {
  if (currentFilters && !sameFilters(summary.filters, currentFilters)) {
    return "Este resumo foi gerado com outro recorte de filtros. Clique em Gerar resumo com IA para analisar o recorte selecionado agora.";
  }

  if (!isToday(summary.createdAt)) {
    return `Resumo antigo, gerado em ${formatDateTime(summary.createdAt)}. Ele nao reflete os dados de hoje — gere um novo resumo.`;
  }

  return "";
}
