import React, { useState } from "react";
import { Save } from "lucide-react";
import { getApiBaseUrl, setApiBaseUrl } from "../../services/api";

export default function SettingsPage() {
  const [apiUrl, setApiUrl] = useState(getApiBaseUrl());
  const [feedback, setFeedback] = useState("");

  function save(event) {
    event.preventDefault();
    setApiBaseUrl(apiUrl);
    setFeedback("Configuracao salva. Atualize os dados para usar a nova API.");
  }

  return (
    <section className="page-stack">
      <div className="section-toolbar">
        <div>
          <h2>Configuracoes</h2>
          <p>Ajustes simples do painel administrativo.</p>
        </div>
      </div>

      <form className="settings-form" onSubmit={save}>
        <label>
          URL da API
          <input
            value={apiUrl}
            onChange={(event) => setApiUrl(event.target.value)}
            placeholder="Deixe vazio para usar a mesma origem do painel"
          />
          <small>
            Vazio = a API responde no mesmo dominio deste painel (padrao no deploy da Vercel). Preencha apenas se a API
            estiver hospedada em outro endereco, ex.: <code>http://localhost:3333</code>.
          </small>
        </label>
        <button className="primary-button" type="submit">
          <Save aria-hidden="true" size={17} />
          Salvar
        </button>
      </form>

      {feedback ? <p className="notice success">{feedback}</p> : null}
    </section>
  );
}
