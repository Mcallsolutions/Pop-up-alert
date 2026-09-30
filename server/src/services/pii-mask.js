// Mascaramento de dados pessoais nas mensagens do MTalk.
//
// Modulo puro (sem banco): recebe um texto e devolve o texto com cada dado
// pessoal trocado por um marcador ([CPF], [ENDERECO], ...) e so a CONTAGEM do
// que foi achado por tipo. Os valores encontrados nunca saem daqui: nem no
// retorno, nem em erro, nem em log.
//
// Principios:
// - na duvida, mascara. O digito verificador so escolhe o rotulo ([CPF],
//   [TELEFONE] ou [NUMERO]); nunca decide SE mascara um numero de documento;
// - a deteccao roda numa copia "dobrada" do texto (minusculas, sem acento),
//   com o MESMO tamanho do original: as posicoes achadas valem nas duas copias,
//   e o resto da frase sai intacto, com acento e maiusculas;
// - os detectores estruturados rodam antes dos genericos, e cada um ve o texto
//   ja mascarado pelos anteriores. O marcador fica em maiusculas na copia
//   dobrada e os padroes sao todos em minusculas, entao um marcador nunca e
//   mascarado de novo;
// - IP privado ("acesse 192.168.0.1") e instrucao de suporte e nao identifica
//   ninguem: sai do texto antes dos detectores e volta intacto no fim.

const { listCompanyTokens, listKnownAttendantNames } = require("./attendant-filter");

// Palavras que nunca viram [CLIENTE]/[ATENDENTE] mesmo fazendo parte de um
// nome: conectivos ("Maria das Gracas" nao pode mascarar todo "das"), sufixos
// de parentesco e nomes de empresa/funcao que alguns cadastros levam junto.
const NAME_STOP_WORDS = new Set([
  "das",
  "dos",
  "del",
  "der",
  "van",
  "von",
  "filho",
  "filha",
  "neto",
  "neta",
  "junior",
  "sobrinho",
  "suporte",
  "atendimento",
  "atendente",
  "financeiro",
  "comercial",
  "vendas",
  "sistema",
  "admin",
  "bot",
  "mcall",
  "equipe",
  "central",
  "sac",
  "noc",
  "tecnico",
  ...listCompanyTokens().map((token) => token.toLowerCase())
]);

// ---------------------------------------------------------------------------
// API publica

function maskText(text, { clientName = "", attendantNames = [] } = {}) {
  const state = runDetectors(String(text ?? ""), {
    clientNames: [clientName],
    attendantNames: [...listKnownAttendantNames(), ...toArray(attendantNames)]
  });
  return { text: state.text, found: state.found };
}

// Ultima barreira antes de um envio externo: roda os detectores estruturados
// (sem nomes) e lanca erro se sobrar qualquer dado pessoal. O erro leva so o
// TIPO e a QUANTIDADE (error.piiFound), nunca o valor.
//
// Payload em JSON e verificado campo a campo: a estrutura do JSON (aspas,
// virgulas, chaves) nao pode criar nem esconder um achado.
function assertNoPii(text) {
  const found = {};
  for (const value of collectStrings(String(text ?? ""))) {
    mergeCounts(found, runDetectors(value, { clientNames: [], attendantNames: [] }).found);
  }

  if (Object.keys(found).length) {
    const detalhe = Object.entries(found)
      .map(([tipo, total]) => `${tipo}: ${total}`)
      .join(", ");
    const error = new Error(`Dado pessoal detectado antes do envio (${detalhe}).`);
    error.statusCode = 422;
    error.publicMessage = error.message;
    error.piiFound = found;
    throw error;
  }
}

// Modulo 11 classico. Os 11 digitos iguais passam na conta, mas nao sao CPF.
function isValidCpf(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) {
    return false;
  }

  const verifier = (length) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(digits[index]) * (length + 1 - index);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };

  return verifier(9) === Number(digits[9]) && verifier(10) === Number(digits[10]);
}

// CNPJ numerico e alfanumerico (emitido desde jul/2026): cada caractere vale o
// codigo ASCII menos 48, entao "0"-"9" valem 0-9 e "A" = 17 ... "Z" = 42. O
// numerico e so o caso particular sem letras.
function isValidCnpj(value) {
  const chars = String(value ?? "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
  if (!/^[0-9A-Z]{12}\d{2}$/.test(chars) || /^(.)\1{13}$/.test(chars)) {
    return false;
  }

  const values = [...chars].map((char) => char.charCodeAt(0) - 48);
  const verifier = (weights) => {
    const sum = weights.reduce((total, weight, index) => total + values[index] * weight, 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };

  return (
    verifier([5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === values[12] &&
    verifier([6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === values[13]
  );
}

// ---------------------------------------------------------------------------
// Motor

function runDetectors(input, { clientNames, attendantNames }) {
  const state = { original: input, folded: fold(input), found: {}, vault: [] };
  if (!input) {
    return { text: "", found: {} };
  }

  protectPrivateIps(state);

  for (const detector of STRUCTURED_DETECTORS) {
    applyRanges(state, detector(state.folded));
  }

  applyRanges(state, findNames(state.folded, clientNames, "CLIENTE"));
  applyRanges(state, findNames(state.folded, attendantNames, "ATENDENTE"));
  applyRanges(state, findLongNumbers(state.folded));

  return { text: restoreVault(state), found: state.found };
}

// Minusculas e sem acento, caractere a caractere, mantendo o tamanho: quando a
// troca mudaria o tamanho (ligaduras, simbolos compostos), o caractere fica
// como esta. Espacos especiais viram espaco comum; quebra de linha fica.
function fold(text) {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const code = char.charCodeAt(0);

    if (code < 128) {
      out += char === "\t" ? " " : char.toLowerCase();
      continue;
    }

    if (/\s/.test(char)) {
      out += " ";
      continue;
    }

    const folded = char
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
    out += folded.length === 1 ? folded : char;
  }
  return out;
}

// Troca os trechos achados pelo marcador nas duas copias, de tras para frente,
// para as posicoes seguintes continuarem valendo. Trecho que encosta num
// marcador (ou num IP privado guardado) ou em outro trecho ja aceito e
// descartado: o primeiro detector a achar vence.
function applyRanges(state, ranges) {
  if (!ranges.length) {
    return;
  }

  const blocked = findProtectedRanges(state.folded);
  const accepted = [];

  for (const range of [...ranges].sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (range.end <= range.start || overlapsAny(range, blocked) || overlapsAny(range, accepted)) {
      continue;
    }
    accepted.push(range);
  }

  for (let index = accepted.length - 1; index >= 0; index -= 1) {
    const { start, end, type } = accepted[index];
    const marker = `[${type}]`;
    state.original = state.original.slice(0, start) + marker + state.original.slice(end);
    state.folded = state.folded.slice(0, start) + marker + state.folded.slice(end);
    state.found[type] = (state.found[type] || 0) + 1;
  }
}

const MARKER_RE = /\[[A-Z][A-Z_]*\]|[A-Z]+/g;

function findProtectedRanges(folded) {
  return [...folded.matchAll(MARKER_RE)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

function overlapsAny(range, list) {
  return list.some((other) => range.start < other.end && other.start < range.end);
}

// O IP privado sai do texto trocado por uma etiqueta em area de uso privado do
// Unicode (sem digito nem letra minuscula: nenhum detector casa com ela).
function protectPrivateIps(state) {
  const ranges = [];
  for (const match of state.folded.matchAll(IPV4_RE)) {
    if (isValidIpv4(match) && isPrivateIpv4(match)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const { start, end } = ranges[index];
    const tag = `${toLetters(state.vault.length)}`;
    state.vault.push({ tag, value: state.original.slice(start, end) });
    state.original = state.original.slice(0, start) + tag + state.original.slice(end);
    state.folded = state.folded.slice(0, start) + tag + state.folded.slice(end);
  }
}

function restoreVault(state) {
  let text = state.original;
  for (const { tag, value } of state.vault) {
    text = text.split(tag).join(value);
  }
  return text;
}

function toLetters(number) {
  let value = number;
  let out = "";
  do {
    out = String.fromCharCode(65 + (value % 26)) + out;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return out;
}

// ---------------------------------------------------------------------------
// Detectores estruturados, na ordem em que rodam.

// Link de mapa e par de coordenadas.
const MAP_URL_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:maps\.google\.[a-z.]+|google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.app\.goo\.gl|waze\.com\/ul|maps\.apple\.com)[^\s"'<>]*/g;
const COORDINATES_RE = /(?<![\d.])(-?\d{1,2}\.(\d{2,}))\s*,\s*(-?\d{1,3}\.(\d{2,}))(?![\d.])/g;

function findLocations(text) {
  const ranges = regexRanges(text, MAP_URL_RE, "LOCALIZACAO");

  for (const match of text.matchAll(COORDINATES_RE)) {
    const lat = Number(match[1]);
    const lon = Number(match[3]);
    // Com 2 casas so conta quando ha sinal negativo (o Brasil inteiro tem
    // longitude negativa): "1.50, 2.30" nao e coordenada.
    const precise = match[2].length >= 3 && match[4].length >= 3;
    const negative = match[1].startsWith("-") || match[3].startsWith("-");
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (precise || negative)) {
      ranges.push(toRange(match, "LOCALIZACAO"));
    }
  }

  return ranges;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/g;

function findEmails(text) {
  return regexRanges(text, EMAIL_RE, "EMAIL");
}

// Numerico ou alfanumerico, com ou sem mascara. Sem letras e o caso do CNPJ de
// sempre (DV invalido so troca o rotulo). Com letras, o DV e o que separa o
// CNPJ de uma palavra qualquer de 14 caracteres — a nao ser na mascara
// completa (12.ABC.345/01DE-35), que por si so ja e um CNPJ.
const CNPJ_RE = /(?<![0-9a-z])[0-9a-z]{2}\.?[0-9a-z]{3}\.?[0-9a-z]{3}\/?[0-9a-z]{4}-?\d{2}(?![0-9a-z])/g;

function findCnpjs(text) {
  const ranges = [];
  for (const match of text.matchAll(CNPJ_RE)) {
    const raw = match[0];
    const normalized = raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
    const separators = (raw.match(/[./-]/g) || []).length;
    const hasLetters = /[A-Z]/.test(normalized);

    if (isValidCnpj(normalized)) {
      ranges.push(toRange(match, "CNPJ"));
    } else if (!hasLetters) {
      ranges.push(toRange(match, separators >= 2 ? "CNPJ" : "NUMERO"));
    } else if (separators === 4) {
      ranges.push(toRange(match, "CNPJ"));
    }
  }
  return ranges;
}

// Formatado (com ponto, hifen ou espaco) e sempre [CPF], mesmo com DV errado.
// Os 11 digitos seguidos viram [CPF] com DV valido; senao, [TELEFONE] quando
// tem cara de celular (DDD + 9) e [NUMERO] no resto — mas sempre mascarados.
const CPF_RE = /(?<![\d.])\d{3}[. ]?\d{3}[. ]?\d{3}[- ]?\d{2}(?!\d)/g;

function findCpfs(text) {
  const ranges = [];
  for (const match of text.matchAll(CPF_RE)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length !== match[0].length || isValidCpf(digits)) {
      ranges.push(toRange(match, "CPF"));
    } else if (/^[1-9]{2}9\d{8}$/.test(digits)) {
      ranges.push(toRange(match, "TELEFONE"));
    } else {
      ranges.push(toRange(match, "NUMERO"));
    }
  }
  return ranges;
}

const CEP_RE = /(?<![\d.])(?:\d{5}-\d{3}|\d{2}\.\d{3}-\d{3})(?!\d)/g;
const CEP_KEYWORD_RE = /(?<![a-z])cep(?![a-z])[^\d\n]{0,15}(\d{8})(?!\d)/dg;

function findCeps(text) {
  return [...regexRanges(text, CEP_RE, "CEP"), ...groupRanges(text, CEP_KEYWORD_RE, "CEP")];
}

// 13 a 19 digitos (com espaco ou hifen) que passam no Luhn. Quando a sequencia
// inteira nao passa, testa os prefixos que terminam num grupo: a data de
// validade logo depois do numero nao pode esconder o cartao.
const CARD_RE = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;
const CVV_RE =
  /(?<![a-z])(?:cvv|cvc|cod(?:igo)?\.? (?:de )?seguranca)(?![a-z])\s*[:\-]?\s*(?:(?:e|eh) )?(\d{3,4})(?!\d)/dg;

function findCards(text) {
  const ranges = [];

  for (const match of text.matchAll(CARD_RE)) {
    const raw = match[0];
    const positions = [];
    for (let index = 0; index < raw.length; index += 1) {
      if (/\d/.test(raw[index])) positions.push(index);
    }

    // Celular com +55 tambem tem 13 digitos e passa no Luhn uma vez a cada dez:
    // fica para o detector de telefone, que vem logo depois.
    const allDigits = raw.replace(/\D/g, "");
    if (text[match.index - 1] === "+" || /^55[1-9]{2}9?\d{8}$/.test(allDigits)) {
      continue;
    }

    for (let length = Math.min(19, positions.length); length >= 13; length -= 1) {
      const end = positions[length - 1] + 1;
      const atGroupEnd = end === raw.length || !/\d/.test(raw[end]);
      const digits = raw.slice(0, end).replace(/\D/g, "");
      if (atGroupEnd && passesLuhn(digits)) {
        ranges.push({ start: match.index, end: match.index + end, type: "CARTAO" });
        break;
      }
    }
  }

  return [...ranges, ...groupRanges(text, CVV_RE, "CARTAO")];
}

function passesLuhn(digits) {
  if (/^0+$/.test(digits)) {
    return false;
  }

  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

// +55, (85), 9 opcional, 10-11 digitos com DDD. Sem DDD so conta com o hifen
// ou espaco do meio ("98888-7777"): 8 digitos corridos ficam para a rede de
// seguranca.
const PHONE_RE = /(?<![\d+])(?:\+ ?55[ .-]?|55[ .-]?)?(?:\( ?\d{2} ?\) ?|\d{2}[ .-]?)?(?:9[ .-]?)?\d{4}[ .-]?\d{4}(?!\d)/g;

function findPhones(text) {
  const ranges = [];
  for (const match of text.matchAll(PHONE_RE)) {
    const raw = match[0];
    const digits = raw.replace(/\D/g, "");
    let national = digits;

    if (raw.startsWith("+")) {
      national = digits.slice(2);
    } else if (digits.length >= 12 && digits.startsWith("55")) {
      national = digits.slice(2);
    }

    const localSeparator = /[ .-]\d{4}$/.test(raw);
    const validDdd = /^[1-9]{2}/.test(national);
    const isPhone =
      (national.length === 10 && validDdd) ||
      (national.length === 11 && validDdd && national[2] === "9") ||
      (national.length === 9 && national[0] === "9" && localSeparator) ||
      (national.length === 8 && localSeparator);

    if (isPhone) {
      ranges.push(toRange(match, "TELEFONE"));
    }
  }
  return ranges;
}

// Agencia e conta: mascara o numero e deixa a palavra, que ajuda a ler a frase.
const AGENCY_RE = /(?<![a-z])(?:agencia|ag)(?![a-z])\.?\s*(?:n[o°]?\.?\s*)?[:\-]?\s*(\d{3,5}(?:-[\dx])?)(?!\d)/dg;
const ACCOUNT_RE =
  /(?<![a-z])(?:conta(?: (?:corrente|poupanca|bancaria))?|c\/c|cc)(?![a-z])\.?\s*(?:n[o°]?\.?\s*)?[:\-]?\s*(\d[\d.]{2,13}(?:-[\dx])?)(?!\d)/dg;

function findBankAccounts(text) {
  const accounts = groupRanges(text, ACCOUNT_RE, "CONTA_BANCARIA").filter((range) => {
    const digits = text.slice(range.start, range.end).replace(/\D/g, "").length;
    return digits >= 4 && digits <= 12;
  });
  return [...groupRanges(text, AGENCY_RE, "CONTA_BANCARIA"), ...accounts];
}

// Chave aleatoria (UUID) e o valor que vem depois de "chave pix". "Pix" solto
// ("vou pagar via pix", "fiz o pix 2 vezes") so conta com dois-pontos.
const UUID_RE = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/g;
const PIX_KEY_RE =
  /(?<![a-z])chave(?: (?:do|de|da))? pix(?![a-z])\s*(?:(?:[:=]|e|eh|sera)\s*)?(?:(?:o|a|meu|minha)\s+)?([^\s"'[\]{}()<>,;]+)/dg;
const PIX_COLON_RE = /(?<![a-z])pix\s*[:=]\s*([^\s"'[\]{}()<>,;]+)/dg;

function findPixKeys(text) {
  const values = [...groupRanges(text, PIX_KEY_RE, "CHAVE_PIX"), ...groupRanges(text, PIX_COLON_RE, "CHAVE_PIX")].filter(
    (range) => /[\d@+]/.test(text.slice(range.start, range.end))
  );
  return [...regexRanges(text, UUID_RE, "CHAVE_PIX"), ...values];
}

// Senha do Wi-Fi e login PPPoE sao comuns no suporte. Com dois-pontos ou
// igual, o valor seguinte e sempre mascarado. Com um verbo de ligacao ("a
// senha e minhacasa"), tambem, a nao ser que o valor seja uma palavra comum
// ("a senha e muito dificil"). Sem nada entre os dois, so quando tem cara de
// segredo (digito ou simbolo) — senao "a senha nao funciona" viraria "a senha
// [SENHA] funciona".
const CREDENTIAL_KEYWORD_RE = /(?<![a-z0-9])(?:senha|password|pppoe|login|usuario)(?![a-z0-9])/g;
const CREDENTIAL_FILLERS =
  "wi-?fi|wifi|rede|roteador|modem|acesso|internet|pppoe|app|aplicativo|central|conexao|nova|atual|provisoria|antiga|cadastro|sistema|usuario|login|senha";
const CREDENTIAL_VALUE_RE = new RegExp(
  `(?:\\s+(?:(?:do|da|de|no|na|pro|pra|e)\\s+)?(?:${CREDENTIAL_FILLERS})(?![a-z0-9]))*` +
    `(\\s*[:=]\\s*|\\s+(?:(?:e|eh|sera|fica|ficou|agora e|nova e)\\s+)?)` +
    `([^\\s"'\\[\\]{}()<>,;]+)`,
  "y"
);

function findCredentials(text) {
  const ranges = [];

  for (const keyword of text.matchAll(CREDENTIAL_KEYWORD_RE)) {
    CREDENTIAL_VALUE_RE.lastIndex = keyword.index + keyword[0].length;
    const match = CREDENTIAL_VALUE_RE.exec(text);
    if (!match) {
      continue;
    }

    const value = match[2];
    const explicit = /[:=]/.test(match[1]);
    const linked = /[a-z]/.test(match[1]) && !CREDENTIAL_STOP_WORDS.has(value.replace(/[.,!?]+$/, ""));
    if (explicit || linked || looksLikeSecret(value)) {
      const end = match.index + match[0].length;
      ranges.push({ start: end - value.length, end, type: "SENHA" });
    }
  }

  return ranges;
}

const CREDENTIAL_STOP_WORDS = new Set(
  (
    "a o as os um uma de da do e que nao sim muito muita mesma mesmo errada errado certa certo correta correto nova " +
    "novo antiga antigo facil dificil grande pequena essa esse isso aquela aquele esta este qual igual diferente " +
    "padrao outra outro minha meu sua seu pra para com sem so tipo assim tudo nada bem fraca forte invalida " +
    "incorreta bloqueada expirada trocada alterada redefinida resetada mudada necessaria obrigatoria somente apenas " +
    "aqui ai la mais menos longa curta"
  ).split(" ")
);

function looksLikeSecret(value) {
  return /\d/.test(value) || /[a-z][@#$%&*!_.-]+[a-z0-9]/.test(value);
}

// RG so com a palavra por perto: um numero solto de 7 digitos nao diz nada.
const RG_RE = /(?<![a-z])(?:rg|identidade|registro geral)(?![a-z])[^\d\n]{0,25}?(\d[\d. -]{3,16}[\dx]?)(?!\d)/dg;

function findRgs(text) {
  return groupRanges(text, RG_RE, "RG").filter((range) => {
    const digits = text.slice(range.start, range.end).replace(/\D/g, "").length;
    return digits >= 5 && digits <= 14;
  });
}

// Data com "nasc" (nascimento, nasceu, nascido) ate 40 caracteres antes ou
// depois. Sem a palavra, "dia 30/09" e so um agendamento.
const MONTHS = "janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro";
const DATE_RE = new RegExp(
  `(?<!\\d)(?:\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\d{1,2} de (?:${MONTHS})(?: de \\d{2,4})?)(?!\\d)`,
  "g"
);
const BIRTH_KEYWORD_RE = /(?<![a-z])nasc[a-z]*/;

function findBirthDates(text) {
  const ranges = [];
  for (const match of text.matchAll(DATE_RE)) {
    const around = text.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40);
    if (BIRTH_KEYWORD_RE.test(around)) {
      ranges.push(toRange(match, "DATA_NASCIMENTO"));
    }
  }
  return ranges;
}

// IPv4 publico e IPv6. O privado ja saiu do texto em protectPrivateIps.
const IPV4_RE = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d|\.\d)/g;
const IPV6_RE = new RegExp(
  "(?<![0-9a-f:])(?:" +
    [
      "(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}",
      "(?:[0-9a-f]{1,4}:){1,7}:",
      "(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}",
      "(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}",
      "(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}",
      "(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}",
      "(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}",
      "[0-9a-f]{1,4}:(?::[0-9a-f]{1,4}){1,6}",
      ":(?::[0-9a-f]{1,4}){1,7}"
    ].join("|") +
    ")(?:/\\d{1,3})?(?![0-9a-z:])",
  "g"
);

function findPublicIps(text) {
  const ranges = [];
  for (const match of text.matchAll(IPV4_RE)) {
    if (isValidIpv4(match) && !isPrivateIpv4(match)) {
      ranges.push(toRange(match, "IP"));
    }
  }
  for (const match of text.matchAll(IPV6_RE)) {
    if (match[0] !== "::1" && match[0] !== "::") {
      ranges.push(toRange(match, "IP"));
    }
  }
  return ranges;
}

function isValidIpv4(match) {
  return [1, 2, 3, 4].every((group) => Number(match[group]) <= 255);
}

// Privado, loopback, link-local e os reservados (224+, onde caem as mascaras
// de rede como 255.255.255.0): nenhum deles identifica um assinante.
function isPrivateIpv4(match) {
  const [a, b] = [Number(match[1]), Number(match[2])];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

// MAC e serial de ONU (4 letras + 8 hexadecimais) ligam o equipamento ao
// assinante.
const MAC_RE = /(?<![0-9a-f:-])(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}(?![0-9a-f:-])/g;
const MAC_DOTTED_RE = /(?<![0-9a-f.])[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}(?![0-9a-f.])/g;
const MAC_PLAIN_RE = /(?<![a-z])mac(?: address)?(?![a-z])\s*[:-]?\s*([0-9a-f]{12})(?![0-9a-z])/dg;
const ONU_SERIAL_RE = /(?<![0-9a-z])[a-z]{4}[0-9a-f]{8}(?![0-9a-z])/g;
const SERIAL_RE = /(?<![a-z])(?:serial|numero de serie|n de serie)(?![a-z])\s*[:-]?\s*([0-9a-z][0-9a-z-]{5,23})(?![0-9a-z])/dg;

function findEquipment(text) {
  const serials = [...regexRanges(text, ONU_SERIAL_RE, "EQUIPAMENTO"), ...groupRanges(text, SERIAL_RE, "EQUIPAMENTO")].filter(
    (range) => /\d/.test(text.slice(range.start, range.end))
  );
  return [
    ...regexRanges(text, MAC_RE, "EQUIPAMENTO"),
    ...regexRanges(text, MAC_DOTTED_RE, "EQUIPAMENTO"),
    ...groupRanges(text, MAC_PLAIN_RE, "EQUIPAMENTO"),
    ...serials
  ];
}

// ---------------------------------------------------------------------------
// Endereco
//
// Mascara so o trecho do endereco e preserva o resto da frase ("pode mandar o
// tecnico na [ENDERECO] amanha?"). O trecho vai da palavra-chave ate o fim do
// nome (ate 6 palavras), do numero e dos complementos, e para em quebra de
// linha, "?" ou "!".
//
// Tres tipos de palavra-chave:
// - logradouro (rua, avenida...): basta um nome ou um numero depois;
// - lugar ambiguo (vila, via, parque, praca, largo...): so conta com um numero
//   a ate ~40 caracteres — "pagar via pix" fica intacto;
// - complemento (apto, bloco, casa, quadra, lote...): so conta com o valor
//   logo depois — "estou em casa" fica intacto, "casa 5" nao.

const STREET_KEYWORDS = [
  "rua",
  "r.",
  "avenida",
  "av.",
  "av",
  "travessa",
  "alameda",
  "al.",
  "rodovia",
  "rod.",
  "estrada",
  "beco",
  "viela",
  "ladeira",
  "servidao",
  "condominio",
  "cond.",
  "loteamento",
  "sitio",
  "chacara",
  "fazenda"
];
// "tv" tambem e televisao e "passagem" tambem e a do cabo: entram como ambiguas.
const PLACE_KEYWORDS = [
  "vila",
  "via",
  "parque",
  "conjunto",
  "cj.",
  "cj",
  "residencial",
  "praca",
  "largo",
  "passagem",
  "tv.",
  "tv"
];
const COMPLEMENT_KEYWORDS = [
  "apartamento",
  "apto.",
  "apto",
  "ap.",
  "ap",
  "bloco",
  "bl.",
  "bl",
  "casa",
  "sala",
  "quadra",
  "qd.",
  "qd",
  "lote",
  "lt.",
  "lt",
  "torre"
];
// Complementos cujo valor pode ser uma letra ("bloco B", "quadra C").
const LETTER_COMPLEMENTS = new Set(["bloco", "bl", "torre", "quadra", "qd", "lote", "lt"]);
const NUMBER_INTROS = new Set(["n", "no", "num", "numero", "nro", "nr", "n°"]);
const NAME_LINKS = new Set(["de", "da", "do"]);
const MAX_NAME_WORDS = 6;
const MAX_NUMBER_DISTANCE = 40;
// Palavras que encerram o nome do logradouro: verbo, advérbio e pronome comuns
// no chat. Sem elas, "estou na rua esperando o tecnico" viraria endereco.
const ADDRESS_STOP_WORDS = new Set(
  (
    "e ou que pra pro para porque pois mas entao ai la aqui ali ok obrigado obrigada pode podem poderia vou vai vamos " +
    "vem venha esta estao estou estamos ta to tem tenho temos sem com ja nao sim hoje amanha ontem agora depois cedo " +
    "tarde noite esperando aguardando toda todo todos todas inteira inteiro tambem so mesmo mesma isso esse essa este " +
    "isto aquela aquele onde quando como qual quais internet sinal tecnico favor fica ficou perto proximo proxima em " +
    "no na nos nas ao aos pelo pela voces voce vc eu ele ela meu minha seu sua me te lhe foi era sera ser estar " +
    "ficar caiu cai nada tudo muito pouco mais menos bem mal ate desde pq tb tbm blz cep"
  ).split(" ")
);
// Numero seguido de unidade e quantidade, nao numero de casa ("via pix 3
// parcelas", "tv 50 polegadas", "plano residencial 300 mega").
const UNIT_WORDS = new Set(
  (
    "mega megas mb mbps giga gigas gb kb kbps reais real reis conto contos parcela parcelas vez vezes x dia dias " +
    "hora horas h hs min mins minuto minutos segundo segundos semana semanas mes meses ano anos porcento pessoa " +
    "pessoas polegada polegadas pol metro metros m cm km aparelho aparelhos dispositivo dispositivos tv tvs ponto " +
    "pontos quarto quartos cliente clientes mil unidade unidades"
  ).split(" ")
);

const KEYWORD_KIND = new Map([
  ...STREET_KEYWORDS.map((word) => [word, "street"]),
  ...PLACE_KEYWORDS.map((word) => [word, "place"]),
  ...COMPLEMENT_KEYWORDS.map((word) => [word, "complement"]),
  ["bairro", "bairro"]
]);
const ADDRESS_KEYWORD_RE = new RegExp(
  `(?<![a-z0-9])(?:${[...KEYWORD_KIND.keys()]
    .sort((a, b) => b.length - a.length)
    .map((word) => (word.endsWith(".") ? escapeRegex(word) : `${escapeRegex(word)}(?![a-z0-9.])`))
    .join("|")})`,
  "g"
);

function findAddresses(text) {
  const ranges = [];
  let lastEnd = -1;

  for (const match of text.matchAll(ADDRESS_KEYWORD_RE)) {
    const start = match.index;
    if (start < lastEnd) {
      continue;
    }

    const keyword = match[0];
    const kind = KEYWORD_KIND.get(keyword);
    const keywordEnd = start + keyword.length;
    let end = null;

    if (kind === "complement") {
      const value = readComplementValue(text, keywordEnd, stripDot(keyword));
      end = value ? parseAddressTail(text, value.end, { sawNumber: true }).end : null;
    } else if (kind === "bairro") {
      const value = readBairroValue(text, keywordEnd);
      end = value ? parseAddressTail(text, value.end, { sawNumber: true }).end : null;
    } else {
      const tail = parseAddressTail(text, keywordEnd, { sawNumber: false, isStreet: kind === "street" });
      const numberOk = tail.numberAt >= 0 && tail.numberAt - start <= MAX_NUMBER_DISTANCE;
      if (kind === "place" ? numberOk : tail.nameWords > 0 || tail.numberAt >= 0) {
        end = tail.end;
      }
    }

    if (end !== null && end > keywordEnd) {
      ranges.push({ start, end, type: "ENDERECO" });
      lastEnd = end;
    }
  }

  return ranges;
}

// Le nome, numero e complementos a partir de pos. Devolve onde o trecho acaba
// (fim do ultimo pedaco aceito), quantas palavras de nome entraram e onde
// comecou o primeiro numero.
function parseAddressTail(text, from, { sawNumber: startedWithNumber = false, isStreet = false } = {}) {
  let pos = from;
  let end = from;
  let nameWords = 0;
  let sawNumber = startedWithNumber;
  let numberAt = -1;

  const takeNumber = (start, stop) => {
    sawNumber = true;
    if (numberAt < 0) numberAt = start;
    end = stop;
    pos = stop;
  };

  for (let guard = 0; guard < 40; guard += 1) {
    const token = readToken(text, pos);

    if (token.type === "sep") {
      // "Rua das Acacias, 123, apto 45": a virgula so continua o endereco
      // quando o que vem depois e numero, complemento ou bairro.
      const next = readToken(text, token.end);
      if (continuesAddress(text, next)) {
        pos = token.end;
        continue;
      }
      break;
    }

    if (token.type === "sn") {
      takeNumber(token.start, token.end);
      continue;
    }

    if (token.type === "number") {
      const next = readToken(text, token.end);
      if (isUnit(text, next)) {
        break;
      }
      if (next.type === "word" && next.value === "andar") {
        end = next.end;
        pos = next.end;
        continue;
      }
      if (sawNumber) {
        break;
      }
      // "Rua 7 de Setembro": numero seguido de "de" + palavra faz parte do nome.
      if (next.type === "word" && NAME_LINKS.has(next.value)) {
        const after = readToken(text, next.end);
        if (after.type === "word" && !ADDRESS_STOP_WORDS.has(after.value) && !UNIT_WORDS.has(after.value)) {
          nameWords += 2;
          end = after.end;
          pos = after.end;
          continue;
        }
      }
      // "Rua 10, 45": numero logo depois da palavra de logradouro e o nome.
      if (isStreet && nameWords === 0) {
        nameWords += 1;
        end = token.end;
        pos = token.end;
        continue;
      }
      takeNumber(token.start, token.end);
      continue;
    }

    if (token.type !== "word") {
      break;
    }

    const word = token.value;

    if (NUMBER_INTROS.has(word) || word === "km") {
      const number = readNumberAfter(text, token.end);
      if (number) {
        takeNumber(token.start, number.end);
        continue;
      }
    }

    if (KEYWORD_KIND.get(word) === "complement" || KEYWORD_KIND.get(`${word}.`) === "complement") {
      const value = readComplementValue(text, token.end, word);
      if (value) {
        end = value.end;
        pos = value.end;
        continue;
      }
    }

    if ((word === "fundos" || word === "frente") && (sawNumber || nameWords)) {
      end = token.end;
      pos = token.end;
      continue;
    }

    if (word === "bairro") {
      const value = readBairroValue(text, token.end);
      if (value) {
        end = value.end;
        pos = value.end;
        continue;
      }
      break;
    }

    if (!sawNumber && nameWords < MAX_NAME_WORDS && !ADDRESS_STOP_WORDS.has(word) && !UNIT_WORDS.has(word)) {
      nameWords += 1;
      end = token.end;
      pos = token.end;
      continue;
    }

    break;
  }

  return { end, nameWords, numberAt };
}

function continuesAddress(text, token) {
  if (token.type === "number" || token.type === "sn") {
    return true;
  }
  if (token.type !== "word") {
    return false;
  }
  if (NUMBER_INTROS.has(token.value) || token.value === "km") {
    return Boolean(readNumberAfter(text, token.end));
  }
  if (token.value === "bairro" || token.value === "fundos") {
    return true;
  }
  return KEYWORD_KIND.get(token.value) === "complement" && Boolean(readComplementValue(text, token.end, token.value));
}

// "km" depois de um numero e unidade ("fica a 5 km"), mas antes de outro numero
// e marco de rodovia ("CE 040 km 12").
function isUnit(text, token) {
  if (token.type !== "word" || !UNIT_WORDS.has(token.value)) {
    return false;
  }
  return !(token.value === "km" && readNumberAfter(text, token.end));
}

function readNumberAfter(text, pos) {
  let token = readToken(text, pos);
  if (token.type === "sep" && token.value === ":") {
    token = readToken(text, token.end);
  }
  return token.type === "number" ? token : null;
}

// Valor do complemento: numero (sem unidade depois) ou, para bloco/torre/
// quadra/lote, uma letra so.
function readComplementValue(text, pos, keyword) {
  let token = readToken(text, pos);
  if (token.type === "sep" && token.value === ":") {
    token = readToken(text, token.end);
  }

  if (token.type === "number") {
    return isUnit(text, readToken(text, token.end)) ? null : token;
  }

  if (token.type === "word" && token.value.length === 1 && LETTER_COMPLEMENTS.has(keyword)) {
    return token;
  }

  return null;
}

// "bairro Centro" -> ate 4 palavras. Cidade e estado ficam de fora de proposito.
function readBairroValue(text, pos) {
  let cursor = pos;
  let end = null;
  let words = 0;

  let token = readToken(text, cursor);
  if (token.type === "sep" && token.value === ":") {
    cursor = token.end;
    token = readToken(text, cursor);
  }

  while (words < 4) {
    if (token.type === "word" && !ADDRESS_STOP_WORDS.has(token.value) && !UNIT_WORDS.has(token.value)) {
      words += 1;
    } else if (token.type === "number" && words === 0) {
      words += 1;
    } else if (token.type === "word" && NAME_LINKS.has(token.value) && words > 0) {
      // "bairro Jardim das Oliveiras": o conectivo entra se vier nome depois.
    } else {
      break;
    }
    end = token.end;
    cursor = token.end;
    token = readToken(text, cursor);
  }

  return end === null ? null : { end };
}

// Tokens do texto dobrado. Espaco e tab sao pulados; quebra de linha, "?" e
// "!" param o endereco; marcadores e IPs guardados tambem (sao "other").
function readToken(text, from) {
  let index = from;
  while (index < text.length && text[index] === " ") {
    index += 1;
  }

  if (index >= text.length) {
    return { type: "end", start: index, end: index, value: "" };
  }

  const rest = text.slice(index, index + 60);
  let match = /^s\/n(?![a-z0-9])|^s\.n\.?(?![a-z0-9])|^sn(?![a-z0-9])/.exec(rest);
  if (match) {
    return { type: "sn", start: index, end: index + match[0].length, value: "s/n" };
  }

  match = /^\d+(?:[.,]\d+)*(?:[a-z°](?![a-z0-9]))?/.exec(rest);
  if (match) {
    return { type: "number", start: index, end: index + match[0].length, value: match[0] };
  }

  match = /^[a-z][a-z'’]*\.?°?/.exec(rest);
  if (match) {
    return { type: "word", start: index, end: index + match[0].length, value: stripDot(match[0]) };
  }

  const char = text[index];
  if (",;:-–—".includes(char)) {
    return { type: "sep", start: index, end: index + 1, value: char };
  }

  return { type: char === "\n" || char === "\r" || char === "?" || char === "!" ? "stop" : "other", start: index, end: index + 1, value: char };
}

function stripDot(word) {
  return word.replace(/\.$/, "");
}

// ---------------------------------------------------------------------------
// Nomes e rede de seguranca

// Cada palavra do nome com 3+ letras. Palavras seguidas do mesmo nome ("maria
// silva", "maria da silva") viram um marcador so.
const nameRegexCache = new Map();

function findNames(text, names, type) {
  const regex = buildNameRegex(names);
  return regex ? regexRanges(text, regex, type) : [];
}

function buildNameRegex(names) {
  const words = new Set();
  for (const name of names) {
    for (const word of fold(String(name ?? "")).split(/[^a-z]+/)) {
      if (word.length >= 3 && !NAME_STOP_WORDS.has(word)) {
        words.add(word);
      }
    }
  }

  if (!words.size) {
    return null;
  }

  const key = [...words].sort().join("|");
  if (!nameRegexCache.has(key)) {
    if (nameRegexCache.size > 200) {
      nameRegexCache.clear();
    }
    const alternatives = [...words]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegex)
      .join("|");
    nameRegexCache.set(
      key,
      new RegExp(`(?<![a-z0-9])(?:${alternatives})(?: +(?:(?:de|da|do|dos|das|e) +)?(?:${alternatives}))*(?![a-z0-9])`, "g")
    );
  }

  return nameRegexCache.get(key);
}

// Qualquer sequencia de 8+ digitos que sobrou, mesmo com ".", "-" ou espaco no
// meio: protocolo, conta, documento que nenhum detector reconheceu.
const LONG_NUMBER_RE = /(?<!\d)\d(?:[ .-]?\d){7,}(?!\d)/g;

function findLongNumbers(text) {
  return regexRanges(text, LONG_NUMBER_RE, "NUMERO");
}

// ---------------------------------------------------------------------------
// Utilitarios

const STRUCTURED_DETECTORS = [
  findLocations,
  findEmails,
  findCnpjs,
  findCpfs,
  findCeps,
  findCards,
  findPhones,
  findBankAccounts,
  findPixKeys,
  findCredentials,
  findRgs,
  findBirthDates,
  findPublicIps,
  findEquipment,
  findAddresses
];

function regexRanges(text, regex, type) {
  return [...text.matchAll(regex)].map((match) => toRange(match, type));
}

// Mascara so o grupo 1 (o valor), deixando a palavra-chave na frase.
function groupRanges(text, regex, type) {
  return [...text.matchAll(regex)]
    .filter((match) => match.indices?.[1])
    .map((match) => ({ start: match.indices[1][0], end: match.indices[1][1], type }));
}

function toRange(match, type) {
  return { start: match.index, end: match.index + match[0].length, type };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function collectStrings(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    return [text];
  }

  if (!parsed || typeof parsed !== "object") {
    return [text];
  }

  const out = [];
  const walk = (value) => {
    if (typeof value === "string") {
      out.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        out.push(key);
        walk(item);
      }
    }
  };
  walk(parsed);
  return out;
}

function mergeCounts(target, source) {
  for (const [type, total] of Object.entries(source)) {
    target[type] = (target[type] || 0) + total;
  }
  return target;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

module.exports = {
  assertNoPii,
  foldText: fold,
  isValidCnpj,
  isValidCpf,
  maskText
};
