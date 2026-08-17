import React, { useEffect, useState } from "react";
import { Bot, Pencil, Plus, RefreshCw, Save, Sparkles, Trash2, X } from "lucide-react";
import FilterBar, { sameFilters, todayFilters } from "../../components/FilterBar";
import AiSummaryCard from "../../components/AiSummaryCard";
import { api } from "../../services/api";
import { formatDateTime } from "../../services/datetime";

const PROMPT_KINDS = [
  { id: "INSTRUCAO", label: "Instrucao", hint: "Regra permanente que a IA deve seguir em todo resumo." },
  { id: "TREINAMENTO", label: "Treinamento", hint: "Exemplo de analise/estilo para a IA imitar." }
];

const emptyPrompt = { id: null, title: "", kind: "INSTRUCAO", content: "", isActive: true };

// O historico ja vem do mais recente para o mais antigo, entao o primeiro que
// bater com o recorte da tela e o resumo valido para ele.
function findSummaryForFilters(items, filters) {
  return (items || []).find((item) => sameFilters(item.filters, filters)) || null;
}

export default function AiPage() {
  // A pagina abre no dia corrente. Com o recorte vazio a consulta pega todo o
  // historico e o resumo sai falando de dias antigos.
  const [filters, setFilters] = useState(todayFilters);
  const [status, setStatus] = useState(null);
  const [prompts, setPrompts] = useState([]);
  const [summary, setSummary] = useState(null);
  const [history, setHistory] = useState([]);
  const [draft, setDraft] = useState(emptyPrompt);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");

  async function load() {
    setError("");
    try {
      const [statusData, promptData, historyData] = await Promise.all([
        api.aiStatus(),
        api.aiPrompts(),
        api.aiSummaries(10)
      ]);
      setStatus(statusData);
      setPrompts(promptData.items || []);
      setHistory(historyData.items || []);
      // So reaproveita um resumo ja gravado quando ele e do MESMO recorte que
      // esta na tela. Antes o card assumia o ultimo resumo existente, entao ao
      // abrir a pagina aparecia o relatorio pedido em outro dia.
      setSummary((current) => current || findSummaryForFilters(historyData.items, filters));
    } catch (requestError) {
      setError(requestError.message || "Falha ao carregar a configuracao da IA");
    }
  }

  useEffect(() => {
    load();
  }, []);

  function updateFilter(key, value) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function clearFilters() {
    setFilters(todayFilters());
  }

  async function generate() {
    setGenerating(true);
    setError("");
    setFeedback("");
    try {
      const created = await api.generateAiSummary(filters);
      setSummary(created);
      setHistory((current) => [created, ...current].slice(0, 10));
      setFeedback("Resumo gerado com sucesso.");
    } catch (requestError) {
      setError(requestError.message || "Falha ao gerar o resumo com a IA");
    } finally {
      setGenerating(false);
    }
  }

  async function savePrompt(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setFeedback("");
    try {
      const payload = {
        title: draft.title,
        kind: draft.kind,
        content: draft.content,
        isActive: draft.isActive
      };
      if (draft.id) {
        await api.updateAiPrompt(draft.id, payload);
      } else {
        await api.createAiPrompt(payload);
      }
      setDraft(emptyPrompt);
      setFeedback(draft.id ? "Prompt atualizado." : "Prompt cadastrado.");
      await load();
    } catch (requestError) {
      setError(requestError.message || "Falha ao salvar o prompt");
    } finally {
      setSaving(false);
    }
  }

  async function togglePrompt(prompt) {
    setError("");
    try {
      await api.updateAiPrompt(prompt.id, { ...prompt, isActive: !prompt.isActive });
      await load();
    } catch (requestError) {
      setError(requestError.message || "Falha ao atualizar o prompt");
    }
  }

  async function removePrompt(prompt) {
    if (!window.confirm(`Remover o prompt "${prompt.title}"?`)) {
      return;
    }
    setError("");
    try {
      await api.deleteAiPrompt(prompt.id);
      if (draft.id === prompt.id) setDraft(emptyPrompt);
      setFeedback("Prompt removido.");
      await load();
    } catch (requestError) {
      setError(requestError.message || "Falha ao remover o prompt");
    }
  }

  const configurada = Boolean(status?.openai?.configurado);

  return (
    <section className="page-stack">
      <div className="section-toolbar">
        <div>
          <h2>Adalberto IA</h2>
          <p>Adalberto esta operando normalmente.</p>
        </div>
        <button className="secondary-button" type="button" onClick={load}>
          <RefreshCw aria-hidden="true" size={17} />
          Atualizar
        </button>
      </div>

      <p className={configurada ? "notice success" : "notice"}>
        <Bot aria-hidden="true" size={16} />{" "}
        {configurada
          ? `Integracao ativa — modelo ${status.openai.modelo} respondendo em JSON.`
          : "OPENAI_API_KEY nao configurada. Defina a chave no ambiente da API para liberar a geracao de resumos."}
      </p>

      {error ? <p className="notice error">{error}</p> : null}
      {feedback ? <p className="notice success">{feedback}</p> : null}

      <div className="section-toolbar">
        <div>
          <h2>Resumo da IA</h2>
          <p>Os filtros abaixo definem o recorte de dados enviado para o Adalberto analisar.</p>
        </div>
      </div>

      <FilterBar
        filters={filters}
        onChange={updateFilter}
        onApply={() => setFeedback("Filtros aplicados. Clique em Gerar resumo com IA para analisar esse recorte.")}
        onClear={clearFilters}
      />

      <div className="filter-actions">
        <button className="primary-button" type="button" onClick={generate} disabled={generating || !configurada}>
          <Sparkles aria-hidden="true" size={17} />
          {generating ? "Gerando..." : "Gerar resumo com IA"}
        </button>
      </div>

      <AiSummaryCard
        summary={summary}
        loading={generating}
        currentFilters={filters}
        emptyMessage="Nenhum resumo gerado para este recorte. Clique em Gerar resumo com IA."
      />

      {history.length ? (
        <section className="table-panel">
          <h3>Historico de resumos</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Gerado em</th>
                  <th>Modelo</th>
                  <th>Responsavel</th>
                  <th>Tokens</th>
                  <th>Acao</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item) => (
                  <tr key={item.id}>
                    <td>{formatDateTime(item.createdAt)}</td>
                    <td>{item.model || "-"}</td>
                    <td>{item.createdBy || "-"}</td>
                    <td>{item.usage?.totalTokens || 0}</td>
                    <td>
                      <button className="link-button" type="button" onClick={() => setSummary(item)}>
                        Visualizar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <div className="section-toolbar">
        <div>
          <h2>Treinamento Adalberto</h2>
          <p>Tudo que estiver ativo aqui e enviado junto com os dados a cada resumo, deixando o Adalberto mais assertivo.</p>
        </div>
      </div>

      <form className="settings-form prompt-form" onSubmit={savePrompt}>
        <label>
          Titulo
          <input
            value={draft.title}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
            placeholder="Ex.: Priorizar filas de suporte"
            maxLength={120}
            required
          />
        </label>

        <label>
          Tipo
          <select value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value }))}>
            {PROMPT_KINDS.map((kind) => (
              <option key={kind.id} value={kind.id}>
                {kind.label}
              </option>
            ))}
          </select>
          <small>{PROMPT_KINDS.find((kind) => kind.id === draft.kind)?.hint}</small>
        </label>

        <label>
          Conteudo
          <textarea
            value={draft.content}
            onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
            placeholder="Escreva a instrucao ou o exemplo de analise que a IA deve seguir."
            rows={8}
            maxLength={8000}
            required
          />
          <small>{draft.content.length}/8000 caracteres</small>
        </label>

        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={draft.isActive}
            onChange={(event) => setDraft((current) => ({ ...current, isActive: event.target.checked }))}
          />
          Enviar este item para a IA
        </label>

        <div className="filter-actions">
          <button className="primary-button" type="submit" disabled={saving}>
            {draft.id ? <Save aria-hidden="true" size={17} /> : <Plus aria-hidden="true" size={17} />}
            {draft.id ? "Salvar alteracoes" : "Cadastrar prompt"}
          </button>
          {draft.id ? (
            <button className="secondary-button" type="button" onClick={() => setDraft(emptyPrompt)}>
              <X aria-hidden="true" size={17} />
              Cancelar edicao
            </button>
          ) : null}
        </div>
      </form>

      <section className="table-panel">
        <h3>Cadastrados ({prompts.length})</h3>
        <div className="prompt-list">
          {prompts.length ? (
            prompts.map((prompt) => (
              <article key={prompt.id} className={prompt.isActive ? "prompt-item" : "prompt-item inactive"}>
                <header>
                  <div>
                    <strong>{prompt.title}</strong>
                    <span className="badge">{PROMPT_KINDS.find((kind) => kind.id === prompt.kind)?.label || prompt.kind}</span>
                    <span className={prompt.isActive ? "badge ativo" : "badge"}>
                      {prompt.isActive ? "Ativo" : "Inativo"}
                    </span>
                  </div>
                  <div className="prompt-actions">
                    <button className="link-button" type="button" onClick={() => togglePrompt(prompt)}>
                      {prompt.isActive ? "Desativar" : "Ativar"}
                    </button>
                    <button className="link-button" type="button" onClick={() => setDraft(prompt)}>
                      <Pencil aria-hidden="true" size={15} />
                      Editar
                    </button>
                    <button className="link-button danger" type="button" onClick={() => removePrompt(prompt)}>
                      <Trash2 aria-hidden="true" size={15} />
                      Remover
                    </button>
                  </div>
                </header>
                <p>{prompt.content}</p>
                <small>Atualizado em {formatDateTime(prompt.updatedAt)}</small>
              </article>
            ))
          ) : (
            <p className="ai-empty">Nenhum prompt cadastrado. A IA vai usar apenas a instrucao padrao.</p>
          )}
        </div>
      </section>
    </section>
  );
}
