// Cache das paginas do painel, so em memoria.
//
// Voltar a uma pagina mostra na hora o que ja estava na tela, sem consultar a
// API de novo; a propria pagina decide quando o que esta guardado venceu. Nunca
// vai para o localStorage: os relatorios tem nome de cliente. Sai no logout e
// quando a sessao expira (App.jsx), e some sozinho ao recarregar o painel.

const pages = new Map();

export function readPageCache(name) {
  return pages.get(name) || null;
}

export function writePageCache(name, value) {
  pages.set(name, value);
}

export function clearPageCache() {
  pages.clear();
}
