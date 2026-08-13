import React, { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { api, getApiBaseUrl, setApiBaseUrl } from "../../services/api";

export default function SettingsPage() {
  const [apiUrl, setApiUrl] = useState(getApiBaseUrl());
  const [feedback, setFeedback] = useState("");
  const [mtalk, setMtalk] = useState(null);
  const [mtalkError, setMtalkError] = useState("");

  useEffect(() => {
    api
      .mtalkStatus()
      .then(setMtalk)
      .catch((error) => setMtalkError(error.message));
  }, []);

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

      <div className="table-panel">
        <h3>Integracao MTalk (API oficial)</h3>
        <div className="table-scroll">
          {mtalkError ? (
            <p className="notice error">{mtalkError}</p>
          ) : !mtalk ? (
            <p className="notice">Carregando...</p>
          ) : (
            <table>
              <tbody>
                <tr>
                  <td>Coleta pelo servidor</td>
                  <td>
                    <span className={`badge${mtalk.configurado ? " ativo" : ""}`}>
                      {mtalk.configurado ? "MTALK_TOKEN configurado" : "so pela extensao"}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>Endereco da API</td>
                  <td>{mtalk.baseUrl}</td>
                </tr>
                <tr>
                  <td>Filas monitoradas</td>
                  <td>{(mtalk.filasMonitoradas || []).join(", ")}</td>
                </tr>
                <tr>
                  <td>Status lidos</td>
                  <td>{(mtalk.statusMonitorados || []).join(", ")}</td>
                </tr>
                <tr>
                  <td>Limite de inatividade</td>
                  <td>{mtalk.limiteInatividadeMinutos} min</td>
                </tr>
                <tr>
                  <td>Filas resolvidas na ultima coleta</td>
                  <td>{(mtalk.cacheFilas?.filas || []).join(", ") || "-"}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
