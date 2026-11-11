// Resultados: porcentagem de ACERTO por contagem de falhas.
//
// Diferente do "padrao de atendimento" (service-standard.js), que da uma nota de
// 0 a 100 a cada ticket, aqui a conta e direta e facil de conferir na mao:
//
// - atendimentos: tickets avaliados do atendente (cada ticket conta uma vez);
// - falha de inatividade: o ticket ficou parado alem do limite de registro
//   (a maior parada do periodo);
// - falha de TAG: o ticket tem atendente e o contato esta sem TAG. Ticket
//   aguardando atendente nao tem a quem cobrar a TAG: nao entra nesta conta.
//
// Acerto de inatividade = 1 - falhas de inatividade / atendimentos.
// Acerto de TAG         = 1 - falhas de TAG / atendimentos com responsavel.
// Resultado             = media ponderada dos dois, com a INATIVIDADE pesando
//                         mais (padrao 70% x 30%, RESULT_INACTIVITY_WEIGHT).
//
// Sem nenhum ticket cobravel de TAG (so ticket aguardando), o resultado fica so
// com o acerto de inatividade: nao ha o que avaliar na outra metade.
// Funcoes puras: o SQL fica no report.service.js.

function round1(value) {
  return Number(value.toFixed(1));
}

// 0 a 100, ou null quando nao ha nada a avaliar (e nao 0%).
function hitPercent(failures, total) {
  return total ? round1((1 - failures / total) * 100) : null;
}

// tickets: [{ attendant, inactivityMinutes, hasResponsible, hasTag }]
function summarizeResults(tickets, { thresholdMinutes, inactivityWeight }) {
  const withResponsible = tickets.filter((ticket) => ticket.hasResponsible);
  const inactivityFailures = tickets.filter((ticket) => Number(ticket.inactivityMinutes) > thresholdMinutes).length;
  const tagFailures = withResponsible.filter((ticket) => !ticket.hasTag).length;

  const atendimentos = tickets.length;
  const inactivityHit = atendimentos ? (1 - inactivityFailures / atendimentos) * 100 : null;
  const tagHit = withResponsible.length ? (1 - tagFailures / withResponsible.length) * 100 : null;

  let percent = null;
  if (inactivityHit !== null) {
    percent =
      tagHit === null
        ? inactivityHit
        : (inactivityHit * inactivityWeight + tagHit * (100 - inactivityWeight)) / 100;
  }

  return {
    atendimentos,
    inactivityFailures,
    tagFailures,
    inactivityPercent: inactivityHit === null ? null : round1(inactivityHit),
    tagPercent: tagHit === null ? null : round1(tagHit),
    percent: percent === null ? null : round1(percent)
  };
}

// Geral (todas as filas juntas) e por atendente, do pior para o melhor. Ticket
// sem atendente entra no geral, mas nao tem linha propria.
function buildResults(tickets, options) {
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
    .map(([attendant, group]) => ({ attendant, ...summarizeResults(group, options) }))
    .sort(
      (left, right) =>
        left.percent - right.percent ||
        right.atendimentos - left.atendimentos ||
        left.attendant.localeCompare(right.attendant, "pt-BR")
    );

  return {
    ...summarizeResults(tickets, options),
    thresholdMinutes: options.thresholdMinutes,
    inactivityWeight: options.inactivityWeight,
    tagWeight: 100 - options.inactivityWeight,
    items
  };
}

module.exports = { buildResults, hitPercent, summarizeResults };
