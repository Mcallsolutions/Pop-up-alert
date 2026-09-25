// Pop-up de alertas na tela de tickets do MTalk.
//
// A extensao nao le a pagina nem a sessao do MTalk: os tickets sao coletados
// pelo servidor local direto na API oficial do MTalk. Este script so pede os
// alertas ja calculados (via service worker), desenha o pop-up e toca o bip de
// inatividade.
(() => {
  // Mesmo ritmo da coleta padrao do servidor (MTALK_COLLECT_INTERVAL_SECONDS).
  const REFRESH_INTERVAL_MS = 60 * 1000;
  const ALERT_SNOOZE_MS = 5 * 60 * 1000;
  const ALERT_ROOT_ID = "mcall-ticket-tag-alert-root";
  // Bip de inatividade: tom curto e baixo, gerado na hora (sem arquivo de som).
  const BEEP_FREQUENCY_HZ = 880;
  const BEEP_SECONDS = 0.18;
  const BEEP_VOLUME = 0.12;

  let refreshTimer = null;
  let alertSnoozedUntil = 0;
  let audioContext = null;
  let soundUnlocked = false;
  let beepQueue = Promise.resolve();

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
  setupSound();
  refreshAlerts().catch(reportError);
  refreshTimer = window.setInterval(() => refreshAlerts().catch(reportError), REFRESH_INTERVAL_MS);
  window.addEventListener("beforeunload", () => window.clearInterval(refreshTimer));

  async function refreshAlerts({ force = false } = {}) {
    const response = await sendRuntimeMessage({ type: "FETCH_ALERTS", canBeep: canBeep({ force }) });

    // API fora do ar ou leitura velha: melhor nenhum pop-up do que um alerta
    // que nao reflete mais a fila.
    if (!response?.ok || !response.alerts || response.alerts.stale) {
      removeAlert();
      return { ok: false, error: response?.error || "Sem coleta recente no servidor" };
    }

    renderAlerts(response.alerts, { force });
    if (response.beep) {
      playBeep();
    }
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
        [ticket.queue, ticket.attendant, ticket.company].filter(Boolean).join(" - ")
      ),
      buildAlertSection("inactivity", "Alerta de inatividade", inactive, (ticket) => {
        const inactiveFor = Number(ticket.inactivityMinutes || 0);
        const inactivityText = inactiveFor > 0 ? `${inactiveFor} min sem atividade` : `Mais de ${threshold} min sem atividade`;
        return [inactivityText, ticket.displayTime ? `Horario ${ticket.displayTime}` : "", ticket.queue, ticket.attendant]
          .filter(Boolean)
          .join(" - ");
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
          <div class="mcall-alert__brand">
            <span class="mcall-alert__eyebrow">Mcall</span>
            <strong>Alertas de tickets</strong>
          </div>
          <button type="button" class="mcall-alert__close" aria-label="Fechar alerta">&times;</button>
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
      item.addEventListener("click", () => {
        window.location.href = `${window.location.origin}/tickets/${encodeURIComponent(item.dataset.ticketUuid)}`;
      });
    });
  }

  function removeAlert() {
    document.getElementById(ALERT_ROOT_ID)?.remove();
  }

  // O Chrome so libera som numa pagina depois de o usuario interagir com ela
  // (clique ou tecla) — ou quando ele chegou por um clique vindo de outra
  // pagina do MTalk. O contexto de audio nasce com o script; se nascer
  // bloqueado, cada clique ou tecla tenta liberar de novo. Liberado, ele fica
  // suspenso fora do bip, para nao segurar a saida de som do computador.
  function setupSound() {
    if (typeof AudioContext !== "function") {
      return;
    }

    // Sem audio a pagina segue com o pop-up, so sem bip.
    try {
      audioContext = new AudioContext();
    } catch (error) {
      reportError(error);
      return;
    }
    audioContext.addEventListener("statechange", handleSoundStateChange);
    handleSoundStateChange();
    if (!soundUnlocked) {
      window.addEventListener("pointerdown", unlockSound, true);
      window.addEventListener("keydown", unlockSound, true);
    }
  }

  function unlockSound() {
    audioContext.resume().catch(() => undefined);
  }

  function handleSoundStateChange() {
    if (soundUnlocked || audioContext.state !== "running") {
      return;
    }

    soundUnlocked = true;
    window.removeEventListener("pointerdown", unlockSound, true);
    window.removeEventListener("keydown", unlockSound, true);
    audioContext.suspend().catch(() => undefined);
  }

  // A aba so disputa o bip quando consegue toca-lo agora: com o som liberado e
  // fora do silencio de 5 minutos do "x". Senao o bip fica para a proxima
  // consulta — desta aba ou de outra aba do MTalk.
  function canBeep({ force }) {
    return soundUnlocked && (force || alertSnoozedUntil <= Date.now());
  }

  // Em fila: um bip so comeca depois de o anterior suspender o audio.
  function playBeep() {
    beepQueue = beepQueue.then(beepOnce).catch(reportError);
  }

  async function beepOnce() {
    await audioContext.resume();

    const start = audioContext.currentTime;
    const oscillator = new OscillatorNode(audioContext, { type: "sine", frequency: BEEP_FREQUENCY_HZ });
    const volume = new GainNode(audioContext, { gain: 0 });
    // Sobe e desce em rampa: som que comeca ou para seco estala na caixa de som.
    volume.gain.setValueAtTime(0, start);
    volume.gain.linearRampToValueAtTime(BEEP_VOLUME, start + 0.01);
    volume.gain.exponentialRampToValueAtTime(0.0001, start + BEEP_SECONDS);
    oscillator.connect(volume).connect(audioContext.destination);

    const ended = new Promise((resolve) => oscillator.addEventListener("ended", resolve, { once: true }));
    oscillator.start(start);
    oscillator.stop(start + BEEP_SECONDS);
    await ended;
    await audioContext.suspend();
  }

  function buildAlertSection(type, title, group, getMeta) {
    const tickets = group.items || [];
    if (!tickets.length) {
      return "";
    }

    const total = Number(group.total || tickets.length);
    const heading = total > tickets.length ? `${title} (${tickets.length} de ${total})` : `${title} (${total})`;
    const items = tickets
      .map((ticket) => {
        const meta = escapeHtml(getMeta(ticket));
        const uuid = ticket.ticketUuid ? ` data-ticket-uuid="${escapeHtml(ticket.ticketUuid)}"` : "";
        return `<li${uuid}><strong>${escapeHtml(ticket.clientName)}</strong>${meta ? `<span>${meta}</span>` : ""}</li>`;
      })
      .join("");

    return `
      <div class="mcall-alert__section" data-alert-type="${type}">
        <strong class="mcall-alert__section-title">${escapeHtml(heading)}</strong>
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
    // Mesma paleta do painel (admin/src/styles.css). As cores ficam em variaveis
    // proprias, presas ao root do alerta, para nao colidir com o CSS do MTalk.
    style.textContent = `
      #${ALERT_ROOT_ID} {
        --mcall-bg: #060f1e;
        --mcall-bg-2: #0d1e36;
        --mcall-green: #00e5b0;
        --mcall-green-border: rgba(0, 229, 176, 0.2);
        --mcall-green-glow: rgba(0, 229, 176, 0.12);
        --mcall-blue: #60a5fa;
        --mcall-yellow: #facc15;
        --mcall-text-1: #f0f6ff;
        --mcall-text-2: #8fa8c8;
        --mcall-text-3: #4d6480;
        --mcall-border: rgba(255, 255, 255, 0.06);
        position: fixed;
        right: 18px;
        top: 18px;
        z-index: 2147483647;
        width: min(380px, calc(100vw - 36px));
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      #${ALERT_ROOT_ID} .mcall-alert {
        background: linear-gradient(180deg, var(--mcall-bg-2) 0%, var(--mcall-bg) 100%);
        color: var(--mcall-text-1);
        border: 1px solid var(--mcall-green-border);
        border-radius: 8px;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45), 0 0 28px var(--mcall-green-glow);
        overflow: hidden;
      }
      #${ALERT_ROOT_ID} .mcall-alert__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px;
        border-bottom: 1px solid var(--mcall-border);
      }
      #${ALERT_ROOT_ID} .mcall-alert__brand {
        display: grid;
        gap: 3px;
      }
      #${ALERT_ROOT_ID} .mcall-alert__eyebrow {
        color: var(--mcall-green);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      #${ALERT_ROOT_ID} .mcall-alert__header strong {
        color: var(--mcall-text-1);
        font-size: 15px;
        line-height: 1.2;
      }
      #${ALERT_ROOT_ID} .mcall-alert__close {
        appearance: none;
        width: 30px;
        height: 30px;
        border: 1px solid rgba(59, 130, 246, 0.22);
        border-radius: 8px;
        background: rgba(59, 130, 246, 0.12);
        color: var(--mcall-text-1);
        cursor: pointer;
        font-size: 20px;
        line-height: 1;
        transition: background 0.2s, border-color 0.2s;
      }
      #${ALERT_ROOT_ID} .mcall-alert__close:hover {
        background: rgba(0, 229, 176, 0.1);
        border-color: var(--mcall-green-border);
      }
      #${ALERT_ROOT_ID} .mcall-alert__body {
        display: grid;
        gap: 14px;
        max-height: calc(100vh - 120px);
        overflow-y: auto;
        padding: 12px 14px 14px;
        scrollbar-color: var(--mcall-text-3) transparent;
      }
      #${ALERT_ROOT_ID} [data-alert-type="missing-tag"] {
        --mcall-accent: var(--mcall-blue);
      }
      #${ALERT_ROOT_ID} [data-alert-type="inactivity"] {
        --mcall-accent: var(--mcall-yellow);
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
        font-size: 12px;
        font-weight: 800;
        line-height: 1.3;
        text-transform: uppercase;
      }
      #${ALERT_ROOT_ID} .mcall-alert__section-title::before {
        content: "";
        width: 8px;
        height: 8px;
        flex-shrink: 0;
        border-radius: 999px;
        background: var(--mcall-accent);
        box-shadow: 0 0 10px var(--mcall-accent);
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
        padding: 9px 10px;
        border: 1px solid var(--mcall-border);
        border-left: 3px solid var(--mcall-accent);
        border-radius: 8px;
        background: rgba(3, 9, 18, 0.45);
        transition: background 0.2s, border-color 0.2s;
      }
      #${ALERT_ROOT_ID} li[data-ticket-uuid] {
        cursor: pointer;
      }
      #${ALERT_ROOT_ID} li[data-ticket-uuid]:hover {
        background: rgba(255, 255, 255, 0.05);
        border-color: var(--mcall-green-border);
        border-left-color: var(--mcall-accent);
      }
      #${ALERT_ROOT_ID} li strong {
        color: var(--mcall-text-1);
        font-size: 13px;
        line-height: 1.3;
      }
      #${ALERT_ROOT_ID} li span {
        color: var(--mcall-text-2);
        font-size: 12px;
        line-height: 1.3;
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
