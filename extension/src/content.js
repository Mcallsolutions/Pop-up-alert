// Monitor de tickets do MTalk.
//
// A leitura vem da API oficial (mtalk-api.js) — nao ha mais leitura de tela.
// Este arquivo cuida do que sobrou: agendar as leituras, mostrar os alertas na
// pagina e enviar o snapshot para a API do painel.
(() => {
  // Uma leitura por minuto. A versao que lia a tela tambem reagia a cada
  // mudanca no DOM; com chamadas de rede isso viraria rajada de requisicao a
  // toa, entao o intervalo fixo e a unica fonte de leituras automaticas.
  const SCAN_INTERVAL_MS = 60 * 1000;
  const ONE_MINUTE_MS = 60 * 1000;
  const ALERT_SNOOZE_MS = 5 * ONE_MINUTE_MS;
  const ALERT_ROOT_ID = "mcall-ticket-tag-alert-root";
  const READER_VERSION = "2.0.0-api";

  const api = window.McallMtalkApi;
  const INACTIVITY_THRESHOLD_MINUTES = api?.INACTIVITY_THRESHOLD_MINUTES ?? 15;

  let scanTimer = null;
  let currentMissingTagAlertTickets = [];
  let currentInactivityAlertTickets = [];
  let alertSnoozedUntil = 0;
  let lastDiagnostics = {};

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
    if (!api) {
      console.error("[Mcall Ticket Tag Monitor] mtalk-api.js nao carregou; a leitura pela API oficial nao esta disponivel.");
      return;
    }

    injectAlertStyles();
    scanAndSend("initial").catch(reportScanError);
    scanTimer = window.setInterval(() => {
      scanAndSend("interval").catch(reportScanError);
    }, SCAN_INTERVAL_MS);
    window.addEventListener("beforeunload", cleanup);
  }

  function cleanup() {
    window.clearInterval(scanTimer);
  }

  async function scanAndSend(reason) {
    const { tickets, diagnostics } = await api.collect();
    lastDiagnostics = diagnostics;

    const missingTickets = tickets.filter((ticket) => ticket.tagStatus === "SEM_TAG");
    const inactiveTickets = tickets.filter(isInactiveTicket);
    const scanDiagnostics = buildDiagnostics(reason, tickets, diagnostics);

    renderTicketAlerts(missingTickets, inactiveTickets, { force: reason === "manual" });

    const payload = {
      source: "mtalk-api",
      url: `${window.location.origin}/tickets`,
      collectedAt: toOffsetIso(new Date()),
      diagnostics: scanDiagnostics,
      tickets
    };

    const response = await sendRuntimeMessage({ type: "SNAPSHOT_READY", payload });
    window.dispatchEvent(
      new CustomEvent("mcall-ticket-monitor:scan", {
        detail: { reason, diagnostics: scanDiagnostics, tickets, response }
      })
    );

    return {
      ok: response?.ok !== false,
      totalTickets: tickets.length,
      missingTags: missingTickets.length,
      inactiveTickets: inactiveTickets.length,
      sent: response?.ok === true,
      diagnostics: scanDiagnostics,
      error: response?.error || ""
    };
  }

  function reportScanError(error) {
    console.error("[Mcall Ticket Tag Monitor]", error);
    sendRuntimeMessage({
      type: "SNAPSHOT_READY",
      payload: {
        source: "mtalk-api",
        url: `${window.location.origin}/tickets`,
        collectedAt: toOffsetIso(new Date()),
        diagnostics: {
          parserVersion: READER_VERSION,
          reason: "error",
          captureStatus: error?.code === "sem_token" ? "sem_sessao" : "erro_na_api",
          parserMessage: error?.message || "Erro desconhecido na leitura pela API",
          candidateCount: 0,
          selectedCount: 0
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

  function isInactiveTicket(ticket) {
    return Number(ticket?.inactivityMinutes || 0) > INACTIVITY_THRESHOLD_MINUTES;
  }

  function renderTicketAlerts(missingTagTickets, inactiveTickets, options = {}) {
    const now = Date.now();

    if (options.force) {
      alertSnoozedUntil = 0;
    } else if (alertSnoozedUntil > now) {
      document.getElementById(ALERT_ROOT_ID)?.remove();
      return;
    }

    currentMissingTagAlertTickets = missingTagTickets.filter(isAlertableTicket).slice(0, 6);
    currentInactivityAlertTickets = inactiveTickets.filter(isAlertableTicket).slice(0, 6);

    if (!currentMissingTagAlertTickets.length && !currentInactivityAlertTickets.length) {
      document.getElementById(ALERT_ROOT_ID)?.remove();
      return;
    }

    renderAlert();
  }

  // O contato vem do cadastro do MTalk, entao basta ter nome para o alerta
  // conseguir dizer de quem ele esta falando.
  function isAlertableTicket(ticket) {
    return Boolean(String(ticket?.clientName || "").trim());
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
        const inactivityText =
          inactiveFor > 0 ? `${inactiveFor} min sem atividade` : `Mais de ${INACTIVITY_THRESHOLD_MINUTES} min sem atividade`;
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

    // Cada item leva ao proprio ticket: o uuid vem junto na resposta da API.
    root.querySelectorAll("[data-ticket-uuid]").forEach((item) => {
      item.addEventListener("click", () => {
        window.location.href = `${window.location.origin}/tickets/${item.dataset.ticketUuid}`;
      });
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
        const uuid = ticket.ticketUuid ? ` data-ticket-uuid="${escapeHtml(ticket.ticketUuid)}"` : "";
        return `<li${uuid}><strong>${itemTitle}</strong>${meta ? `<span>${meta}</span>` : ""}</li>`;
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
      #${ALERT_ROOT_ID} li[data-ticket-uuid] {
        cursor: pointer;
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

  function buildDiagnostics(reason, tickets, apiDiagnostics = {}) {
    const missingTags = tickets.filter((ticket) => ticket.tagStatus === "SEM_TAG").length;
    let captureStatus = "tickets_detectados";
    let parserMessage = `${tickets.length} ticket(s) lido(s) pela API oficial em ${apiDiagnostics.requisicoes || 0} requisicao(oes).`;

    if (!tickets.length) {
      captureStatus = "nenhum_ticket_detectado";
      parserMessage =
        "A API respondeu, mas nenhum ticket em atendimento esta nas filas monitoradas: TerraNet, PLANET, MIX, IDEZ, BDG e AIA.";
    } else if (missingTags > 0) {
      captureStatus = "tickets_sem_tag_detectados";
      parserMessage = `${missingTags} ticket(s) sem TAG entre os ${tickets.length} lidos pela API oficial.`;
    }

    return {
      parserVersion: READER_VERSION,
      reason,
      captureStatus,
      parserMessage,
      origem: "api-oficial",
      // Mantem os nomes que o popup ja exibe: recebidos x monitorados.
      candidateCount: Number(apiDiagnostics.ticketsRecebidos || 0),
      selectedCount: Number(apiDiagnostics.ticketsMonitorados || tickets.length),
      requisicoes: Number(apiDiagnostics.requisicoes || 0)
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
    scanAndSend,
    async debug() {
      const { tickets, diagnostics } = await api.collect();
      console.table(
        tickets.map((ticket) => ({
          ticketId: ticket.externalTicketId,
          clientName: ticket.clientName,
          queue: ticket.queue,
          attendant: ticket.attendant,
          company: ticket.company,
          displayTime: ticket.displayTime,
          inactivityMinutes: ticket.inactivityMinutes,
          tag: ticket.tag,
          tagStatus: ticket.tagStatus
        }))
      );
      return { diagnostics, tickets };
    },
    lastDiagnostics: () => lastDiagnostics
  };
})();
