// Empacota a pasta /extension em um .zip para o painel oferecer download.
//
// O ZIP e montado na mao (zlib + CRC32) porque a extensao inteira tem menos de
// 40 KB e nao vale puxar uma dependencia de compactacao so para isso. Tudo fica
// em memoria: nao ha arquivo temporario em disco.

const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { promisify } = require("node:util");

const deflateRaw = promisify(zlib.deflateRaw);

const EXTENSION_DIR = path.resolve(__dirname, "../../../extension");
// Lixo de editor/SO que nunca deve viajar dentro do pacote.
const IGNORED = new Set([".DS_Store", "Thumbs.db", ".git", "node_modules"]);

async function readManifest() {
  const raw = await fs.readFile(path.join(EXTENSION_DIR, "manifest.json"), "utf8");
  return JSON.parse(raw);
}

// Nome do arquivo e da pasta que aparece ao descompactar: quem recebe abre o
// zip, ve uma pasta so e aponta o "Carregar sem compactacao" para ela.
function packageName(manifest) {
  const version = String(manifest?.version || "0.0.0").trim();
  return `mcall-ticket-tag-monitor-extensao-v${version}`;
}

// Resumo para o painel mostrar antes do download (versao, tamanho, arquivos).
async function describeExtensionPackage() {
  const manifest = await readManifest();
  const files = await collectFiles(EXTENSION_DIR);

  return {
    nome: manifest.name,
    versao: manifest.version,
    arquivo: `${packageName(manifest)}.zip`,
    totalArquivos: files.length,
    // Tamanho antes de compactar: o do zip so se sabe depois de montar.
    totalBytes: files.reduce((soma, file) => soma + file.content.length, 0),
    atualizadoEm: files.reduce((maior, file) => (file.mtime > maior ? file.mtime : maior), new Date(0)).toISOString()
  };
}

// Devolve { fileName, buffer } pronto para o res.send.
async function buildExtensionZip() {
  const manifest = await readManifest();
  const files = await collectFiles(EXTENSION_DIR);

  if (!files.length) {
    const error = new Error("Pasta /extension vazia ou indisponivel no servidor.");
    error.statusCode = 500;
    error.publicMessage = error.message;
    throw error;
  }

  const root = packageName(manifest);
  const entries = await Promise.all(
    files.map((file) => buildEntry(`${root}/${file.relativePath}`, file.content, file.mtime))
  );

  return { fileName: `${root}.zip`, buffer: assembleZip(entries) };
}

// Le a pasta inteira (recursivo) com caminho relativo em barras, do jeito que o
// ZIP guarda.
async function collectFiles(baseDir, relativeDir = "") {
  const currentDir = path.join(baseDir, relativeDir);
  const dirEntries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
  const files = [];

  for (const dirEntry of dirEntries) {
    if (IGNORED.has(dirEntry.name)) {
      continue;
    }

    const relativePath = relativeDir ? `${relativeDir}/${dirEntry.name}` : dirEntry.name;

    if (dirEntry.isDirectory()) {
      files.push(...(await collectFiles(baseDir, relativePath)));
      continue;
    }

    if (!dirEntry.isFile()) {
      continue;
    }

    const absolutePath = path.join(baseDir, relativePath);
    const [content, stats] = await Promise.all([fs.readFile(absolutePath), fs.stat(absolutePath)]);
    files.push({ relativePath, content, mtime: stats.mtime });
  }

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

// Uma entrada do ZIP: comprime com deflate e, se nao encolher (PNG ja e
// comprimido), guarda cru.
async function buildEntry(name, content, mtime) {
  const deflated = content.length ? await deflateRaw(content, { level: 9 }) : Buffer.alloc(0);
  const useDeflate = deflated.length > 0 && deflated.length < content.length;

  return {
    nameBuffer: Buffer.from(name, "utf8"),
    method: useDeflate ? 8 : 0,
    payload: useDeflate ? deflated : content,
    crc: crc32(content),
    size: content.length,
    dosTime: toDosTime(mtime),
    dosDate: toDosDate(mtime)
  };
}

// Monta o arquivo final: cabecalho local + dados de cada entrada, diretorio
// central e o fim do diretorio central (EOCD).
function assembleZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // assinatura do cabecalho local
    local.writeUInt16LE(20, 4); // versao minima para extrair (2.0)
    local.writeUInt16LE(0x0800, 6); // flag: nome do arquivo em UTF-8
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(entry.dosTime, 10);
    local.writeUInt16LE(entry.dosDate, 12);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.payload.length, 18);
    local.writeUInt32LE(entry.size, 22);
    local.writeUInt16LE(entry.nameBuffer.length, 26);
    local.writeUInt16LE(0, 28); // sem campo extra

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // assinatura do diretorio central
    central.writeUInt16LE(20, 4); // versao de quem criou
    central.writeUInt16LE(20, 6); // versao minima para extrair
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(entry.dosTime, 12);
    central.writeUInt16LE(entry.dosDate, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.payload.length, 20);
    central.writeUInt32LE(entry.size, 24);
    central.writeUInt16LE(entry.nameBuffer.length, 28);
    central.writeUInt16LE(0, 30); // sem campo extra
    central.writeUInt16LE(0, 32); // sem comentario
    central.writeUInt16LE(0, 34); // disco 0
    central.writeUInt16LE(0, 36); // atributos internos
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // permissoes unix 644
    central.writeUInt32LE(offset, 42);

    locals.push(local, entry.nameBuffer, entry.payload);
    centrals.push(central, entry.nameBuffer);
    offset += local.length + entry.nameBuffer.length + entry.payload.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disco atual
  eocd.writeUInt16LE(0, 6); // disco do inicio do diretorio central
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // sem comentario

  return Buffer.concat([...locals, centralDirectory, eocd]);
}

// Data/hora no formato DOS, que e o que o ZIP guarda (segundos de 2 em 2).
function toDosTime(date) {
  return (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
}

function toDosDate(date) {
  const year = Math.max(date.getFullYear() - 1980, 0);
  return (year << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

module.exports = {
  buildExtensionZip,
  describeExtensionPackage
};
