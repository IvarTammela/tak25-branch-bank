import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import {
  ensureBankRegistration,
  refreshBankDirectory,
  refreshExchangeRates,
  sendHeartbeat
} from './central-bank.js';
import { processPendingTransfers } from './transfers.js';

const config = loadConfig();
const app = await buildApp(config);
const { db, keys } = app.state;

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ err: error }, 'Failed to start server');
  process.exitCode = 1;
}

const runWorkerCycle = async () => {
  try {
    await ensureBankRegistration(db, config, keys.publicKeyPem);
    await sendHeartbeat(db, config);
  } catch (error) {
    console.error('heartbeat cycle failed', (error as Error).message);
  }

  try {
    await refreshBankDirectory(db, config);
  } catch (error) {
    console.error('directory sync failed', (error as Error).message);
  }

  try {
    await refreshExchangeRates(db, config);
  } catch (error) {
    console.error('exchange rate sync failed', (error as Error).message);
  }

  try {
    await processPendingTransfers(db, config, keys);
  } catch (error) {
    console.error('pending transfer processing failed', (error as Error).message);
  }
};

await runWorkerCycle();

setInterval(async () => {
  try { await sendHeartbeat(db, config); } catch (error) { console.error('heartbeat failed', (error as Error).message); }
}, config.heartbeatIntervalMs);

setInterval(async () => {
  try { await refreshBankDirectory(db, config); } catch (error) { console.error('directory sync failed', (error as Error).message); }
}, config.directorySyncIntervalMs);

setInterval(async () => {
  try { await refreshExchangeRates(db, config); } catch (error) { console.error('exchange rates failed', (error as Error).message); }
}, config.directorySyncIntervalMs);

setInterval(async () => {
  try { await processPendingTransfers(db, config, keys); } catch (error) { console.error('pending transfers failed', (error as Error).message); }
}, config.retryPollIntervalMs);

console.log('Server + worker running');
