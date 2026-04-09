import path from 'node:path';
import Fastify from 'fastify';
import { ensureKeyPair } from '../shared/keys.js';
import { AppError, isAppError, toErrorBody } from '../shared/errors.js';
import { openDatabase, migrateDatabase, getIdentity, getCachedBankDirectory, getCachedExchangeRates, getBankById } from './db.js';
import { ensureBankRegistration, refreshBankDirectory, refreshExchangeRates, sendHeartbeat } from './central-bank.js';

const PORT = Number(process.env.CB_PORT ?? '8085');
const DB_PATH = path.resolve(process.env.CB_DB_PATH ?? './data/central-bank-service.db');
const KEY_DIR = path.resolve(process.env.KEY_DIR ?? './data/keys');
const BANK_NAME = process.env.BANK_NAME ?? 'TAK25 Branch Bank';
const BANK_ADDRESS = process.env.BANK_ADDRESS ?? 'http://localhost:8081';
const CENTRAL_BANK_BASE_URL = (process.env.CENTRAL_BANK_BASE_URL ?? 'https://test.diarainfra.com/central-bank/api/v1').replace(/\/+$/, '');
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? '600000');
const SYNC_MS = Number(process.env.DIRECTORY_SYNC_INTERVAL_MS ?? '300000');

const config = { centralBankBaseUrl: CENTRAL_BANK_BASE_URL, bankName: BANK_NAME, bankAddress: BANK_ADDRESS };
const keys = await ensureKeyPair(KEY_DIR);
const db = openDatabase(DB_PATH);
migrateDatabase(db, { name: BANK_NAME, address: BANK_ADDRESS, publicKey: keys.publicKeyPem });

const app = Fastify({ logger: true });

app.setErrorHandler((error, request, reply) => {
  if (isAppError(error)) {
    return reply.status(error.statusCode).send(toErrorBody(error));
  }
  request.log.error({ err: error }, 'Unhandled error');
  return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
});

app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try { done(null, body && (body as string).length > 0 ? JSON.parse(body as string) : {}); }
  catch (e) { done(e as Error, undefined); }
});

app.get('/health', async () => {
  const identity = getIdentity(db);
  return { status: 'ok', bankId: identity.bank_id, bankPrefix: identity.bank_prefix, address: identity.address };
});

app.post('/api/v1/sync', async () => {
  const directory = await refreshBankDirectory(db, config);
  const rates = await refreshExchangeRates(db, config);
  return {
    banks: directory.banks.map((b: any) => ({ bankId: b.bankId, name: b.name, address: b.address, status: b.status })),
    exchangeRates: rates.rates,
    syncedAt: directory.lastSyncedAt
  };
});

app.get('/api/v1/banks', async () => {
  const cached = await refreshBankDirectory(db, config);
  return {
    banks: cached.banks.map((b: any) => ({ bankId: b.bankId, name: b.name, address: b.address, status: b.status })),
    lastSyncedAt: cached.lastSyncedAt
  };
});

// Internal endpoints for other services
app.get('/internal/identity', async () => {
  const identity = getIdentity(db);
  return { bankId: identity.bank_id, bankPrefix: identity.bank_prefix, publicKey: identity.public_key, address: identity.address, name: identity.name };
});

app.get('/internal/bank-directory', async () => {
  const cached = getCachedBankDirectory(db);
  return cached ?? { banks: [], lastSyncedAt: null };
});

app.get('/internal/exchange-rates', async () => {
  const cached = getCachedExchangeRates(db);
  return cached ?? { baseCurrency: 'EUR', rates: {}, timestamp: null };
});

app.get('/internal/banks/:bankId', async (request) => {
  const { bankId } = request.params as { bankId: string };
  const bank = getBankById(db, bankId);
  if (!bank) throw new AppError(404, 'BANK_NOT_FOUND', `Bank ${bankId} not found`);
  return { bankId: bank.bank_id, name: bank.name, address: bank.address, publicKey: bank.public_key, status: bank.status };
});

await app.listen({ host: '0.0.0.0', port: PORT });

// Worker cycles
const runWorkerCycle = async () => {
  try { await ensureBankRegistration(db, config, keys.publicKeyPem); await sendHeartbeat(db, config); } catch (e) { console.error('heartbeat failed', (e as Error).message); }
  try { await refreshBankDirectory(db, config); } catch (e) { console.error('directory sync failed', (e as Error).message); }
  try { await refreshExchangeRates(db, config); } catch (e) { console.error('exchange rates failed', (e as Error).message); }
};

await runWorkerCycle();
setInterval(async () => { try { await sendHeartbeat(db, config); } catch (e) { console.error('heartbeat failed', (e as Error).message); } }, HEARTBEAT_MS);
setInterval(async () => { try { await refreshBankDirectory(db, config); } catch (e) { console.error('directory sync failed', (e as Error).message); } }, SYNC_MS);
setInterval(async () => { try { await refreshExchangeRates(db, config); } catch (e) { console.error('exchange rates failed', (e as Error).message); } }, SYNC_MS);

console.log(`Central Bank Service running on port ${PORT}`);
