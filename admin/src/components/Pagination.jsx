// Anterior/Proxima de uma lista paginada. pagination e o `paginacao` da API
// (pagina, totalPaginas, total); nao aparece com uma pagina so.
export default function Pagination({ pagination, loading, onPage, label, noun = ["cliente", "clientes"] }) {
  if (!pagination || pagination.totalPaginas <= 1) return null;

  return (
    <nav className="pagination" aria-label={label}>
      <button
        className="secondary-button"
        type="button"
        disabled={loading || pagination.pagina <= 1}
        onClick={() => onPage(pagination.pagina - 1)}
      >
        Anterior
      </button>
      <span>
        Pagina {pagination.pagina} de {pagination.totalPaginas} ({pagination.total}{" "}
        {pagination.total === 1 ? noun[0] : noun[1]})
      </span>
      <button
        className="secondary-button"
        type="button"
        disabled={loading || pagination.pagina >= pagination.totalPaginas}
        onClick={() => onPage(pagination.pagina + 1)}
      >
        Proxima
      </button>
    </nav>
  );
}
