// Padrao de atendimento: uma porcentagem que junta TAG e inatividade.
//
// 100% e a base: atendimento sem parada acima do limite e com TAG no contato.
// A nota nasce de cada ticket e a porcentagem de um grupo e a media das notas:
//
// - Inatividade (50%): ate o limite (INACTIVITY_THRESHOLD_MINUTES) a nota e 100.
//   Passou dele, perde pontos em linha reta ate zerar em zeroMinutes (padrao 4x o
//   limite: 60 min com o limite de 15): 15 min = 100, 37,5 min = 50, 60 min = 0.
// - TAG (50%): 100 com TAG, 0 sem. Ticket aguardando atendente nao tem a quem
//   cobrar a TAG (mesma regra da conformidade): fica so com a nota de
//   inatividade, que vale 100% dele.
//
// A parada considerada de cada ticket e a maior dentro do periodo (a mesma dos
// relatorios de inatividade). Funcoes puras: o SQL fica no report.service.js.

const TAG_WEIGHT = 0.5;
const INACTIVITY_WEIGHT = 0.5;

// 0 a 100. Antes do limite nao ha desconto; depois dele o desconto cresce com o
// tempo parado, sem nunca passar de 0.
function inactivityScore(minutes, { thresholdMinutes, zeroMinutes }) {
  const parado = Math.max(Number(minutes) || 0, 0);
  if (parado <= thresholdMinutes) {
    return 100;
  }
  const faixa = Math.max(zeroMinutes - thresholdMinutes, 1);
  return Math.max(0, 100 * (1 - (parado - thresholdMinutes) / faixa));
}

// ticket: { inactivityMinutes, hasResponsible, hasTag }
function scoreTicket(ticket, options) {
  const inactivity = inactivityScore(ticket.inactivityMinutes, options);
  if (!ticket.hasResponsible) {
    return { score: inactivity, inactivity, tag: null };
  }
  const tag = ticket.hasTag ? 100 : 0;
  return { score: tag * TAG_WEIGHT + inactivity * INACTIVITY_WEIGHT, inactivity, tag };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function round1(value) {
  return value === null ? null : Number(value.toFixed(1));
}

// tickets: [{ attendant, inactivityMinutes, hasResponsible, hasTag }]
// Sem ticket nenhum a porcentagem e null (e nao 0%): nao ha o que avaliar.
function summarizeGroup(tickets, options) {
  const scored = tickets.map((ticket) => ({ ticket, ...scoreTicket(ticket, options) }));
  const tags = scored.filter((item) => item.tag !== null).map((item) => item.tag);

  return {
    tickets: tickets.length,
    percent: round1(average(scored.map((item) => item.score))),
    inactivityPercent: round1(average(scored.map((item) => item.inactivity))),
    tagPercent: round1(average(tags)),
    inactiveTickets: tickets.filter((ticket) => Number(ticket.inactivityMinutes) > options.thresholdMinutes).length,
    withoutTag: tickets.filter((ticket) => ticket.hasResponsible && !ticket.hasTag).length
  };
}

// Geral e por atendente (do pior para o melhor). Ticket sem atendente entra no
// geral, mas nao tem linha propria.
function buildServiceStandard(tickets, options) {
  const byAttendant = new Map();
  for (const ticket of tickets) {
    if (!ticket.hasResponsible || !ticket.attendant) {
      continue;
    }
    if (!byAttendant.has(ticket.attendant)) {
      byAttendant.set(ticket.attendant, []);
    }
    byAttendant.get(ticket.attendant).push(ticket);
  }

  const items = [...byAttendant.entries()]
    .map(([attendant, group]) => ({ attendant, ...summarizeGroup(group, options) }))
    .sort(
      (left, right) =>
        left.percent - right.percent || right.tickets - left.tickets || left.attendant.localeCompare(right.attendant, "pt-BR")
    );

  return {
    ...summarizeGroup(tickets, options),
    thresholdMinutes: options.thresholdMinutes,
    zeroMinutes: options.zeroMinutes,
    tagWeight: TAG_WEIGHT * 100,
    inactivityWeight: INACTIVITY_WEIGHT * 100,
    items
  };
}

module.exports = {
  buildServiceStandard,
  inactivityScore,
  scoreTicket
};
