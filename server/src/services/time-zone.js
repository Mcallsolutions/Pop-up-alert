// Datas no fuso da operacao (MONITOR_TIME_ZONE, padrao America/Sao_Paulo).
//
// collected_at e gravado como "2026-09-15T21:40:05-03:00": hora local com o
// offset. Os relatorios filtram o dia por substr(collected_at, 1, 10), entao a
// data gravada precisa ser a do fuso da operacao — em UTC, uma coleta das 21h
// cairia no dia seguinte.

const { getTimeZone } = require("../config/monitoring");

function readParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  return Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
}

function toZonedIso(date = new Date(), timeZone = getTimeZone()) {
  const parts = readParts(date, timeZone);
  const local = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMinutes = Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);

  return `${local}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// "08:15" no fuso da operacao, como o painel do MTalk mostra.
function formatTime(date, timeZone = getTimeZone()) {
  if (!date) return "";
  const parts = readParts(date, timeZone);
  return `${parts.hour}:${parts.minute}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

module.exports = {
  formatTime,
  toZonedIso
};
