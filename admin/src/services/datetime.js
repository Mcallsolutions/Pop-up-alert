// Formatacao de datas/horas do painel.
//
// Os dois horarios de um ticket sao diferentes e o painel mostra o do TICKET:
// - last_message_at: ultima movimentacao do ticket no MTalk (updatedAt, UTC).
//   E o que interessa para a operacao.
// - collected_at: quando o servidor leu a API. E so metadado da coleta.

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

export function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return dateTimeFormatter.format(date);
}

// Usado nas tabelas e nas exportacoes: "10/08/2026 14:30".
export function formatTicketDateTime(ticket) {
  const date = new Date(ticket?.lastMessageAt || "");
  if (!Number.isNaN(date.getTime())) return dateTimeFormatter.format(date);
  return String(ticket?.displayTime || "").trim() || "-";
}

export function formatMinutes(value) {
  const minutes = Number(value || 0);
  return minutes ? `${minutes} min` : "-";
}

// Dia de hoje no formato do input[type=date] (YYYY-MM-DD), no fuso do operador.
// toISOString() daria o dia em UTC e, no fim da tarde, ja apontaria para amanha.
export function todayIsoDate() {
  return toIsoDate(new Date());
}

function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// "2026-08-10" -> "10/08/2026". Montado campo a campo de proposito: passar a
// string por new Date() a trata como UTC e o painel mostraria o dia anterior.
export function formatDay(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(value || "").trim();
  return `${match[3]}/${match[2]}/${match[1]}`;
}

// Usado para avisar quando o resumo exibido nao e do dia corrente.
export function isToday(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return toIsoDate(date) === todayIsoDate();
}
