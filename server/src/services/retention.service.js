// Retencao do historico de coletas e da analise de atendimento.
//
// Cada coleta grava de novo todos os tickets em atendimento (uma linha por
// ticket a cada minuto), entao sem limpeza o banco so cresce e os relatorios
// ficam mais lentos a cada semana. Aqui saem:
// - as leituras de ticket, as coletas e as analises de atendimento com mais de
//   RETENTION_DAYS dias (padrao 90; 0 desliga essa parte);
// - as mensagens mascaradas e os cursores de leitura com mais de
//   MESSAGE_RETENTION_DAYS dias (padrao 30). Mensagem e o dado mais sensivel do
//   banco: essa limpeza nao tem como ser desligada.
//
// A limpeza roda depois de uma coleta gravada, no maximo uma vez a cada
// PURGE_INTERVAL_MS, e apaga em lotes: o node:sqlite e sincrono, e um DELETE de
// milhoes de linhas de uma vez so travaria a API inteira. O arquivo do banco
// nao encolhe; o espaco liberado e reaproveitado pelas coletas seguintes.

const { getAttendanceConfig, getRetentionDays } = require("../config/monitoring");
const { getDatabase } = require("../database");
const { toZonedIso } = require("./time-zone");

const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BATCH_SIZE = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

let nextPurgeAt = 0;

// Devolve null quando nao era hora.
async function purgeOldReadingsIfDue(now = new Date()) {
  if (now.getTime() < nextPurgeAt) {
    return null;
  }

  nextPurgeAt = now.getTime() + PURGE_INTERVAL_MS;
  const days = getRetentionDays();
  const messageDays = getAttendanceConfig().messageRetentionDays;
  const result = await purgeOldReadings({ days, messageDays, now });

  if (result.tickets || result.snapshots || result.analyses) {
    console.log(
      `[DB] Retencao de ${days} dias: ${result.tickets} leituras de ticket, ${result.snapshots} coletas e ${result.analyses} analises de atendimento anteriores a ${result.cutoff} apagadas.`
    );
  }
  if (result.messages || result.messageSync) {
    console.log(
      `[DB] Retencao de mensagens (${messageDays} dias): ${result.messages} mensagens e ${result.messageSync} cursores anteriores a ${result.messageCutoff} apagados.`
    );
  }
  return result;
}

async function purgeOldReadings({ days, messageDays = getAttendanceConfig().messageRetentionDays, now = new Date() }) {
  const database = await getDatabase();
  const result = { cutoff: null, tickets: 0, snapshots: 0, analyses: 0, messageCutoff: null, messages: 0, messageSync: 0 };

  // As datas sao gravadas na hora local com offset ("2026-09-15T21:40:05-03:00").
  // O limite vai no mesmo formato, sem o offset, e a comparacao de texto fica
  // exata.
  if (days) {
    result.cutoff = toZonedIso(new Date(now.getTime() - days * DAY_MS)).slice(0, 19);
    result.tickets = await deleteInBatches(database, { table: "tickets", column: "collected_at", cutoff: result.cutoff });
    // As leituras de ticket ja sairam: o ON DELETE CASCADE nao acha mais nada.
    result.snapshots = await deleteInBatches(database, { table: "snapshots", column: "collected_at", cutoff: result.cutoff });
    result.analyses = await deleteInBatches(database, {
      table: "attendance_analyses",
      column: "created_at",
      cutoff: result.cutoff
    });
  }

  if (messageDays) {
    result.messageCutoff = toZonedIso(new Date(now.getTime() - messageDays * DAY_MS)).slice(0, 19);
    result.messages = await deleteInBatches(database, { table: "messages", column: "created_at", cutoff: result.messageCutoff });
    // Cursor de ticket que nao aparece na listagem ha tanto tempo nao serve mais.
    result.messageSync = await deleteInBatches(database, {
      table: "message_sync",
      key: "ticket_id",
      column: "last_seen_at",
      cutoff: result.messageCutoff,
      includeNull: true
    });
  }

  return result;
}

// includeNull: cursor criado pela analise manual de um ticket ja fechado nunca
// ganha last_seen_at; sai junto com os velhos pela data da ultima mensagem.
async function deleteInBatches(database, { table, key = "id", column, cutoff, includeNull = false }) {
  const where = includeNull
    ? `(${column} < ? OR (${column} IS NULL AND COALESCE(closed_at, '') < ?))`
    : `${column} < ?`;
  const params = includeNull ? [cutoff, cutoff] : [cutoff];
  const statement = database.prepare(
    `DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE ${where} LIMIT ${BATCH_SIZE})`
  );
  let total = 0;

  for (;;) {
    const { changes } = await statement.run(...params);
    total += changes;
    if (changes < BATCH_SIZE) {
      return total;
    }
    // Devolve a vez para as requisicoes entre um lote e o seguinte.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

module.exports = {
  purgeOldReadings,
  purgeOldReadingsIfDue
};
