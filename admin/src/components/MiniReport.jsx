// Tabela de resumo por grupo (por atendente, fila, empresa). columns:
// [{ header, render(row) }] depois da coluna "Nome", que mostra row[labelKey].
// limit corta as primeiras linhas (Dashboard); loading troca o corpo por um aviso.
export default function MiniReport({ title, rows, labelKey, columns, limit, loading = false, emptyText = "Sem dados." }) {
  const shown = limit ? rows.slice(0, limit) : rows;
  const span = columns.length + 1;

  return (
    <section className="table-panel">
      <h3>{title}</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              {columns.map((column) => (
                <th key={column.header}>{column.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={span}>Carregando...</td>
              </tr>
            ) : shown.length ? (
              shown.map((row) => (
                <tr key={row[labelKey] || "sem-identificacao"}>
                  <td>{row[labelKey] || "-"}</td>
                  {columns.map((column) => (
                    <td key={column.header}>{column.render(row)}</td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={span}>{emptyText}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Colunas dos relatorios de TAG (Dashboard e Relatorios).
export const tagColumns = [
  { header: "Total", render: (row) => row.totalTickets },
  { header: "Sem TAG", render: (row) => row.totalWithoutTag },
  { header: "Falha", render: (row) => `${row.failurePercent}%` }
];
