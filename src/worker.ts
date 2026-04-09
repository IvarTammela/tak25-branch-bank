import { loadConfig } from './config.js';
import { ensureBankRegistration, refreshBankDirectory, refreshExchangeRates, sendHeartbeat } from './central-bank.js';
import { getIdentity, migrateDatabase, openDatabase } from './db.js';
import { ensureKeyPair } from './keys.js';
import { processPendingTransfers } from './transfers.js';

const config = loadConfig();
const keys = await ensureKeyPair(config.keyDir);
const db = openDatabase(config.dbPath);

migrateDatabase(db, {
  name: config.bankName,
  address: config.bankAddress,
  publicKey: keys.publicKeyPem
});

const runCycle = async () => {
  try {
    await ensureBankRegistration(db, config, keys.publicKeyPem);
    await sendHeartbeat(db, config);
  } catch (error) {
    console.error('heartbeat cycle failed', error);
  }

  try {
    await refreshBankDirectory(db, config);
  } catch (error) {
    console.error('directory sync failed', error);
  }

  try {
    await refreshExchangeRates(db, config);
  } catch (error) {
    console.error('exchange rate sync failed', error);
  }

  try {
    await processPendingTransfers(db, config, keys);
  } catch (error) {
    console.error('pending transfer processing failed', error);
  }
};

await runCycle();

setInterval(async () => {
  try {
    await sendHeartbeat(db, config);
  } catch (error) {
    console.error('heartbeat interval failed', error);
  }
}, config.heartbeatIntervalMs);

setInterval(async () => {
  try {
    await refreshBankDirectory(db, config);
  } catch (error) {
    console.error('directory interval failed', error);
  }
}, config.directorySyncIntervalMs);

setInterval(async () => {
  try {
    await refreshExchangeRates(db, config);
  } catch (error) {
    console.error('rates interval failed', error);
  }
}, config.directorySyncIntervalMs);

setInterval(async () => {
  try {
    await processPendingTransfers(db, config, keys);
  } catch (error) {
    console.error('retry interval failed', error);
  }
}, config.retryPollIntervalMs);

const identity = getIdentity(db);
console.log(`worker ready for ${identity.name} (${identity.bank_id ?? 'pending registration'})`);
