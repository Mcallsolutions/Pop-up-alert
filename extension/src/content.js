// Pop-up de alertas na tela de tickets do MTalk.
//
// A extensao nao le a pagina nem a sessao do MTalk: os tickets sao coletados
// pelo servidor local direto na API oficial do MTalk. Este script so pede os
// alertas ja calculados (via service worker) e desenha o pop-up. O bip de
// inatividade e tocado pelo service worker (documento offscreen), e nao aqui:
// nesta aba o Chrome so liberava som depois de um clique na pagina.
(() => {
  // Mesmo ritmo da coleta padrao do servidor (MTALK_COLLECT_INTERVAL_SECONDS).
  const REFRESH_INTERVAL_MS = 60 * 1000;
  const ALERT_SNOOZE_MS = 5 * 60 * 1000;
  const ALERT_ROOT_ID = "mcall-ticket-tag-alert-root";

  let refreshTimer = null;
  let alertSnoozedUntil = 0;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "REFRESH_ALERTS") {
      refreshAlerts({ force: true })
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    return false;
  });

  injectAlertStyles();
  refreshAlerts().catch(reportError);
  refreshTimer = window.setInterval(() => refreshAlerts().catch(reportError), REFRESH_INTERVAL_MS);
  window.addEventListener("beforeunload", () => window.clearInterval(refreshTimer));

  async function refreshAlerts({ force = false } = {}) {
    // Durante o silencio de 5 minutos do "x" esta aba nao disputa o bip: ele
    // fica para quando o pop-up voltar (ou para outra aba do MTalk).
    const canBeep = force || alertSnoozedUntil <= Date.now();
    const response = await sendRuntimeMessage({ type: "FETCH_ALERTS", canBeep });

    // API fora do ar ou leitura velha: melhor nenhum pop-up do que um alerta
    // que nao reflete mais a fila.
    if (!response?.ok || !response.alerts || response.alerts.stale) {
      removeAlert();
      return { ok: false, error: response?.error || "Sem coleta recente no servidor" };
    }

    renderAlerts(response.alerts, { force });
    return { ok: true };
  }

  function reportError(error) {
    console.error("[Mcall Ticket Tag Monitor]", error);
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          resolve(response || { ok: false, error: chrome.runtime.lastError?.message || "" });
        });
      } catch (error) {
        // Extensao atualizada ou recarregada com a aba aberta: este script ficou
        // orfao e para de consultar. Recarregar a pagina do MTalk resolve.
        if (/context invalidated/i.test(error?.message || "")) {
          window.clearInterval(refreshTimer);
        }
        resolve({ ok: false, error: error.message });
      }
    });
  }

  function renderAlerts(alerts, { force }) {
    if (force) {
      alertSnoozedUntil = 0;
    } else if (alertSnoozedUntil > Date.now()) {
      removeAlert();
      return;
    }

    const threshold = Number(alerts.thresholdMinutes || 15);
    const missingTag = alerts.missingTag || { total: 0, items: [] };
    const inactive = alerts.inactive || { total: 0, items: [] };

    if (!missingTag.items?.length && !inactive.items?.length) {
      removeAlert();
      return;
    }

    const sections = [
      buildAlertSection("missing-tag", "Registre a TAG do cliente", missingTag, (ticket) =>
        [ticket.queue, ticket.attendant, ticket.company].filter(Boolean).join(" · ")
      ),
      buildAlertSection("inactivity", "Alerta de inatividade", inactive, (ticket) => {
        const inactiveFor = Number(ticket.inactivityMinutes || 0);
        const inactivityText = inactiveFor > 0 ? `${inactiveFor} min sem atividade` : `Mais de ${threshold} min sem atividade`;
        return [inactivityText, ticket.displayTime ? `Horario ${ticket.displayTime}` : "", ticket.queue, ticket.attendant]
          .filter(Boolean)
          .join(" · ");
      })
    ].join("");

    let root = document.getElementById(ALERT_ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = ALERT_ROOT_ID;
      document.body.appendChild(root);
    }

    root.innerHTML = `
      <section class="mcall-alert" role="dialog" aria-live="polite" aria-label="Alertas de ticket">
        <div class="mcall-alert__header">
          <span class="mcall-alert__mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"></path>
              <circle cx="7.5" cy="7.5" r=".5" fill="currentColor"></circle>
            </svg>
          </span>
          <div class="mcall-alert__brand">
            <strong>Alertas de tickets</strong>
            <span>Mcall Ticket Tag Monitor</span>
          </div>
          <button type="button" class="mcall-alert__close" aria-label="Fechar alerta por 5 minutos" title="Fechar por 5 minutos">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12"></path>
            </svg>
          </button>
        </div>
        <div class="mcall-alert__body">${sections}</div>
      </section>
    `;

    root.querySelector(".mcall-alert__close")?.addEventListener("click", () => {
      alertSnoozedUntil = Date.now() + ALERT_SNOOZE_MS;
      removeAlert();
    });

    // Cada item leva ao proprio ticket, pelo uuid que veio da API do MTalk.
    root.querySelectorAll("[data-ticket-uuid]").forEach((item) => {
      const open = () => {
        window.location.href = `${window.location.origin}/tickets/${encodeURIComponent(item.dataset.ticketUuid)}`;
      };
      item.addEventListener("click", open);
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    });
  }

  function removeAlert() {
    document.getElementById(ALERT_ROOT_ID)?.remove();
  }

  function buildAlertSection(type, title, group, getMeta) {
    const tickets = group.items || [];
    if (!tickets.length) {
      return "";
    }

    const total = Number(group.total || tickets.length);
    const count = total > tickets.length ? `${tickets.length} de ${total}` : String(total);
    const items = tickets
      .map((ticket) => {
        const meta = escapeHtml(getMeta(ticket));
        const link = ticket.ticketUuid
          ? ` data-ticket-uuid="${escapeHtml(ticket.ticketUuid)}" role="link" tabindex="0"`
          : "";
        return `<li${link}><strong>${escapeHtml(ticket.clientName)}</strong>${meta ? `<span>${meta}</span>` : ""}</li>`;
      })
      .join("");

    return `
      <div class="mcall-alert__section" data-alert-type="${type}">
        <div class="mcall-alert__section-title">
          <span>${escapeHtml(title)}</span>
          <span class="mcall-alert__count">${escapeHtml(count)}</span>
        </div>
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
    // Mesmos tokens do painel (admin/src/styles.css): tema claro por padrao e o
    // escuro quando o sistema esta no escuro. As cores ficam em variaveis
    // proprias, presas ao root do alerta, para nao colidir com o CSS do MTalk.
    // Sem TAG em vermelho e inatividade em ambar, como nos cards do Dashboard.
    style.textContent = `
      #${ALERT_ROOT_ID} {
        --mcall-surface: #ffffff;
        --mcall-surface-2: #f4f4f5;
        --mcall-border: #e6e6e9;
        --mcall-border-strong: #d4d4d8;
        --mcall-text-1: #18181b;
        --mcall-text-2: #52525b;
        --mcall-text-3: #6b6b74;
        --mcall-accent: #059669;
        --mcall-accent-soft: #ecfdf5;
        --mcall-warning: #d97706;
        --mcall-warning-soft: #fffbeb;
        --mcall-warning-text: #b45309;
        --mcall-danger: #dc2626;
        --mcall-danger-soft: #fef2f2;
        --mcall-danger-text: #b91c1c;
        --mcall-focus: rgba(5, 150, 105, 0.28);
        --mcall-shadow: 0 12px 32px rgba(24, 24, 27, 0.12), 0 1px 2px rgba(24, 24, 27, 0.06);
        position: fixed;
        right: 18px;
        top: 18px;
        z-index: 2147483647;
        width: min(380px, calc(100vw - 36px));
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 14px;
        line-height: 1.45;
        -webkit-font-smoothing: antialiased;
      }
      @media (prefers-color-scheme: dark) {
        #${ALERT_ROOT_ID} {
          --mcall-surface: #131315;
          --mcall-surface-2: #1b1b1e;
          --mcall-border: #26262a;
          --mcall-border-strong: #3a3a40;
          --mcall-text-1: #f4f4f5;
          --mcall-text-2: #a8a8b0;
          --mcall-text-3: #8c8c95;
          --mcall-accent: #34d399;
          --mcall-accent-soft: rgba(52, 211, 153, 0.1);
          --mcall-warning: #fbbf24;
          --mcall-warning-soft: rgba(251, 191, 36, 0.1);
          --mcall-warning-text: #fcd34d;
          --mcall-danger: #f87171;
          --mcall-danger-soft: rgba(248, 113, 113, 0.1);
          --mcall-danger-text: #fca5a5;
          --mcall-focus: rgba(52, 211, 153, 0.3);
          --mcall-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
          color-scheme: dark;
        }
      }
      #${ALERT_ROOT_ID} *,
      #${ALERT_ROOT_ID} *::before,
      #${ALERT_ROOT_ID} *::after {
        box-sizing: border-box;
      }
      #${ALERT_ROOT_ID} .mcall-alert {
        margin: 0;
        background: var(--mcall-surface);
        color: var(--mcall-text-1);
        border: 1px solid var(--mcall-border);
        border-radius: 12px;
        box-shadow: var(--mcall-shadow);
        overflow: hidden;
      }
      #${ALERT_ROOT_ID} .mcall-alert__header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 12px 12px 14px;
        border-bottom: 1px solid var(--mcall-border);
      }
      #${ALERT_ROOT_ID} .mcall-alert__mark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        flex-shrink: 0;
        border-radius: 8px;
        background: var(--mcall-accent-soft);
        color: var(--mcall-accent);
      }
      #${ALERT_ROOT_ID} .mcall-alert__brand {
        display: grid;
        gap: 1px;
        min-width: 0;
        flex: 1;
      }
      #${ALERT_ROOT_ID} .mcall-alert__brand strong {
        color: var(--mcall-text-1);
        font-size: 14px;
        font-weight: 600;
        letter-spacing: -0.01em;
        line-height: 1.25;
      }
      #${ALERT_ROOT_ID} .mcall-alert__brand span {
        color: var(--mcall-text-3);
        font-size: 12px;
        line-height: 1.3;
      }
      #${ALERT_ROOT_ID} .mcall-alert__close {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        margin: 0;
        padding: 0;
        flex-shrink: 0;
        border: 1px solid var(--mcall-border-strong);
        border-radius: 8px;
        background: var(--mcall-surface);
        color: var(--mcall-text-2);
        cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease;
      }
      #${ALERT_ROOT_ID} .mcall-alert__close:hover {
        background: var(--mcall-surface-2);
        color: var(--mcall-text-1);
      }
      #${ALERT_ROOT_ID} .mcall-alert__close:focus-visible,
      #${ALERT_ROOT_ID} li[data-ticket-uuid]:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px var(--mcall-focus);
      }
      #${ALERT_ROOT_ID} .mcall-alert__body {
        display: grid;
        gap: 14px;
        max-height: calc(100vh - 120px);
        overflow-y: auto;
        padding: 12px 14px 14px;
        scrollbar-color: var(--mcall-border-strong) transparent;
      }
      #${ALERT_ROOT_ID} [data-alert-type="missing-tag"] {
        --mcall-tone: var(--mcall-danger);
        --mcall-tone-soft: var(--mcall-danger-soft);
        --mcall-tone-text: var(--mcall-danger-text);
      }
      #${ALERT_ROOT_ID} [data-alert-type="inactivity"] {
        --mcall-tone: var(--mcall-warning);
        --mcall-tone-soft: var(--mcall-warning-soft);
        --mcall-tone-text: var(--mcall-warning-text);
      }
      #${ALERT_ROOT_ID} .mcall-alert__section {
        display: grid;
        gap: 8px;
      }
      #${ALERT_ROOT_ID} .mcall-alert__section-title {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--mcall-text-2);
        font-size: 12.5px;
        font-weight: 500;
        line-height: 1.3;
      }
      #${ALERT_ROOT_ID} .mcall-alert__section-title::before {
        content: "";
        width: 7px;
        height: 7px;
        flex-shrink: 0;
        border-radius: 50%;
        background: var(--mcall-tone);
      }
      #${ALERT_ROOT_ID} .mcall-alert__count {
        margin-left: auto;
        padding: 1px 8px;
        border-radius: 999px;
        background: var(--mcall-tone-soft);
        color: var(--mcall-tone-text);
        font-size: 12px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      #${ALERT_ROOT_ID} ul {
        margin: 0;
        padding: 0;
        list-style: none;
        display: grid;
        border: 1px solid var(--mcall-border);
        border-radius: 8px;
        overflow: hidden;
      }
      #${ALERT_ROOT_ID} li {
        display: grid;
        gap: 2px;
        margin: 0;
        padding: 9px 12px;
        border-bottom: 1px solid var(--mcall-border);
        background: var(--mcall-surface);
        transition: background 0.15s ease;
      }
      #${ALERT_ROOT_ID} li:last-child {
        border-bottom: 0;
      }
      #${ALERT_ROOT_ID} li[data-ticket-uuid] {
        cursor: pointer;
      }
      #${ALERT_ROOT_ID} li[data-ticket-uuid]:hover {
        background: var(--mcall-surface-2);
      }
      #${ALERT_ROOT_ID} li strong {
        color: var(--mcall-text-1);
        font-size: 13.5px;
        font-weight: 500;
        line-height: 1.3;
      }
      #${ALERT_ROOT_ID} li span {
        color: var(--mcall-text-3);
        font-size: 12px;
        line-height: 1.35;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
