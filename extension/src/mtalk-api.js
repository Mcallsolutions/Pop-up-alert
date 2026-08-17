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
//   - 1 chamada GET /tags/list a cada 10 minutos (catalogo de TAGs em cache);
//   - 1 chamada GET /tickets por status monitorado (open e pending);
//   - paginas extras so quando ha mais tickets do que cabe em uma pagina;
//   - no maximo MAX_CONTACT_LOOKUPS chamadas GET /contacts/{id}, e so quando a
//     listagem nao trouxe as TAGs do cliente (ver fillContactTags).
// Fila, atendente, empresa e TAGs ja vem na listagem.
// Ver "Mtalk integration/mtalk-api-mapeamento.md".
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
  // Catalogo de TAGs: dado de cadastro, muda ainda menos que as filas.
  const TAG_CACHE_TTL_MS = 10 * 60 * 1000;
  // Teto de consultas ao cadastro do contato por leitura. So sao gastas com
  // ticket que continuaria no alerta e cujo contato veio sem o campo de TAGs.
  const MAX_CONTACT_LOOKUPS = 20;
  const MAX_TAGS_PER_TICKET = 10;
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
  // Catalogo vazio = /tags/list ainda nao respondeu. Nesse estado um vinculo
  // que veio so com id continua contando como TAG (ver resolveTagName).
  let tagCatalogCache = { byId: new Map(), names: [], loaded: false, expiresAt: 0 };
  let refreshedToken = "";
  let useShowAll = true;

  async function collect() {
    const now = new Date();
    const requests = { queues: 0, tags: 0, tickets: 0, contacts: 0 };
    const [queues, tagCatalog] = await Promise.all([resolveMonitoredQueues(requests), resolveTagCatalog(requests)]);
    const apiTickets = await fetchMonitoredTickets(queues.ids, requests);

    // O ticket cru anda junto do mapeado: fillContactTags precisa dos dois para
    // remapear apenas quem ainda aparece sem TAG.
    const mapeados = dedupeById(apiTickets)
      .map((apiTicket) => ({ apiTicket, ticket: mapApiTicket(apiTicket, now, tagCatalog) }))
      .filter((item) => item.ticket)
      .slice(0, MAX_TICKETS_PER_SNAPSHOT);

    await fillContactTags(mapeados, tagCatalog, now, requests);

    const tickets = mapeados.map((item) => item.ticket);

    return {
      tickets,
      diagnostics: {
        origem: "api-oficial",
        filas: queues.names,
        tagsCadastradas: tagCatalog.names.length,
        contatosConsultados: requests.contacts,
        ticketsRecebidos: apiTickets.length,
        ticketsMonitorados: tickets.length,
        requisicoes: requests.queues + requests.tags + requests.tickets + requests.contacts
      }
    };
  }

  // Catalogo oficial de TAGs. Serve para nomear o vinculo que a listagem manda
  // so com o id e para descartar vinculo de TAG ja excluida do cadastro.
  async function resolveTagCatalog(requests) {
    if (tagCatalogCache.expiresAt > Date.now()) {
      return tagCatalogCache;
    }

    try {
      const data = await requestMtalk("/tags/list");
      requests.tags += 1;
      const rawTags = Array.isArray(data) ? data : Array.isArray(data?.tags) ? data.tags : [];
      const byId = new Map();
      const names = [];

      for (const raw of rawTags) {
        const id = toId(raw?.id);
        const name = cleanText(raw?.name, 120);
        if (!id || !name || byId.has(id)) {
          continue;
        }
        byId.set(id, name);
        names.push(name);
      }

      tagCatalogCache = { byId, names, loaded: byId.size > 0, expiresAt: Date.now() + TAG_CACHE_TTL_MS };
    } catch (error) {
      // Sem o catalogo a leitura continua: TAG que vem com nome segue valendo e
      // TAG que vem so com id conta como vinculo sem nome.
      console.warn("[Mcall Ticket Tag Monitor] Nao foi possivel ler o catalogo de TAGs:", error.message);
      tagCatalogCache = { byId: new Map(), names: [], loaded: false, expiresAt: Date.now() + 60000 };
    }

    return tagCatalogCache;
  }

  // Segunda passada, so nos tickets que continuariam no alerta de TAG.
  //
  // Algumas instancias nao devolvem contact.tags dentro de GET /tickets. Nessas,
  // a TAG que o atendente vinculou ao CLIENTE nunca chegava aqui e o ticket
  // ficava preso no alerta. O custo fica preso em tres travas: so ticket sem
  // TAG, so ticket com atendente, e no maximo MAX_CONTACT_LOOKUPS por leitura.
  async function fillContactTags(items, tagCatalog, now, requests) {
    const pendentes = items
      .filter(
        (item) =>
          item.ticket.tagStatus === "SEM_TAG" &&
          String(item.ticket.attendant || "").trim() &&
          contactIdForTagLookup(item.apiTicket)
      )
      .slice(0, MAX_CONTACT_LOOKUPS);

    for (const item of pendentes) {
      const contactId = contactIdForTagLookup(item.apiTicket);

      try {
        const contact = await requestMtalk(`/contacts/${encodeURIComponent(contactId)}`);
        requests.contacts += 1;

        const contactTags = Array.isArray(contact?.tags) ? contact.tags : contact?.contactTags;
        if (!Array.isArray(contactTags) || !contactTags.length) {
          continue;
        }

        item.ticket = mapApiTicket(item.apiTicket, now, tagCatalog, contactTags) || item.ticket;
      } catch (error) {
        // Erro aqui costuma ser da sessao ou da instancia, nao daquele contato:
        // insistir nos demais so gastaria requisicao.
        requests.contacts += 1;
        console.warn(`[Mcall Ticket Tag Monitor] Nao foi possivel ler as TAGs do contato ${contactId}:`, error.message);
        return;
      }
    }
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

  function mapApiTicket(apiTicket, now, tagCatalog = null, contactTags = []) {
    const queue = normalizeQueueName(apiTicket?.queue?.name);
    if (!queue) {
      return null;
    }

    const externalTicketId = cleanText(apiTicket?.id, 40);
    if (!externalTicketId) {
      return null;
    }

    // TAG do atendimento E TAG do cliente: as duas tiram o ticket do alerta.
    const tags = collectTagNames(apiTicket, tagCatalog, contactTags);
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

  // Uma TAG pode chegar em dois lugares diferentes na resposta de GET /tickets:
  //   - ticket.tags[]         -> TAG marcada no proprio atendimento;
  //   - ticket.contact.tags[] -> TAG marcada no CLIENTE (contato).
  // O painel do MTalk mostra as duas no mesmo campo, entao para o atendente e
  // tudo "a TAG do cliente". Ler so a primeira era o que mantinha o ticket na
  // lista de alerta depois de o atendente vincular a TAG ao contato.
  function collectTagNames(apiTicket, catalog, extraTags) {
    const sources = [apiTicket?.tags, apiTicket?.contact?.tags, apiTicket?.contact?.contactTags, extraTags];
    const names = [];

    for (const source of sources) {
      if (!Array.isArray(source)) {
        continue;
      }

      for (const value of source) {
        const name = resolveTagName(value, catalog);
        if (name && !names.includes(name)) {
          names.push(name);
        }
        if (names.length >= MAX_TAGS_PER_TICKET) {
          return names;
        }
      }
    }

    return names;
  }

  // Formatos aceitos, todos vistos na API: "Nome", { id, name }, { tagId, tag }
  // e o id puro. Em linha de vinculo (ContactTag) o "id" e o da LINHA, nao o da
  // TAG — por isso tagId/tag.id vem antes.
  function resolveTagName(value, catalog) {
    if (value === null || value === undefined) {
      return "";
    }

    if (typeof value === "number") {
      return resolveTagId(value, catalog);
    }

    if (typeof value === "string") {
      const text = cleanText(value, 120);
      if (!text) {
        return "";
      }
      return /^\d+$/.test(text) ? resolveTagId(Number(text), catalog) : text;
    }

    if (typeof value === "object") {
      const name = cleanText(value.name ?? value.tag?.name ?? value.tagName, 120);
      if (name) {
        return name;
      }
      const id = toId(value.tagId ?? value.tag?.id ?? value.id);
      return id ? resolveTagId(id, catalog) : "";
    }

    return "";
  }

  function resolveTagId(id, catalog) {
    const tagId = toId(id);
    if (!tagId) {
      return "";
    }

    const name = catalog?.byId?.get(tagId);
    if (name) {
      return name;
    }

    // Com o catalogo carregado, id desconhecido e vinculo orfao: descarta. Sem
    // catalogo, o vinculo vale — so nao da para nomear a TAG.
    return catalog?.loaded ? "" : `TAG ${tagId}`;
  }

  // Nem toda instancia devolve as TAGs do contato dentro da listagem. Quando o
  // campo vem AUSENTE (diferente de vir vazio), so consultando o cadastro do
  // contato da para saber se o cliente ja foi marcado.
  function contactIdForTagLookup(apiTicket) {
    const contact = apiTicket?.contact;
    if (Array.isArray(contact?.tags) || Array.isArray(contact?.contactTags)) {
      return 0;
    }

    return toId(contact?.id ?? apiTicket?.contactId);
  }

  function toId(value) {
    const parsed = Number.parseInt(String(value ?? "").trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
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
