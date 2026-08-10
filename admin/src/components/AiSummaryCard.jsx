import React, { useState } from "react";
import { Sparkles } from "lucide-react";
import { formatDateTime } from "../services/datetime";

// Renderiza o JSON devolvido pela OpenAI campo a campo. E o mesmo componente
// usado na pagina de IA e no card de resumo do dashboard.
export default function AiSummaryCard({ summary, loading = false, emptyMessage = "Nenhum resumo gerado ainda." }) {
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

  return (
    <section className="table-panel ai-summary">
      <h3>
        <Sparkles aria-hidden="true" size={17} />
        Resumo da IA
      </h3>

      <div className="ai-summary-body">
        <div className="ai-meta">
          <span>{formatDateTime(summary.createdAt)}</span>
          {summary.model ? <span>Modelo: {summary.model}</span> : null}
          {summary.usage?.totalTokens ? <span>{summary.usage.totalTokens} tokens</span> : null}
          {describeFilters(summary.filters) ? <span>{describeFilters(summary.filters)}</span> : null}
          {risco ? <span className={`badge risco-${risco.toLowerCase()}`}>Risco {risco}</span> : null}
        </div>

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

function describeFilters(filters) {
  const entries = Object.entries(filters || {}).filter(([, value]) => String(value || "").trim());
  if (!entries.length) return "";
  return entries.map(([key, value]) => `${key}: ${value}`).join("  |  ");
}
