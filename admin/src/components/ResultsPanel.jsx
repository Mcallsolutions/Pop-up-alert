import Metric from "./Metric";
import { formatPercent, standardTone } from "../services/standard";

// Explica a conta na tela, com os pesos que a API usou.
function describeResults(results) {
  const inactivityWeight = results?.inactivityWeight ?? 70;
  const tagWeight = results?.tagWeight ?? 100 - inactivityWeight;
  const limit = results?.thresholdMinutes || 18;
  return (
    `Acerto = 1 - falhas / atendimentos. Falha de inatividade: ticket parado mais de ${limit} min. ` +
    `Falha de TAG: ticket com atendente e sem TAG. O resultado pesa ${inactivityWeight}% a inatividade e ` +
    `${tagWeight}% a TAG (ticket aguardando atendente so conta na inatividade).`
  );
}

// Campo de resultados: o geral (todas as filas unificadas) em cartoes e, abaixo,
// a mesma conta para cada atendente, do pior para o melhor.
export default function ResultsPanel({ results, loading = false }) {
  const rows = results?.items || [];
  const tone = standardTone(results?.percent);

  return (
    <section className="table-panel">
      <h3>Resultados</h3>
      <p className="table-note">{describeResults(results)}</p>

      <div className="metric-grid">
        <Metric label="Resultado geral (todas as filas)" value={formatPercent(results?.percent)} tone={tone} />
        <Metric label="Atendimentos" value={results?.atendimentos ?? 0} />
        <Metric
          label="Falhas de inatividade"
          value={results?.inactivityFailures ?? 0}
          tone={results?.inactivityFailures ? "warning" : "default"}
        />
        <Metric
          label="Falhas de TAG"
          value={results?.tagFailures ?? 0}
          tone={results?.tagFailures ? "danger" : "default"}
        />
        <Metric label={`Acerto inatividade (peso ${results?.inactivityWeight ?? 70}%)`} value={formatPercent(results?.inactivityPercent)} />
        <Metric label={`Acerto TAG (peso ${results?.tagWeight ?? 30}%)`} value={formatPercent(results?.tagPercent)} />
      </div>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Atendente</th>
              <th>Atendimentos</th>
              <th>Falhas inatividade</th>
              <th>Falhas TAG</th>
              <th>Acerto inatividade</th>
              <th>Acerto TAG</th>
              <th>Resultado</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan="7">Carregando...</td>
              </tr>
            ) : rows.length ? (
              rows.map((row) => (
                <tr key={row.attendant}>
                  <td>{row.attendant}</td>
                  <td>{row.atendimentos}</td>
                  <td>{row.inactivityFailures}</td>
                  <td>{row.tagFailures}</td>
                  <td>{formatPercent(row.inactivityPercent)}</td>
                  <td>{formatPercent(row.tagPercent)}</td>
                  <td>
                    <strong>{formatPercent(row.percent)}</strong>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan="7">Sem dados.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
