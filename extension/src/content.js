(() => {
  const SCAN_INTERVAL_MS = 60 * 1000;
  const MUTATION_DEBOUNCE_MS = 1200;
  const ONE_MINUTE_MS = 60 * 1000;
  const INACTIVITY_THRESHOLD_MINUTES = 15;
  const ALERT_SNOOZE_MS = 5 * ONE_MINUTE_MS;
  const ALERT_ROOT_ID = "mcall-ticket-tag-alert-root";
  const PARSER_VERSION = "1.3.0";

  let scanTimer = null;
  let mutationTimer = null;
  let observer = null;
  let currentMissingTagAlertTickets = [];
  let currentInactivityAlertTickets = [];
  let alertSnoozedUntil = 0;
  let lastCollectDiagnostics = emptyCollectDiagnostics();

  const COMPANY_PREFIXES = ["NETFIBRA", "MIX", "IDEZ", "TERRA", "PLANET"];
  const KNOWN_ATTENDANTS = new Map([
    ["STEPHANIE", "Stephanie"],
    ["GABRIEL OLIVEIRA", "Gabriel Oliveira"],
    ["GABRIELL CARVALHO", "Gabriell Carvalho"],
    ["GUILHERME GOMES", "Guilherme Gomes"],
    ["LUIS OTAVIO", "Luis otavio"],
    ["ALEK", "Aleksandro"],
    ["ALEKSANDRO", "Aleksandro"]
  ]);
  const ALLOWED_QUEUE_CODES = new Set(["TERRANET", "PLANET", "MIX", "IDEZ", "BDG", "AIA"]);
  const ALLOWED_QUEUE_LABELS = {
    TERRANET: "TerraNet",
    PLANET: "PLANET",
    MIX: "MIX",
    IDEZ: "IDEZ",
    BDG: "BDG",
    AIA: "AIA"
  };
  const TAG_PATTERNS = [
    /^[A-Z0-9]{2,12}\s*[-–—]\s*[A-Z0-9][A-Z0-9\s./&()+_]{1,}$/u,
    /^[A-Z0-9]{2,12}[-–—][A-Z0-9][A-Z0-9\s./&()+_]{1,}$/u
  ];
  const QUEUE_PATTERN = /Suporte\s*-\s*([A-Za-z0-9_-]+)/i;
  const TIME_PATTERN = /\b([01]\d|2[0-3]):[0-5]\d\b/;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "FORCE_SCAN_FROM_POPUP") {
      scanAndSend("manual")
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    return false;
  });

  startMonitor();

  function startMonitor() {
    injectAlertStyles();
    scanAndSend("initial").catch(reportScanError);
    scanTimer = window.setInterval(() => {
      scanAndSend("interval").catch(reportScanError);
    }, SCAN_INTERVAL_MS);
    observer = new MutationObserver(() => {
      window.clearTimeout(mutationTimer);
      mutationTimer = window.setTimeout(() => scanAndSend("mutation").catch(reportScanError), MUTATION_DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener("beforeunload", cleanup);
  }

  function cleanup() {
    window.clearInterval(scanTimer);
    window.clearTimeout(mutationTimer);
    observer?.disconnect();
  }

  async function scanAndSend(reason) {
    const tickets = parseTicketsFromDOM();
    const missingTickets = tickets.filter((ticket) => ticket.tagStatus === "SEM_TAG");
    const inactiveTickets = tickets.filter(isInactiveTicket);
    const diagnostics = buildDiagnostics(reason, tickets);

    renderTicketAlerts(missingTickets, inactiveTickets, { force: reason === "manual" });

    const payload = {
      source: "mtalk",
      url: window.location.href,
      collectedAt: toOffsetIso(new Date()),
      diagnostics,
      tickets: tickets.map(({ debug, ...ticket }) => ticket)
    };

    const response = await sendRuntimeMessage({ type: "SNAPSHOT_READY", payload });
    window.dispatchEvent(
      new CustomEvent("mcall-ticket-monitor:scan", {
        detail: {
          reason,
          diagnostics,
          tickets: payload.tickets,
          response
        }
      })
    );

    return {
      ok: response?.ok !== false,
      totalTickets: tickets.length,
      missingTags: missingTickets.length,
      inactiveTickets: inactiveTickets.length,
      sent: response?.ok === true,
      diagnostics,
      error: response?.error || ""
    };
  }

  function reportScanError(error) {
    console.error("[Mcall Ticket Tag Monitor]", error);
    sendRuntimeMessage({
      type: "SNAPSHOT_READY",
      payload: {
        source: "mtalk",
        url: window.location.href,
        collectedAt: toOffsetIso(new Date()),
        diagnostics: {
          parserVersion: PARSER_VERSION,
          reason: "error",
          captureStatus: "erro_na_captura",
          parserMessage: error.message || "Erro desconhecido na captura",
          candidateCount: 0,
          selectedCount: 0,
          visibleTextLength: getVisibleText(document.body).length
        },
        tickets: []
      }
    });
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          resolve(response || { ok: false, error: chrome.runtime.lastError?.message || "" });
        });
      } catch (error) {
        resolve({ ok: false, error: error.message });
      }
    });
  }

  function parseTicketsFromDOM() {
    return collectTicketElements()
      .map((ticketElement, index) => parseTicketElement(ticketElement, index))
      .filter(Boolean)
      .filter((ticket) => isAllowedQueue(ticket.queue))
      .filter((ticket, index, tickets) => tickets.findIndex((item) => item.ticketKey === ticket.ticketKey) === index);
  }

  function collectTicketElements() {
    const specificSelectors = [
      '[role="listitem"]',
      "li",
      "article",
      '[role="button"]',
      '[data-testid*="ticket" i]',
      '[aria-label*="ticket" i]',
      '[class*="MuiListItem" i]',
      '[class*="MuiPaper" i]',
      '[class*="MuiButtonBase" i]',
      '[class*="ticket" i]'
    ];
    const broadSelectors = ["main div", '[id*="ticket" i]', '[class*="conversation" i]', '[class*="card" i]'];

    const specific = scoreCandidates(document.querySelectorAll(specificSelectors.join(",")), "specific");
    let candidates = specific.filter((candidate) => candidate.score >= 6);

    if (!candidates.length) {
      candidates = scoreCandidates(document.querySelectorAll(broadSelectors.join(",")), "broad").filter(
        (candidate) => candidate.score >= 7
      );
    }

    const selected = selectBestTicketElements(candidates);
    lastCollectDiagnostics = {
      specificCandidateCount: specific.length,
      candidateCount: candidates.length,
      selectedCount: selected.length,
      visibleTextLength: getVisibleText(document.body).length,
      selectorMode: specific.length ? "specific" : "broad"
    };

    return selected.map((candidate) => candidate.element).slice(0, 100);
  }

  function scoreCandidates(nodeList, mode) {
    return Array.from(new Set(Array.from(nodeList)))
      .filter(isVisibleElement)
      .map((element) => {
        const text = getVisibleText(element);
        const lines = extractLines(text);
        const rect = element.getBoundingClientRect();
        const area = rect.width * rect.height;
        const hasTime = TIME_PATTERN.test(text);
        const hasQueue = lines.some((line) => isAllowedQueue(line));
        const hasCompany = lines.some((line) => Boolean(getCompanyPrefix(line)));
        const hasClientName = lines.some((line) => looksLikeClientName(line));
        const hasTag = Boolean(detectClientTag(element));
        const tagName = element.tagName.toLowerCase();
        const role = element.getAttribute("role") || "";
        const className = String(element.className || "");
        let score = 0;

        if (rect.width >= 240) score += 1;
        if (rect.height >= 42 && rect.height <= 260) score += 2;
        if (rect.height > 260 && rect.height <= 420) score -= 1;
        if (text.length >= 12 && text.length <= 1400) score += 1;
        if (lines.length >= 2) score += 1;
        if (lines.length >= 4) score += 1;
        if (hasTime) score += 2;
        if (hasQueue) score += 3;
        if (hasCompany) score += 2;
        if (hasClientName) score += 2;
        if (hasTag) score += 1;
        if (["li", "article"].includes(tagName)) score += 2;
        if (role === "listitem" || role === "button") score += 2;
        if (/MuiListItem|MuiPaper|MuiButtonBase|ticket/i.test(className)) score += 2;
        if (mode === "specific") score += 1;
        if (area > window.innerWidth * window.innerHeight * 0.35) score -= 5;
        if (text.length > 1800) score -= 4;

        return { element, score, rect, area, text, lines };
      })
      .filter((candidate) => candidate.score > 0);
  }

  function selectBestTicketElements(candidates) {
    const selected = [];
    const sorted = candidates.sort((a, b) => b.score - a.score || a.area - b.area || a.rect.top - b.rect.top);

    for (const candidate of sorted) {
      const overlapsExisting = selected.some((existing) => {
        if (existing.element === candidate.element) return true;
        if (existing.element.contains(candidate.element) || candidate.element.contains(existing.element)) return true;
        return overlapRatio(existing.rect, candidate.rect) > 0.72;
      });

      if (!overlapsExisting) {
        selected.push(candidate);
      }
    }

    return selected.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  }

  function parseTicketElement(ticketElement, index) {
    const rawText = getVisibleText(ticketElement);
    const lines = extractLines(rawText);
    const tag = detectClientTag(ticketElement);
    const displayTime = findDisplayTime(ticketElement, lines);
    const inactivityMinutes = calculateInactivityMinutes(displayTime);
    const queue = findFirst(lines, (line) => normalizeQueueName(line)) || "";
    const company = findCompany(lines, tag);
    const clientName = findClientName(lines, { tag, queue, company, displayTime });
    const attendant = findAttendant(lines, { tag, queue, company, clientName, displayTime });
    const tagStatus = tag ? "COM_TAG" : "SEM_TAG";
    const ticketKey = createTicketKey({ clientName, queue, company, displayTime, tag, index, ticketElement, lines });

    return {
      ticketKey,
      clientName,
      queue,
      attendant,
      company,
      displayTime,
      inactivityMinutes,
      tag,
      tagStatus,
      debug: {
        lines,
        rect: rectToPlain(ticketElement.getBoundingClientRect())
      }
    };
  }

  function detectClientTag(ticketElement) {
    const elements = Array.from(ticketElement.querySelectorAll("span, div, p, small, strong, label, button, [role='button']"));
    const scored = elements
      .filter(isVisibleElement)
      .map((element) => {
        const text = normalizeText(getVisibleText(element));
        return {
          element,
          text,
          score: scoreTagCandidate(element, text)
        };
      })
      .filter((candidate) => candidate.score >= 4)
      .sort((a, b) => b.score - a.score);

    return scored[0]?.text || null;
  }

  function scoreTagCandidate(element, text) {
    if (!text || text.length < 5 || text.length > 60) {
      return -100;
    }

    if (looksLikeAnyQueue(text) || TIME_PATTERN.test(text) || isKnownAttendant(text)) {
      return -100;
    }

    if (isPlaceholderLine(text) || /^(Atendente|Responsavel|Usuario|Cliente|Aberto|Fechado|Pendente)$/i.test(text)) {
      return -100;
    }

    const matchesTagPattern = matchesClientTagPattern(text);
    const uppercaseRatio = calculateUppercaseRatio(text);
    const visualScore = scoreVisualTagStyle(element);
    const hasTagHint = hasTagElementHint(element);
    const tagPrefix = getTagPrefix(text);

    if (["CLIENTE", "ATENDENTE", "RESPONSAVEL", "USUARIO", "FILA", "TAG", "TAGS"].includes(tagPrefix)) {
      return -100;
    }

    if (looksLikeCompanyOnly(text) && !(matchesTagPattern && (visualScore >= 2 || hasTagHint))) {
      return -100;
    }

    if (!matchesTagPattern && !(hasTagHint && visualScore >= 2 && countWords(text) <= 5)) {
      return -100;
    }

    let score = 0;
    if (matchesTagPattern) score += 4;
    if (uppercaseRatio >= 0.75) score += 2;
    if (visualScore >= 3) score += 3;
    if (hasTagHint) score += 2;
    if (/[-–—]/u.test(text)) score += 1;
    if (element.tagName.toLowerCase() === "span") score += 1;

    const rect = element.getBoundingClientRect();
    if (rect.height > 0 && rect.height <= 32 && rect.width <= 280) {
      score += 1;
    }

    return score;
  }

  function scoreVisualTagStyle(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    const fontSize = parseFloat(style.fontSize) || 0;
    const height = rect.height || parseFloat(style.height) || 0;
    const display = style.display;
    const backgroundColor = style.backgroundColor;
    const color = style.color;
    let score = 0;

    if (display === "inline-block" || display === "inline-flex" || display === "flex") score += 1;
    if (paddingLeft >= 3 && paddingRight >= 3) score += 1;
    if (fontSize > 0 && fontSize <= 13) score += 1;
    if (height >= 14 && height <= 32) score += 1;
    if (backgroundColor && !/rgba?\(0,\s*0,\s*0,\s*0\)|transparent/i.test(backgroundColor)) score += 1;
    if (isLightColor(color)) score += 1;

    return score;
  }

  function matchesClientTagPattern(text) {
    const normalized = normalizeTagText(text);
    return TAG_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  function getTagPrefix(text) {
    return normalizeTagText(text).split(/[-–—]/u)[0]?.trim() || "";
  }

  function normalizeTagText(value) {
    return normalizeText(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase();
  }

  function hasTagElementHint(element) {
    const hint = [
      element.getAttribute("aria-label"),
      element.getAttribute("data-testid"),
      element.getAttribute("title"),
      element.getAttribute("class"),
      element.closest("[aria-label*='tag' i], [data-testid*='tag' i], [class*='tag' i], [class*='chip' i]")?.getAttribute("class")
    ]
      .filter(Boolean)
      .join(" ");
    return /\b(tag|tags|chip)\b/i.test(hint);
  }

  function looksLikeCompanyOnly(text) {
    const normalized = normalizeTagText(text);
    const prefix = COMPANY_PREFIXES.find(
      (companyPrefix) =>
        normalized === companyPrefix || normalized.startsWith(`${companyPrefix} `) || normalized.startsWith(`${companyPrefix}-`)
    );
    if (!prefix) {
      return false;
    }

    const suffix = normalized.slice(prefix.length).replace(/^[-\s_]+/, "");
    return !suffix || ALLOWED_QUEUE_CODES.has(normalizeQueueCode(suffix));
  }

  function showMissingTagAlert(ticket) {
    if (!isAlertableTicket(ticket)) {
      return;
    }

    renderTicketAlerts([ticket], currentInactivityAlertTickets, { force: true });
  }

  function renderTicketAlerts(missingTagTickets, inactiveTickets, options = {}) {
    const now = Date.now();

    if (options.force) {
      alertSnoozedUntil = 0;
    } else if (alertSnoozedUntil > now) {
      document.getElementById(ALERT_ROOT_ID)?.remove();
      return;
    }

    currentMissingTagAlertTickets = getUniqueAlertTickets(missingTagTickets.filter(isAlertableTicket))
      .map((ticket) => ({ ...ticket, alertedAt: now }))
      .slice(0, 6);
    currentInactivityAlertTickets = getUniqueAlertTickets(inactiveTickets.filter(isAlertableTicket))
      .map((ticket) => ({ ...ticket, alertedAt: now }))
      .slice(0, 6);

    if (!currentMissingTagAlertTickets.length && !currentInactivityAlertTickets.length) {
      document.getElementById(ALERT_ROOT_ID)?.remove();
      return;
    }

    renderAlert();
  }

  function getUniqueAlertTickets(tickets) {
    const seen = new Set();
    return tickets.filter((ticket) => {
      const alertKey = createAlertTicketKey(ticket);
      if (!alertKey || seen.has(alertKey)) {
        return false;
      }
      seen.add(alertKey);
      return true;
    });
  }

  function isAlertableTicket(ticket) {
    return hasIdentifiedClient(ticket?.clientName);
  }

  function hasIdentifiedClient(value) {
    const text = normalizeText(value);
    if (!text) return false;
    if (isKnownAttendant(text)) return false;
    if (looksLikeAnyQueue(text)) return false;
    if (getCompanyPrefix(text)) return false;
    if (matchesClientTagPattern(text)) return false;
    if (TIME_PATTERN.test(text)) return false;
    if (isPlaceholderLine(text)) return false;
    return /[A-Za-z]{3,}/.test(text);
  }

  function createAlertTicketKey(ticket) {
    if (!isAlertableTicket(ticket)) {
      return "";
    }

    const clientName = normalizeText(ticket?.clientName).toUpperCase();
    if (clientName) {
      return `CLIENT|${clientName}`;
    }

    return "";
  }

  function renderAlert() {
    let root = document.getElementById(ALERT_ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = ALERT_ROOT_ID;
      document.body.appendChild(root);
    }

    const sections = [
      buildAlertSection("missing-tag", "Registre a TAG do cliente", currentMissingTagAlertTickets, (ticket) =>
        [ticket.queue, ticket.attendant, ticket.company].filter(Boolean).join(" - ")
      ),
      buildAlertSection("inactivity", "Alerta de inatividade", currentInactivityAlertTickets, (ticket) => {
        const inactiveFor = Number(ticket.inactivityMinutes || 0);
        const inactivityText = inactiveFor > 0 ? `${inactiveFor} min sem atividade` : "Mais de 15 min sem atividade";
        return [inactivityText, ticket.displayTime ? `Horario ${ticket.displayTime}` : "", ticket.queue, ticket.attendant]
          .filter(Boolean)
          .join(" - ");
      })
    ].join("");

    root.innerHTML = `
      <section class="mcall-alert" role="dialog" aria-live="polite" aria-label="Alertas de ticket">
        <div class="mcall-alert__header">
          <strong>Alertas de tickets</strong>
          <button type="button" class="mcall-alert__close" aria-label="Fechar alerta">&times;</button>
        </div>
        <div class="mcall-alert__body">${sections}</div>
      </section>
    `;

    root.querySelector(".mcall-alert__close")?.addEventListener("click", () => {
      alertSnoozedUntil = Date.now() + ALERT_SNOOZE_MS;
      currentMissingTagAlertTickets = [];
      currentInactivityAlertTickets = [];
      root.remove();
    });
  }

  function buildAlertSection(type, title, tickets, getMeta) {
    if (!tickets.length) {
      return "";
    }

    const items = tickets
      .map((ticket) => {
        const itemTitle = escapeHtml(ticket.clientName);
        const meta = escapeHtml(getMeta(ticket));
        return `<li><strong>${itemTitle}</strong>${meta ? `<span>${meta}</span>` : ""}</li>`;
      })
      .join("");

    return `
      <div class="mcall-alert__section" data-alert-type="${type}">
        <strong class="mcall-alert__section-title">${escapeHtml(title)}</strong>
        <ul>${items}</ul>
      </div>
    `;
  }

  function injectAlertStyles() {
    if (document.getElementById("mcall-ticket-tag-alert-style")) {
      return;
    }

    const style = document.createElement("style");
    style.id = "mcall-ticket-tag-alert-style";
    style.textContent = `
      #${ALERT_ROOT_ID} {
        position: fixed;
        right: 18px;
        top: 18px;
        z-index: 2147483647;
        width: min(380px, calc(100vw - 36px));
        font-family: Inter, Roboto, Arial, sans-serif;
      }
      #${ALERT_ROOT_ID} .mcall-alert {
        background: #fff;
        color: #1f2937;
        border: 1px solid #f5b5b5;
        border-left: 6px solid #d92d20;
        border-radius: 8px;
        box-shadow: 0 18px 45px rgba(15, 23, 42, 0.2);
        overflow: hidden;
      }
      #${ALERT_ROOT_ID} .mcall-alert__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 14px 10px;
      }
      #${ALERT_ROOT_ID} .mcall-alert__header strong {
        font-size: 15px;
        line-height: 1.2;
      }
      #${ALERT_ROOT_ID} .mcall-alert__close {
        appearance: none;
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: 6px;
        background: #f3f4f6;
        color: #111827;
        cursor: pointer;
        font-size: 20px;
        line-height: 1;
      }
      #${ALERT_ROOT_ID} .mcall-alert__body {
        display: grid;
        gap: 12px;
        padding: 0 14px 14px;
      }
      #${ALERT_ROOT_ID} .mcall-alert__section {
        display: grid;
        gap: 8px;
      }
      #${ALERT_ROOT_ID} .mcall-alert__section-title {
        font-size: 12px;
        line-height: 1.3;
        color: #374151;
        text-transform: uppercase;
      }
      #${ALERT_ROOT_ID} ul {
        margin: 0;
        padding: 0;
        list-style: none;
        display: grid;
        gap: 8px;
      }
      #${ALERT_ROOT_ID} li {
        display: grid;
        gap: 3px;
        padding: 9px;
        border-radius: 6px;
        background: #fff7f7;
      }
      #${ALERT_ROOT_ID} li strong {
        font-size: 13px;
        line-height: 1.3;
      }
      #${ALERT_ROOT_ID} li span {
        color: #4b5563;
        font-size: 12px;
        line-height: 1.3;
      }
      #${ALERT_ROOT_ID} [data-alert-type="inactivity"] li {
        background: #fff8e1;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function findDisplayTime(ticketElement, lines) {
    const elements = Array.from(
      ticketElement.querySelectorAll(
        "span.MuiTypography-colorTextSecondary, span.MuiTypography-body2, span[class*='MuiTypography-colorTextSecondary'], span[class*='MuiTypography-body2']"
      )
    );
    const timeFromTypography = findFirst(elements.filter(isVisibleElement), (element) => getVisibleText(element).match(TIME_PATTERN)?.[0]);
    return timeFromTypography || findFirst(lines, (line) => line.match(TIME_PATTERN)?.[0]) || "";
  }

  function isInactiveTicket(ticket) {
    return Number(ticket?.inactivityMinutes || 0) > INACTIVITY_THRESHOLD_MINUTES;
  }

  function calculateInactivityMinutes(displayTime, now = new Date()) {
    const match = normalizeText(displayTime).match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!match) {
      return null;
    }

    const displayedAt = new Date(now);
    displayedAt.setHours(Number(match[1]), Number(match[2]), 0, 0);

    let diffMs = now.getTime() - displayedAt.getTime();
    if (diffMs < 0) {
      const aheadMs = Math.abs(diffMs);
      if (aheadMs <= 12 * 60 * 60 * 1000) {
        return 0;
      }
      diffMs += 24 * 60 * 60 * 1000;
    }

    return Math.floor(diffMs / ONE_MINUTE_MS);
  }

  function findClientName(lines, ignored) {
    const firstStrongCandidate = lines.find((line) => {
      if (!looksLikeClientName(line)) return false;
      if (isIgnoredLine(line, ignored)) return false;
      if (getCompanyPrefix(line)) return false;
      if (isKnownAttendant(line)) return false;
      return countWords(line) >= 2 || calculateUppercaseRatio(line) >= 0.7;
    });

    return firstStrongCandidate || lines.find((line) => looksLikeClientName(line) && !isIgnoredLine(line, ignored)) || "";
  }

  function findAttendant(lines, ignored) {
    const knownAttendant = lines.find((line) => isKnownAttendant(line) && !isIgnoredLine(line, ignored));
    return knownAttendant ? normalizeAttendantName(knownAttendant) : "";
  }

  function findCompany(lines, tag) {
    return (
      lines.find((line) => {
        if (line === tag) return false;
        return Boolean(getCompanyPrefix(line));
      }) || ""
    );
  }

  function findFirst(lines, selector) {
    for (const line of lines) {
      const result = selector(line);
      if (result) return result;
    }
    return "";
  }

  function extractLines(text) {
    return String(text || "")
      .split(/\n| {2,}|\t/g)
      .map(normalizeText)
      .flatMap((line) => splitCombinedLine(line))
      .map(normalizeText)
      .filter(Boolean)
      .filter((line, index, array) => array.indexOf(line) === index);
  }

  function splitCombinedLine(line) {
    const withBreaks = line
      .replace(/(Suporte\s*-\s*[A-Za-z0-9_-]+)/gi, "\n$1\n")
      .replace(/\b([01]\d|2[0-3]):[0-5]\d\b/g, "\n$&\n")
      .replace(/(NETFIBRA[-\s]?[A-Z0-9_-]+)/gi, "\n$1\n");
    return withBreaks.split("\n");
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getVisibleText(element) {
    return String(element?.innerText || element?.textContent || "").replace(/\u00a0/g, " ").trim();
  }

  function isIgnoredLine(line, ignored) {
    return Object.values(ignored).filter(Boolean).includes(line) || TIME_PATTERN.test(line);
  }

  function looksLikeClientName(line) {
    if (!line || line.length < 4 || line.length > 100) return false;
    if (isKnownAttendant(line)) return false;
    if (looksLikeAnyQueue(line)) return false;
    if (getCompanyPrefix(line)) return false;
    if (matchesClientTagPattern(line)) return false;
    if (TIME_PATTERN.test(line)) return false;
    if (isPlaceholderLine(line)) return false;
    if (/^(All|Aberto|Fechado|Pendente|Resolvido|Atendente|Cliente|Fila|Tags?|N[aãÃ]o identificado|Cliente n[aãÃ]o identificado)$/i.test(line)) {
      return false;
    }
    if (/[.!?]{1,}/.test(line) && calculateUppercaseRatio(line) < 0.7) return false;
    if (/[a-z]{2,}\s+[a-z]{2,}/.test(line) && calculateUppercaseRatio(line) < 0.55) return false;
    return /[A-Za-z]{3,}/.test(line);
  }

  function isPlaceholderLine(line) {
    const normalized = normalizeTagText(line);
    return /^(ALL|ABERTO|FECHADO|PENDENTE|RESOLVIDO|ATENDENTE|RESPONSAVEL|USUARIO|CLIENTE|FILA|TAG|TAGS|NAO IDENTIFICADO|CLIENTE NAO IDENTIFICADO)$/.test(
      normalized
    );
  }

  function normalizeAttendantName(value) {
    const text = normalizeText(value).replace(/[.,;:]+$/g, "");
    if (!text) return "";
    const key = normalizeAttendantKey(text);
    const exact = KNOWN_ATTENDANTS.get(key);
    if (exact) return exact;

    for (const [attendantKey, canonical] of KNOWN_ATTENDANTS.entries()) {
      if (!key.startsWith(attendantKey)) continue;
      const suffix = key.slice(attendantKey.length).trim();
      if (!suffix || COMPANY_PREFIXES.some((prefix) => suffix.startsWith(prefix))) {
        return canonical;
      }
    }

    return text;
  }

  function isKnownAttendant(value) {
    const text = normalizeText(value);
    if (!text) return false;
    return normalizeAttendantName(text) !== text.replace(/[.,;:]+$/g, "") || KNOWN_ATTENDANTS.has(normalizeAttendantKey(text));
  }

  function normalizeAttendantKey(value) {
    return normalizeText(value)
      .replace(/[.,;:]+$/g, "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase();
  }

  function looksLikeAnyQueue(line) {
    return /^Suporte\s*-\s*[A-Za-z0-9_-]+$/i.test(normalizeText(line));
  }

  function normalizeQueueName(line) {
    const text = normalizeText(line);
    const match = text.match(QUEUE_PATTERN);
    if (!match) return "";
    const code = normalizeQueueCode(match[1]);
    if (!ALLOWED_QUEUE_CODES.has(code)) return "";
    return `Suporte-${ALLOWED_QUEUE_LABELS[code]}`;
  }

  function isAllowedQueue(line) {
    return Boolean(normalizeQueueName(line));
  }

  function normalizeQueueCode(value) {
    return normalizeText(value).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  }

  function getCompanyPrefix(line) {
    const text = normalizeText(line).toUpperCase();
    return COMPANY_PREFIXES.find((prefix) => text === prefix || text.startsWith(`${prefix} `) || text.startsWith(`${prefix}-`)) || "";
  }

  function calculateUppercaseRatio(text) {
    const letters = Array.from(text).filter((char) => /[A-Za-z]/.test(char));
    if (!letters.length) return 0;
    const upper = letters.filter((char) => char === char.toUpperCase() && char !== char.toLowerCase()).length;
    return upper / letters.length;
  }

  function countWords(text) {
    return normalizeText(text).split(/\s+/).filter(Boolean).length;
  }

  function isLightColor(color) {
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!match) return false;
    const [, red, green, blue] = match.map(Number);
    const brightness = (red * 299 + green * 587 + blue * 114) / 1000;
    return brightness > 170;
  }

  function isVisibleElement(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function overlapRatio(a, b) {
    const xOverlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const yOverlap = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const overlapArea = xOverlap * yOverlap;
    const smallerArea = Math.min(a.width * a.height, b.width * b.height);
    return smallerArea ? overlapArea / smallerArea : 0;
  }

  function createTicketKey(ticket) {
    const stableLine = findStableTicketLine(ticket.lines || [], ticket);
    return [ticket.clientName || stableLine, ticket.queue, ticket.attendant, ticket.company, ticket.displayTime]
      .map((part) => normalizeText(part).toUpperCase())
      .join("|");
  }

  function findStableTicketLine(lines, ticket) {
    return (
      lines.find((line) => {
        if (isIgnoredLine(line, ticket)) return false;
        if (looksLikeAnyQueue(line)) return false;
        if (getCompanyPrefix(line)) return false;
        if (TIME_PATTERN.test(line)) return false;
        return line.length >= 4;
      }) ||
      ticket.queue ||
      String(ticket.index || 0)
    );
  }

  function rectToPlain(rect) {
    return {
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function buildDiagnostics(reason, tickets) {
    const missingTags = tickets.filter((ticket) => ticket.tagStatus === "SEM_TAG").length;
    let captureStatus = "tickets_detectados";
    let parserMessage = `${tickets.length} ticket(s) detectado(s).`;

    if (!tickets.length) {
      captureStatus = "nenhum_ticket_detectado";
      parserMessage =
        "A extensao foi carregada, mas nao encontrou tickets nas filas monitoradas: TerraNet, PLANET, MIX, IDEZ, BDG e AIA.";
    } else if (missingTags > 0) {
      captureStatus = "tickets_sem_tag_detectados";
      parserMessage = `${missingTags} ticket(s) sem TAG detectado(s).`;
    }

    return {
      parserVersion: PARSER_VERSION,
      reason,
      captureStatus,
      parserMessage,
      candidateCount: lastCollectDiagnostics.candidateCount,
      selectedCount: lastCollectDiagnostics.selectedCount,
      specificCandidateCount: lastCollectDiagnostics.specificCandidateCount,
      selectorMode: lastCollectDiagnostics.selectorMode,
      visibleTextLength: lastCollectDiagnostics.visibleTextLength
    };
  }

  function emptyCollectDiagnostics() {
    return {
      specificCandidateCount: 0,
      candidateCount: 0,
      selectedCount: 0,
      visibleTextLength: 0,
      selectorMode: "none"
    };
  }

  function toOffsetIso(date) {
    const pad = (number) => String(Math.trunc(Math.abs(number))).padStart(2, "0");
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const hours = pad(offset / 60);
    const minutes = pad(offset % 60);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
      date.getMinutes()
    )}:${pad(date.getSeconds())}${sign}${hours}:${minutes}`;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  window.McallTicketTagMonitor = {
    parseTicketsFromDOM,
    detectClientTag,
    showMissingTagAlert,
    scanAndSend,
    debug() {
      const tickets = parseTicketsFromDOM();
      const diagnostics = buildDiagnostics("debug", tickets);
      console.table(
        tickets.map((ticket) => ({
          clientName: ticket.clientName,
          queue: ticket.queue,
          attendant: ticket.attendant,
          company: ticket.company,
          displayTime: ticket.displayTime,
          tag: ticket.tag,
          tagStatus: ticket.tagStatus
        }))
      );
      return { diagnostics, tickets };
    }
  };
})();
