// Alertas de inatividade no WhatsApp (WHATSAPP_ALERTS=1; desligado por padrao).
//
// Depois de cada coleta gravada, o coletor passa os tickets que estao acima do
// limite de inatividade (mesma regra do pop-up da extensao). Daqui sai UMA
// mensagem por coleta para cada destinatario, so com os tickets que acabaram de
// passar do limite — o mesmo ticket nao e avisado de novo enquanto continuar
// parado, a nao ser que WHATSAPP_REMINDER_MINUTES peca lembrete. Quando o ticket
// volta a ter atividade (sai da lista), a proxima parada gera aviso novo.
//
// Provedores gratuitos suportados (WHATSAPP_PROVIDER):
// - evolution: Evolution API v2, codigo aberto, roda na propria VPS com um
//   numero dedicado conectado por QR Code. Envia para numero ou grupo;
// - waha: WAHA (WhatsApp HTTP API), mesma ideia, tambem auto-hospedado;
// - callmebot: servico gratuito so para uso pessoal — cada destinatario ativa
//   o proprio numero e recebe uma apikey. Nao envia para grupo.
// Evolution e WAHA nao sao a API oficial da Meta: use um numero so para isso.
//
// Travas: no maximo WHATSAPP_MAX_PER_HOUR mensagens por destinatario por hora;
// falha de envio espera FAILURE_COOLDOWN_MS antes de tentar de novo. O nome do
// cliente so vai na mensagem com WHATSAPP_INCLUDE_CLIENT_NAME=1. Numero e chave
// nunca aparecem em log nem no painel inteiros.

const { getWhatsappConfig } = require("../config/monitoring");
const { formatTime } = require("./time-zone");

const HOUR_MS = 60 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_ITEMS_PER_MESSAGE = 10;
const MAX_ERROR_LENGTH = 200;
// Estado em memoria, como o resto da coleta. Reiniciar a API esquece o que ja
// foi avisado: a primeira coleta depois manda um aviso com os parados do momento.
// ticketId -> { notifiedAt }
const notified = new Map();
let sentRounds = [];
let cooldownUntil = 0;
let running = null;
let lastSend = null;

// Chamado pelo coletor depois da coleta gravada, sem await.
function startWhatsappAlerts({ tickets = [], thresholdMinutes, now = new Date() } = {}) {
  const config = getWhatsappConfig();
  if (!config.enabled) {
    return null;
  }
  if (running) {
    // A proxima coleta pega o que ficar para tras.
    return running;
  }

  running = notifyInactiveTickets({ config, tickets, thresholdMinutes, now })
    .catch((error) => {
      console.warn("[WhatsApp] Falha ao enviar o alerta de inatividade:", error.publicMessage || error.message);
    })
    .finally(() => {
      running = null;
    });
  return running;
}

async function notifyInactiveTickets({ config, tickets, thresholdMinutes, now }) {
  const problem = describeConfigProblem(config);
  if (problem) {
    lastSend = { em: now.toISOString(), ok: false, erro: problem, tickets: 0 };
    return null;
  }

  const agora = now.getTime();
  const atuais = new Map(tickets.map((ticket) => [String(ticket.externalTicketId), ticket]));

  // Saiu da lista = voltou a ter atividade (ou fechou): a proxima parada avisa de novo.
  for (const ticketId of notified.keys()) {
    if (!atuais.has(ticketId)) notified.delete(ticketId);
  }

  const novos = [];
  const lembretes = [];
  for (const [ticketId, ticket] of atuais) {
    const anterior = notified.get(ticketId);
    if (!anterior) {
      novos.push(ticket);
    } else if (config.reminderMinutes && agora - anterior.notifiedAt >= config.reminderMinutes * 60000) {
      lembretes.push(ticket);
    }
  }

  if (!novos.length && !lembretes.length) {
    return null;
  }
  if (agora < cooldownUntil) {
    return null;
  }
  if (!hasBudget(config, agora)) {
    lastSend = { ...(lastSend || {}), semOrcamento: true };
    return null;
  }

  const text = buildAlertMessage({
    novos,
    lembretes,
    totalParados: atuais.size,
    thresholdMinutes,
    includeClientName: config.includeClientName,
    now
  });
  const result = await sendToAll(config, text, agora);

  if (result.enviados) {
    for (const ticket of [...novos, ...lembretes]) {
      notified.set(String(ticket.externalTicketId), { notifiedAt: agora });
    }
  } else {
    cooldownUntil = agora + FAILURE_COOLDOWN_MS;
  }

  lastSend = {
    em: now.toISOString(),
    ok: result.falhas === 0,
    erro: result.erros[0] || null,
    tickets: novos.length + lembretes.length,
    enviados: result.enviados,
    falhas: result.falhas
  };
  return lastSend;
}

// Botao "Enviar teste" do painel. Conta no limite da hora, mas nao e barrado
// por ele nem pela espera depois de falha: e uma decisao do administrador.
async function sendTestMessage({ requestedBy = null } = {}) {
  const config = getWhatsappConfig();
  if (!config.enabled) {
    throwPublic(403, "Os alertas no WhatsApp estao desligados. Defina WHATSAPP_ALERTS=1 no .env e reinicie a API.");
  }
  const problem = describeConfigProblem(config);
  if (problem) {
    throwPublic(400, problem);
  }

  const now = new Date();
  const text = [
    "*Mcall*",
    `Mensagem de teste dos alertas de inatividade${requestedBy ? `, pedida por ${requestedBy}` : ""}, ${formatTime(now)}.`,
    "Se ela chegou, os avisos de inatividade vao chegar aqui."
  ].join("\n");

  const result = await sendToAll(config, text, now.getTime());
  return {
    ok: result.falhas === 0,
    enviados: result.enviados,
    falhas: result.falhas,
    destinatarios: result.detalhes
  };
}

async function sendToAll(config, text, agora) {
  const send = PROVIDERS[config.provider];
  const detalhes = [];

  for (const recipient of config.recipients) {
    try {
      await send({ config, recipient, text });
      detalhes.push({ destinatario: maskRecipient(recipient), ok: true });
    } catch (error) {
      const message = cleanError(error);
      console.warn(`[WhatsApp] Envio para ${maskRecipient(recipient)} falhou: ${message}`);
      detalhes.push({ destinatario: maskRecipient(recipient), ok: false, erro: message });
    }
  }

  sentRounds.push(agora);
  const enviados = detalhes.filter((item) => item.ok).length;
  return {
    enviados,
    falhas: detalhes.length - enviados,
    erros: detalhes.filter((item) => !item.ok).map((item) => `${item.destinatario}: ${item.erro}`),
    detalhes
  };
}

function hasBudget(config, agora) {
  sentRounds = sentRounds.filter((at) => at > agora - HOUR_MS);
  return sentRounds.length < config.maxPerHour;
}

// ---------------------------------------------------------------------------
// Mensagem

function buildAlertMessage({ novos, lembretes, totalParados, thresholdMinutes, includeClientName, now }) {
  const itens = [...novos, ...lembretes].sort(
    (a, b) => Number(b.inactivityMinutes || 0) - Number(a.inactivityMinutes || 0)
  );
  const lembreteIds = new Set(lembretes.map((ticket) => String(ticket.externalTicketId)));
  const titulo = novos.length
    ? `${novos.length} ${novos.length === 1 ? "cliente passou" : "clientes passaram"} de ${thresholdMinutes} min sem atividade`
    : `${lembretes.length} ${lembretes.length === 1 ? "cliente continua parado" : "clientes continuam parados"} (lembrete)`;

  const linhas = [`*Mcall — clientes parados* (${formatTime(now)})`, titulo, ""];

  for (const ticket of itens.slice(0, MAX_ITEMS_PER_MESSAGE)) {
    const partes = [
      includeClientName && String(ticket.clientName || "").trim() ? String(ticket.clientName).trim() : null,
      ticket.queue || "Sem fila",
      String(ticket.attendant || "").trim() || "sem atendente",
      ticket.company || null
    ].filter(Boolean);
    const lembrete = lembreteIds.has(String(ticket.externalTicketId)) ? " (lembrete)" : "";
    linhas.push(`• ${partes.join(" · ")} — *${formatMinutes(ticket.inactivityMinutes)}*${lembrete}`);
    if (ticket.url) {
      linhas.push(`  ${ticket.url}`);
    }
  }

  if (itens.length > MAX_ITEMS_PER_MESSAGE) {
    const resto = itens.length - MAX_ITEMS_PER_MESSAGE;
    linhas.push(`+${resto} ${resto === 1 ? "outro" : "outros"} no painel`);
  }

  linhas.push("", `Parados agora: ${totalParados}`);
  return linhas.join("\n");
}

function formatMinutes(value) {
  const minutos = Math.max(0, Math.round(Number(value) || 0));
  if (minutos < 60) return `${minutos} min`;
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  return resto ? `${horas}h${String(resto).padStart(2, "0")}` : `${horas}h`;
}

// ---------------------------------------------------------------------------
// Provedores

const PROVIDERS = {
  // POST {url}/message/sendText/{instancia}, header apikey. number aceita o
  // telefone com DDI (5511999999999) ou o id do grupo (...@g.us).
  async evolution({ config, recipient, text }) {
    await postJson(`${config.apiUrl}/message/sendText/${encodeURIComponent(config.instance)}`, {
      headers: { apikey: config.apiKey },
      body: { number: recipient, text },
      timeoutMs: config.timeoutMs
    });
  },

  // POST {url}/api/sendText, header X-Api-Key (opcional no WAHA sem chave).
  async waha({ config, recipient, text }) {
    const chatId = recipient.includes("@") ? recipient : `${onlyDigits(recipient)}@c.us`;
    await postJson(`${config.apiUrl}/api/sendText`, {
      headers: config.apiKey ? { "X-Api-Key": config.apiKey } : {},
      body: { session: config.instance, chatId, text },
      timeoutMs: config.timeoutMs
    });
  },

  // GET https://api.callmebot.com/whatsapp.php?phone=&text=&apikey=. Cada
  // destinatario vem como "telefone:apikey". A URL leva a chave: nunca logar.
  async callmebot({ config, recipient, text }) {
    const [phone, apikey] = splitCallmebotRecipient(recipient);
    const url = new URL(config.apiUrl || "https://api.callmebot.com/whatsapp.php");
    url.searchParams.set("phone", `+${phone}`);
    url.searchParams.set("text", text);
    url.searchParams.set("apikey", apikey);

    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(config.timeoutMs) });
    const body = await response.text().catch(() => "");
    // O CallMeBot responde HTML, as vezes com 200 mesmo quando recusa.
    if (!response.ok || (!/queued|sent/i.test(body) && /invalid|error/i.test(body))) {
      throw providerError(response.status, stripHtml(body));
    }
  }
};

async function postJson(url, { headers, body, timeoutMs }) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw providerError(response.status, readErrorMessage(text));
  }
}

function describeConfigProblem(config) {
  if (!config.provider) {
    return `WHATSAPP_PROVIDER "${config.providerName}" nao e suportado. Use evolution, waha ou callmebot.`;
  }
  if (!config.recipients.length) {
    return "Defina WHATSAPP_RECIPIENTS no .env: os numeros (com DDI) ou grupos que recebem os alertas.";
  }
  if (config.provider !== "callmebot" && !config.apiUrl) {
    return "Defina WHATSAPP_API_URL no .env: o endereco da sua Evolution API ou WAHA.";
  }
  if (config.provider === "evolution" && !config.apiKey) {
    return "Defina WHATSAPP_API_KEY no .env: a chave (apikey) da instancia na Evolution API.";
  }
  if (config.provider === "callmebot") {
    const invalido = config.recipients.find((recipient) => !splitCallmebotRecipient(recipient));
    if (invalido !== undefined) {
      return 'No CallMeBot cada destinatario e "telefone:apikey" (ex.: 5511999999999:123456), separados por virgula.';
    }
  }
  return "";
}

function splitCallmebotRecipient(recipient) {
  const [phone, apikey] = String(recipient || "").split(":").map((part) => part.trim());
  return onlyDigits(phone).length >= 10 && apikey ? [onlyDigits(phone), apikey] : null;
}

// ---------------------------------------------------------------------------
// Status do painel

function describeWhatsappStatus() {
  const config = getWhatsappConfig();
  const agora = Date.now();
  sentRounds = sentRounds.filter((at) => at > agora - HOUR_MS);

  return {
    ligado: config.enabled,
    provedor: config.providerName,
    problema: config.enabled ? describeConfigProblem(config) || null : null,
    destinatarios: config.recipients.map(maskRecipient),
    incluiNomeCliente: config.includeClientName,
    lembreteMinutos: config.reminderMinutes,
    orcamentoHora: { usadas: sentRounds.length, limite: config.maxPerHour },
    ticketsAvisados: notified.size,
    aguardandoAposFalhaAte: cooldownUntil > agora ? new Date(cooldownUntil).toISOString() : null,
    enviando: Boolean(running),
    ultimoEnvio: lastSend
  };
}

// So os ultimos digitos, para o painel e o log: o resto e dado pessoal.
function maskRecipient(recipient) {
  const value = String(recipient || "").split(":")[0].trim();
  if (value.endsWith("@g.us")) {
    return `grupo …${value.replace("@g.us", "").slice(-4)}`;
  }
  const digits = onlyDigits(value);
  return digits.length > 4 ? `${"•".repeat(Math.min(digits.length - 4, 8))}${digits.slice(-4)}` : "••••";
}

// ---------------------------------------------------------------------------
// Utilitarios

function providerError(status, detail) {
  const error = new Error(`HTTP ${status}${detail ? ` — ${detail}` : ""}`);
  error.statusCode = 502;
  return error;
}

function readErrorMessage(text) {
  try {
    const json = JSON.parse(text);
    const message = json?.response?.message ?? json?.message ?? json?.error;
    return Array.isArray(message) ? message.join("; ") : String(message ?? "");
  } catch (_error) {
    return stripHtml(text);
  }
}

function cleanError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return "o provedor nao respondeu a tempo";
  }
  return String(error?.message || error || "erro desconhecido").slice(0, MAX_ERROR_LENGTH);
}

function stripHtml(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_LENGTH);
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function throwPublic(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  throw error;
}

// Para os testes: espera o envio em andamento e zera o estado em memoria.
async function resetWhatsappAlerts() {
  await (running || Promise.resolve());
  notified.clear();
  sentRounds = [];
  cooldownUntil = 0;
  lastSend = null;
}

module.exports = {
  buildAlertMessage,
  describeWhatsappStatus,
  maskRecipient,
  resetWhatsappAlerts,
  sendTestMessage,
  startWhatsappAlerts
};
