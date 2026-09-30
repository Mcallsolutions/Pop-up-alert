// Retencao do historico de coletas.
//
// Cada coleta grava de novo todos os tickets em atendimento (uma linha por
// ticket a cada minuto), entao sem limpeza o banco so cresce e os relatorios
// ficam mais lentos a cada semana. Aqui saem as leituras com mais de
// RETENTION_DAYS dias (padrao 90; 0 desliga).
//
// A limpeza roda depois de uma coleta gravada, no maximo uma vez a cada
// PURGE_INTERVAL_MS, e apaga em lotes: o node:sqlite e sincrono, e um DELETE de
// milhoes de linhas de uma vez so travaria a API inteira. O arquivo do banco
// nao encolhe; o espaco liberado e reaproveitado pelas coletas seguintes.

const { getRetentionDays } = require("../config/monitoring");
const { getDatabase } = require("../database");
const { toZonedIso } = require("./time-zone");

const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BATCH_SIZE = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

let nextPurgeAt = 0;

// Devolve null quando nao era hora (ou a retencao esta desligada).
async function purgeOldReadingsIfDue(now = new Date()) {
  const days = getRetentionDays();
  if (!days || now.getTime() < nextPurgeAt) {
    return null;
  }

  nextPurgeAt = now.getTime() + PURGE_INTERVAL_MS;
  const result = await purgeOldReadings({ days, now });

  if (result.tickets || result.snapshots) {
    console.log(
      `[DB] Retencao de ${days} dias: ${result.tickets} leituras de ticket e ${result.snapshots} coletas anteriores a ${result.cutoff} apagadas.`
    );
  }
  return result;
}

async function purgeOldReadings({ days, now = new Date() }) {
  const database = await getDatabase();
  // collected_at e hora local com offset ("2026-09-15T21:40:05-03:00"). O limite
  // vai no mesmo formato, sem o offset, e a comparacao de texto fica exata.
  const cutoff = toZonedIso(new Date(now.getTime() - days * DAY_MS)).slice(0, 19);

  const tickets = await deleteInBatches(database, "tickets", cutoff);
  // As leituras de ticket ja sairam: o ON DELETE CASCADE nao acha mais nada.
  const snapshots = await deleteInBatches(database, "snapshots", cutoff);

  return { cutoff, tickets, snapshots };
}

async function deleteInBatches(database, table, cutoff) {
  const statement = database.prepare(
    `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE collected_at < ? LIMIT ${BATCH_SIZE})`
  );
  let total = 0;

  for (;;) {
    const { changes } = await statement.run(cutoff);
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
