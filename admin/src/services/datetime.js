// Formatacao de datas/horas do painel.
//
// Os dois horarios de um ticket sao diferentes e o painel mostra o do TICKET:
// - display_time: a hora que aparece na tela do MTalk, ou seja, quando o ticket
//   entrou/foi movimentado. E o que interessa para a operacao.
// - collected_at: quando a extensao leu a tela. E so metadado da coleta.
//
// A composicao "data da coleta + hora do ticket" e feita aqui, no navegador,
// porque display_time vem no fuso do operador — no servidor (UTC na Vercel) a
// conta sairia com horas de diferenca.

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
// Folga para relogios levemente dessincronizados entre o MTalk e a maquina que
// coletou. Sem ela, um ticket de "14:30" lido as 14:29:50 cairia para o dia
// anterior.
const CLOCK_TOLERANCE_MS = 2 * 60 * 1000;

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const dateFormatter = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" });

export function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return dateTimeFormatter.format(date);
}

// Data/hora do ticket: dia em que a leitura aconteceu + hora exibida no MTalk.
// Quando a hora do ticket e maior que a da coleta, o ticket e da vespera.
export function resolveTicketDate(ticket) {
  const match = String(ticket?.displayTime || "").trim().match(TIME_PATTERN);
  if (!match) return null;

  const collected = new Date(ticket?.collectedAt);
  if (Number.isNaN(collected.getTime())) return null;

  const ticketDate = new Date(collected);
  ticketDate.setHours(Number(match[1]), Number(match[2]), 0, 0);

  if (ticketDate.getTime() - collected.getTime() > CLOCK_TOLERANCE_MS) {
    ticketDate.setDate(ticketDate.getDate() - 1);
  }

  return ticketDate;
}

// Usado nas tabelas e nas exportacoes: "10/08/2026 14:30".
export function formatTicketDateTime(ticket) {
  const ticketDate = resolveTicketDate(ticket);
  if (ticketDate) return dateTimeFormatter.format(ticketDate);
  // Sem data de coleta valida ainda da para mostrar a hora crua do MTalk.
  return String(ticket?.displayTime || "").trim() || "-";
}

export function formatTicketDate(ticket) {
  const ticketDate = resolveTicketDate(ticket);
  return ticketDate ? dateFormatter.format(ticketDate) : "-";
}

export function formatTicketTime(ticket) {
  const ticketDate = resolveTicketDate(ticket);
  if (ticketDate) return `${pad(ticketDate.getHours())}:${pad(ticketDate.getMinutes())}`;
  return String(ticket?.displayTime || "").trim() || "-";
}

export function formatMinutes(value) {
  const minutes = Number(value || 0);
  return minutes ? `${minutes} min` : "-";
}

function pad(value) {
  return String(value).padStart(2, "0");
}
