// Metricas de tempo de resposta de uma conversa, calculadas em codigo.
//
// Modulo puro: recebe as mensagens da janela ja classificadas (sender_kind) e
// devolve os numeros que vao para a IA e para o painel. A IA recebe estes
// numeros prontos e e instruida a nunca recalcular tempos a partir do texto.
//
// Regras:
// - AUTOMATICA (bot, fila, saudacao, despedida) nunca conta como resposta;
// - a espera do cliente conta do INICIO de cada bloco de mensagens seguidas
//   dele ate a proxima resposta humana (ATENDENTE ou EMPRESA). Mensagem
//   automatica no meio nao encerra o bloco: o cliente continua esperando;
// - conversa que termina com o cliente sem resposta conta a espera em aberto
//   ate o fim da janela (endAt: agora, com o ticket aberto);
// - a espera da empresa PELO cliente sai a parte e nao e falha do atendente.

const HUMAN_COMPANY = new Set(["ATENDENTE", "EMPRESA"]);
const MINUTE_MS = 60000;

// messages: [{ senderKind, createdAt, attendant }]. endAt (data ou ms) e o fim
// da janela para a espera em aberto; sem ele, vale a ultima mensagem.
function computeAttendanceMetrics(messages, { endAt = null } = {}) {
  const ordered = (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      kind: message.senderKind,
      at: toMs(message.createdAt),
      attendant: String(message.attendant || "").trim()
    }))
    .filter((message) => Number.isFinite(message.at))
    .sort((a, b) => a.at - b.at);

  const counts = { CLIENTE: 0, ATENDENTE: 0, EMPRESA: 0, AUTOMATICA: 0 };
  const waits = [];
  const attendants = new Set();
  let blockStart = null;
  let firstResponseMs = null;
  let lastHumanCompanyAt = null;
  let maxCompanyWaitMs = null;

  for (const message of ordered) {
    if (counts[message.kind] !== undefined) {
      counts[message.kind] += 1;
    }
    if (message.attendant) {
      attendants.add(message.attendant.toUpperCase());
    }

    if (message.kind === "CLIENTE") {
      if (blockStart === null) {
        blockStart = message.at;
      }
      if (lastHumanCompanyAt !== null) {
        maxCompanyWaitMs = Math.max(maxCompanyWaitMs ?? 0, message.at - lastHumanCompanyAt);
        lastHumanCompanyAt = null;
      }
    } else if (HUMAN_COMPANY.has(message.kind)) {
      if (blockStart !== null) {
        const wait = message.at - blockStart;
        waits.push(wait);
        if (firstResponseMs === null) {
          firstResponseMs = wait;
        }
        blockStart = null;
      }
      lastHumanCompanyAt = message.at;
    }
  }

  const first = ordered[0]?.at ?? null;
  const last = ordered[ordered.length - 1]?.at ?? null;
  const end = Math.max(toMs(endAt) || last || 0, last || 0);
  let openWaitMs = null;
  if (blockStart !== null) {
    openWaitMs = Math.max(0, end - blockStart);
  }

  const allWaits = openWaitMs === null ? waits : [...waits, openWaitMs];

  return {
    primeiraRespostaMinutos: toMinutes(firstResponseMs),
    tempoMedioRespostaMinutos: allWaits.length ? toMinutes(allWaits.reduce((sum, value) => sum + value, 0) / allWaits.length) : null,
    maiorEsperaClienteMinutos: allWaits.length ? toMinutes(Math.max(...allWaits)) : null,
    maiorEsperaAtendenteMinutos: toMinutes(maxCompanyWaitMs),
    mensagensCliente: counts.CLIENTE,
    mensagensAtendente: counts.ATENDENTE,
    mensagensEmpresa: counts.EMPRESA,
    mensagensAutomaticas: counts.AUTOMATICA,
    duracaoMinutos: first === null ? 0 : toMinutes(last - first),
    clienteAguardandoNoFim: openWaitMs !== null,
    teveTransferencia: attendants.size > 1
  };
}

// Alertas deterministicos gravados em system_alerts: nao dependem da IA.
// messages: [{ id, flags }]. Guarda so os ids das mensagens, nunca o texto.
function buildSystemAlerts(metrics, messages, { thresholdMinutes }) {
  const alerts = [];

  if (Number(metrics?.maiorEsperaClienteMinutos) > thresholdMinutes) {
    alerts.push({
      tipo: "CLIENTE_AGUARDANDO",
      minutos: metrics.maiorEsperaClienteMinutos,
      limiteMinutos: thresholdMinutes,
      emAberto: Boolean(metrics.clienteAguardandoNoFim)
    });
  }

  for (const flag of ["CANCELAMENTO", "ORGAO_EXTERNO"]) {
    const ids = (Array.isArray(messages) ? messages : [])
      .filter((message) => Array.isArray(message.flags) && message.flags.includes(flag))
      .map((message) => message.id);
    if (ids.length) {
      alerts.push({ tipo: flag, mensagens: ids });
    }
  }

  return alerts;
}

function toMs(value) {
  if (value === null || value === undefined || value === "") {
    return NaN;
  }
  if (typeof value === "number") {
    return value;
  }
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

// Uma casa decimal: e o que o painel e a IA precisam.
function toMinutes(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return null;
  }
  return Math.round((ms / MINUTE_MS) * 10) / 10;
}

module.exports = {
  buildSystemAlerts,
  computeAttendanceMetrics
};
