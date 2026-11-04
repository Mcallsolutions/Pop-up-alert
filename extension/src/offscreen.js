// Documento offscreen que toca o bip de inatividade.
//
// O bip morava no content script, dentro da aba do MTalk, e por isso quase
// nunca tocava: o Chrome so libera som numa aba depois de um clique ou tecla
// NAQUELA pagina desde que ela abriu. Recarregou o MTalk, abriu um ticket pelo
// pop-up (que recarrega a pagina) ou deixou a aba quieta, e o bip ficava mudo
// sem aviso nenhum. Documento offscreen criado com o motivo AUDIO_PLAYBACK nao
// tem essa trava: o service worker decide o bip e pede para ele tocar. O Chrome
// fecha este documento sozinho depois de 30 s sem audio.
//
// Ele recebe toda mensagem de runtime da extensao (do popup, do content
// script...), entao responde apenas as que trazem target "offscreen".

// Dois toques subindo ("dim-dom"): mais facil de notar que um estalo curto.
const TONES = [
  { frequency: 880, offset: 0, duration: 0.16 },
  { frequency: 1320, offset: 0.2, duration: 0.24 }
];
const VOLUME = 0.5;
// Folga antes do primeiro toque: fone USB/Bluetooth parado pode levar um
// instante para acordar, e engolia o comeco (ou o bip inteiro, de 0,18 s).
const LEAD_SECONDS = 0.12;
const RESUME_TIMEOUT_MS = 2000;

let audioContext = null;
let queue = Promise.resolve();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  if (message.type === "PLAY_BEEP") {
    // Em fila: dois pedidos seguidos tocam um depois do outro, sem sobrepor.
    queue = queue.then(playBeep, playBeep);
    queue.then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error?.message || "Falha ao tocar o bip" })
    );
    return true;
  }

  sendResponse({ ok: false, error: "Tipo de mensagem desconhecido no documento de audio" });
  return false;
});

async function playBeep() {
  const context = await getRunningContext();
  const firstStart = context.currentTime + LEAD_SECONDS;
  let lastOscillator = null;
  let endsAt = firstStart;

  for (const tone of TONES) {
    const start = firstStart + tone.offset;
    const end = start + tone.duration;
    const oscillator = new OscillatorNode(context, { type: "sine", frequency: tone.frequency });
    const volume = new GainNode(context, { gain: 0 });

    // Sobe e desce em rampa: som que comeca ou para seco estala na caixa de som.
    volume.gain.setValueAtTime(0, start);
    volume.gain.linearRampToValueAtTime(VOLUME, start + 0.015);
    volume.gain.setValueAtTime(VOLUME, end - 0.06);
    volume.gain.linearRampToValueAtTime(0, end);
    oscillator.connect(volume).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(end);

    lastOscillator = oscillator;
    endsAt = end;
  }

  // Espera o ultimo toque acabar (com teto, para a fila nunca travar).
  const waitMs = (endsAt - context.currentTime) * 1000 + 500;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    lastOscillator.addEventListener(
      "ended",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

async function getRunningContext() {
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContext();
  }

  if (audioContext.state !== "running") {
    // resume() que o Chrome nao libera fica pendurado em vez de falhar: o teto
    // transforma isso em erro, que aparece no popup da extensao.
    await Promise.race([
      audioContext.resume(),
      new Promise((resolve) => setTimeout(resolve, RESUME_TIMEOUT_MS))
    ]);
  }

  if (audioContext.state !== "running") {
    const state = audioContext.state;
    // Descarta o contexto travado: o proximo bip tenta com um novo (fone que
    // voltou, saida de som trocada).
    audioContext.close().catch(() => undefined);
    audioContext = null;
    throw new Error(`O Chrome nao liberou a saida de som (audio ${state}).`);
  }

  return audioContext;
}
