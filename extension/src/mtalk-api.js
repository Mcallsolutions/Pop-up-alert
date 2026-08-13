// Leitura dos tickets pela API oficial do MTalk (Ticketz).
//
// Roda no content script, dentro da propria pagina do painel, entao:
//   - o token e o mesmo da sessao aberta (localStorage["token"]), sem segredo
//     novo para configurar e sem tela de login extra;
//   - as chamadas sao de MESMA ORIGEM (s11.mtalk.com.br -> /backend), entao
//     nao ha CORS envolvido.
//
// Custo por leitura, de proposito baixo:
//   - 1 chamada GET /queue a cada 10 minutos (lista de filas em cache);
//   - 1 chamada GET /tickets por status monitorado (open e pending);
//   - paginas extras so quando ha mais tickets do que cabe em uma pagina.
// Nenhuma chamada por ticket: fila, atendente, empresa e tags ja vem na
// listagem. Ver "Mtalk integration/mtalk-api-mapeamento.md".
(() => {
  const API_PATH = "/backend";
  const TOKEN_STORAGE_KEY = "token";
  // Tickets em atendimento. "closed" fica de fora: ticket encerrado nao gera
  // alerta de TAG nem de inatividade.
  const TICKET_STATUSES = ["open", "pending"];
  // O backend pagina de 40 em 40; 5 paginas = 200 tickets, o teto do snapshot.
  const PAGE_SIZE = 40;
  const MAX_PAGES = 5;
  const QUEUE_CACHE_TTL_MS = 10 * 60 * 1000;
  // Mesmo teto aceito por POST /api/tickets/snapshot.
  const MAX_TICKETS_PER_SNAPSHOT = 500;
  const REQUEST_TIMEOUT_MS = 12000;
  const MAX_INACTIVITY_MINUTES = 24 * 60;

  // Os mesmos parametros monitorados desde a versao que lia a tela.
  const ALLOWED_QUEUE_CODES = new Set(["TERRANET", "PLANET", "MIX", "IDEZ", "BDG", "AIA"]);
  const ALLOWED_QUEUE_LABELS = {
    TERRANET: "TerraNet",
    PLANET: "PLANET",
    MIX: "MIX",
    IDEZ: "IDEZ",
    BDG: "BDG",
    AIA: "AIA"
  };
  const KNOWN_ATTENDANTS = new Map([
    ["STEPHANIE", "Stephanie"],
    ["GABRIEL OLIVEIRA", "Gabriel Oliveira"],
    ["GABRIELL CARVALHO", "Gabriell Carvalho"],
    ["GUILHERME GOMES", "Guilherme Gomes"],
    ["LUIS OTAVIO", "Luis otavio"],
    ["ALEK", "Aleksandro"],
    ["ALEKSANDRO", "Aleksandro"]
  ]);
  const INACTIVITY_THRESHOLD_MINUTES = 15;

  // A API devolve datas em UTC; o painel mostra em BRT.
  const displayTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  let queueCache = { ids: [], names: [], expiresAt: 0 };
  let refreshedToken = "";
  let useShowAll = true;

  async function collect() {
    const now = new Date();
    const requests = { queues: 0, tickets: 0 };
    const queues = await resolveMonitoredQueues(requests);
    const apiTickets = await fetchMonitoredTickets(queues.ids, requests);

    const tickets = dedupeById(apiTickets)
      .map((apiTicket) => mapApiTicket(apiTicket, now))
      .filter(Boolean)
      .slice(0, MAX_TICKETS_PER_SNAPSHOT);

    return {
      tickets,
      diagnostics: {
        origem: "api-oficial",
        filas: queues.names,
        ticketsRecebidos: apiTickets.length,
        ticketsMonitorados: tickets.length,
        requisicoes: requests.queues + requests.tickets
      }
    };
  }

  // Os ids das filas mudam pouco; sem o cache cada leitura gastaria uma
  // chamada extra so para redescobrir os mesmos ids.
  async function resolveMonitoredQueues(requests) {
    if (queueCache.expiresAt > Date.now()) {
      return queueCache;
    }

    try {
      const data = await requestMtalk("/queue");
      requests.queues += 1;
      const monitored = (Array.isArray(data) ? data : []).filter((queue) => normalizeQueueName(queue?.name));
      queueCache = {
        ids: monitored.map((queue) => Number(queue.id)).filter(Number.isFinite),
        names: monitored.map((queue) => String(queue.name)),
        expiresAt: Date.now() + QUEUE_CACHE_TTL_MS
      };
    } catch (error) {
      // Sem a lista de filas a leitura continua: o filtro por nome faz o mesmo
      // recorte, so que descartando os tickets depois de recebidos.
      console.warn("[Mcall Ticket Tag Monitor] Nao foi possivel listar as filas:", error.message);
      queueCache = { ids: [], names: [], expiresAt: Date.now() + 60000 };
    }

    return queueCache;
  }

  async function fetchMonitoredTickets(queueIds, requests) {
    const collected = [];

    for (const status of TICKET_STATUSES) {
      for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
        const query = { status, pageNumber };
        if (queueIds.length) {
          query.queueIds = JSON.stringify(queueIds);
        }

        const data = await requestTickets(query, requests);

        const page = Array.isArray(data?.tickets) ? data.tickets : [];
        collected.push(...page);

        if (!data?.hasMore || !page.length || page.length < PAGE_SIZE) {
          break;
        }
      }
    }

    return collected;
  }

  // "showAll" so e aceito para perfis administrativos. Quando o MTalk recusa,
  // a leitura segue sem ele: o usuario ja enxerga as filas as quais pertence.
  async function requestTickets(query, requests) {
    if (useShowAll) {
      try {
        const data = await requestMtalk("/tickets", { query: { ...query, showAll: "true" } });
        requests.tickets += 1;
        return data;
      } catch (error) {
        requests.tickets += 1;
        if (error.code !== "erro_na_api") {
          throw error;
        }
        useShowAll = false;
        console.warn("[Mcall Ticket Tag Monitor] showAll recusado pelo MTalk; lendo apenas as filas do usuario.");
      }
    }

    const data = await requestMtalk("/tickets", { query });
    requests.tickets += 1;
    return data;
  }

  function mapApiTicket(apiTicket, now) {
    const queue = normalizeQueueName(apiTicket?.queue?.name);
    if (!queue) {
      return null;
    }

    const externalTicketId = cleanText(apiTicket?.id, 40);
    if (!externalTicketId) {
      return null;
    }

    const tags = extractTagNames(apiTicket?.tags);
    const lastActivityAt = parseDate(apiTicket?.updatedAt) || parseDate(apiTicket?.createdAt);

    return {
      // O id do ticket e estavel entre leituras, ao contrario da chave montada
      // com cliente/fila/horario que a leitura de tela precisava usar.
      ticketKey: `mtalk:${externalTicketId}`,
      externalTicketId,
      ticketUuid: cleanText(apiTicket?.uuid, 60),
      ticketStatus: cleanText(apiTicket?.status, 20).toLowerCase(),
      clientName: cleanText(apiTicket?.contact?.name, 160),
      queue,
      attendant: normalizeAttendantName(apiTicket?.user?.name),
      company: cleanText(apiTicket?.whatsapp?.name, 120),
      displayTime: lastActivityAt ? displayTimeFormatter.format(lastActivityAt) : "",
      lastMessageAt: lastActivityAt ? lastActivityAt.toISOString() : "",
      inactivityMinutes: calculateInactivityMinutes(lastActivityAt, now),
      unreadMessages: cleanNonNegativeInteger(apiTicket?.unreadMessages),
      tag: tags[0] || null,
      tags,
      tagStatus: tags.length ? "COM_TAG" : "SEM_TAG"
    };
  }

  async function requestMtalk(path, { query = {}, method = "GET", allowRefresh = true } = {}) {
    const token = getSessionToken();
    if (!token) {
      throw buildError(
        "Sessao do MTalk nao encontrada. Faca login no painel para a extensao conseguir ler os tickets.",
        "sem_token"
      );
    }

    const url = new URL(`${window.location.origin}${API_PATH}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetchWithTimeout(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      credentials: "same-origin"
    });

    // O token da sessao expira sozinho; o painel renova pelo refresh_token, que
    // depende do cookie da propria pagina — e por isso funciona daqui tambem.
    if (response.status === 401 && allowRefresh && (await refreshSessionToken())) {
      return requestMtalk(path, { query, method, allowRefresh: false });
    }

    if (!response.ok) {
      // Se nem o token renovado foi aceito, ele deixa de valer: a proxima
      // leitura volta a usar o que estiver no localStorage do painel.
      if (response.status === 401) {
        refreshedToken = "";
      }
      throw buildError(describeHttpFailure(response, url), response.status === 401 ? "sessao_expirada" : "erro_na_api");
    }

    return response.json().catch(() => ({}));
  }

  async function refreshSessionToken() {
    try {
      const response = await fetchWithTimeout(`${window.location.origin}${API_PATH}/auth/refresh_token`, {
        method: "POST",
        credentials: "same-origin"
      });

      if (!response.ok) {
        refreshedToken = "";
        return false;
      }

      const data = await response.json().catch(() => ({}));
      // O token novo fica so em memoria: escrever no localStorage do painel
      // poderia atrapalhar o estado da propria aplicacao do MTalk.
      refreshedToken = cleanText(data?.token, 4000);
      return Boolean(refreshedToken);
    } catch (_error) {
      return false;
    }
  }

  async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      const motivo = error?.name === "AbortError" ? `nao respondeu em ${REQUEST_TIMEOUT_MS}ms` : error?.message;
      throw buildError(`Falha ao falar com a API do MTalk: ${motivo}`, "erro_na_api");
    } finally {
      window.clearTimeout(timer);
    }
  }

  // O painel guarda o token em localStorage["token"], em JSON (com aspas).
  function getSessionToken() {
    if (refreshedToken) {
      return refreshedToken;
    }

    const raw = window.localStorage.getItem(TOKEN_STORAGE_KEY) || "";
    if (!raw) {
      return "";
    }

    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : cleanText(parsed?.token, 4000);
    } catch (_error) {
      return raw.trim().replace(/^"|"$/g, "");
    }
  }

  function describeHttpFailure(response, url) {
    if (response.status === 401 || response.status === 403) {
      return "A API do MTalk recusou a sessao. Recarregue o painel e faca login novamente.";
    }

    if (response.status === 404) {
      return `A API do MTalk respondeu 404 para ${url.pathname}. A instancia pode publicar o backend em outro caminho.`;
    }

    return `A API do MTalk respondeu ${response.status} para ${url.pathname}.`;
  }

  function dedupeById(apiTickets) {
    const seen = new Set();
    return apiTickets.filter((apiTicket) => {
      const id = cleanText(apiTicket?.id, 40);
      if (!id || seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });
  }

  function extractTagNames(tags) {
    if (!Array.isArray(tags)) {
      return [];
    }

    return tags
      .map((tag) => cleanText(typeof tag === "string" ? tag : tag?.name, 120))
      .filter(Boolean)
      .filter((name, index, names) => names.indexOf(name) === index)
      .slice(0, 10);
  }

  function calculateInactivityMinutes(lastActivityAt, now) {
    if (!lastActivityAt) {
      return null;
    }

    const minutes = Math.floor((now.getTime() - lastActivityAt.getTime()) / 60000);
    if (!Number.isFinite(minutes) || minutes < 0) {
      return 0;
    }

    return Math.min(minutes, MAX_INACTIVITY_MINUTES);
  }

  function normalizeQueueName(value) {
    const match = cleanText(value, 120).match(/Suporte\s*-\s*([A-Za-z0-9_-]+)/i);
    if (!match) {
      return "";
    }

    const code = match[1].replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    return ALLOWED_QUEUE_CODES.has(code) ? `Suporte-${ALLOWED_QUEUE_LABELS[code]}` : "";
  }

  // user.name vem do cadastro do usuario, entao aqui so unificamos as
  // variacoes conhecidas do mesmo atendente ("Alek" -> "Aleksandro").
  function normalizeAttendantName(value) {
    const text = cleanText(value, 100);
    if (!text) {
      return "";
    }

    const key = text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase();

    return KNOWN_ATTENDANTS.get(key) || text;
  }

  function parseDate(value) {
    if (!value) {
      return null;
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function cleanNonNegativeInteger(value) {
    const parsed = Number.parseInt(String(value ?? "").trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  function cleanText(value, maxLength) {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength);
  }

  function buildError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  window.McallMtalkApi = {
    INACTIVITY_THRESHOLD_MINUTES,
    TICKET_STATUSES,
    collect,
    getMonitoredQueues: () => Array.from(ALLOWED_QUEUE_CODES).map((code) => `Suporte-${ALLOWED_QUEUE_LABELS[code]}`),
    hasSession: () => Boolean(getSessionToken())
  };
})();
