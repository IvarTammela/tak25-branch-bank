import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Fastify from 'fastify';
import { z } from 'zod';
import { verifyAccessToken, signInterbankToken, verifyInterbankToken } from '../shared/auth.js';
import { ensureKeyPair } from '../shared/keys.js';
import { AppError, isAppError, toErrorBody } from '../shared/errors.js';
import { formatMoney, parseMoney, convertMoney, type ExchangeRateSnapshot } from '../shared/money.js';
import { openDatabase, migrateDatabase, insertTransfer, getTransferById, listTransfersByUser, listDuePendingTransfers, markTransferCompleted, markTransferFailed, markTransferTimedOut, scheduleTransferRetry, type TransferRow } from './db.js';

const PORT = Number(process.env.TRANSFER_PORT ?? '8084');
const DB_PATH = path.resolve(process.env.TRANSFER_DB_PATH ?? './data/transfer-service.db');
const KEY_DIR = path.resolve(process.env.KEY_DIR ?? './data/keys');
const BANK_NAME = process.env.BANK_NAME ?? 'TAK25 Branch Bank';
const RETRY_MS = Number(process.env.RETRY_POLL_INTERVAL_MS ?? '15000');
const ACCOUNT_SERVICE = process.env.ACCOUNT_SERVICE_URL ?? 'http://localhost:8083';
const CB_SERVICE = process.env.CB_SERVICE_URL ?? 'http://localhost:8085';

const keys = await ensureKeyPair(KEY_DIR);
const db = openDatabase(DB_PATH);
migrateDatabase(db);

const app = Fastify({ logger: true });

app.addContentTypeParser('application/json', { parseAs: 'string' }, (req: any, body: any, done: any) => {
  try { done(null, body && (body as string).length > 0 ? JSON.parse(body as string) : {}); }
  catch (e: any) { done(e, undefined); }
});

app.setErrorHandler((error, request, reply) => {
  if (error instanceof z.ZodError) return reply.status(400).send({ code: 'INVALID_REQUEST', message: error.issues[0]?.message ?? 'Invalid' });
  if (isAppError(error)) return reply.status(error.statusCode).send(toErrorBody(error));
  request.log.error({ err: error }, 'Unhandled error');
  return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
});

const authenticateUser = async (request: any) => {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new AppError(401, 'UNAUTHORIZED', 'Authentication is required');
  return verifyAccessToken(keys.publicKeyPem, BANK_NAME, header.slice(7));
};

// Service calls
const accountService = async (path: string, opts?: RequestInit) => {
  const res = await fetch(`${ACCOUNT_SERVICE}${path}`, opts);
  const data = await res.json() as any;
  if (!res.ok) throw new AppError(res.status, data?.code ?? 'SERVICE_ERROR', data?.message ?? 'Account service error');
  return data;
};

const getIdentity = async () => (await fetch(`${CB_SERVICE}/internal/identity`).then(r => r.json())) as { bankId: string; bankPrefix: string };
const getBankDirectory = async () => (await fetch(`${CB_SERVICE}/internal/bank-directory`).then(r => r.json())) as { banks: any[]; lastSyncedAt: string };
const getExchangeRates = async () => (await fetch(`${CB_SERVICE}/internal/exchange-rates`).then(r => r.json())) as ExchangeRateSnapshot;
const getBankById = async (bankId: string) => { const r = await fetch(`${CB_SERVICE}/internal/banks/${bankId}`); if (!r.ok) return null; return r.json() as Promise<any>; };

const buildTransferResponse = (t: TransferRow) => ({
  transferId: t.transfer_id, status: t.status, sourceAccount: t.source_account, destinationAccount: t.destination_account,
  amount: formatMoney(t.amount_minor),
  convertedAmount: t.converted_amount_minor !== null ? formatMoney(t.converted_amount_minor) : undefined,
  exchangeRate: t.exchange_rate ?? undefined, rateCapturedAt: t.rate_captured_at ?? undefined,
  pendingSince: t.pending_since ?? undefined, nextRetryAt: t.next_retry_at ?? undefined,
  retryCount: t.status === 'pending' ? t.retry_count : undefined,
  timestamp: t.updated_at, createdAt: t.created_at, errorMessage: t.error_message ?? undefined
});

const getBankBases = (address: string) => {
  const n = address.replace(/\/+$/, '');
  // Try with /api/v1 first (most common), then without (e.g. OLL bank)
  return n.endsWith('/api/v1') ? [n] : [`${n}/api/v1`, n];
};

// POST /transfers
app.post('/api/v1/transfers', async (request, reply) => {
  const userId = await authenticateUser(request);
  const parsed = z.object({ transferId: z.string().uuid(), sourceAccount: z.string().regex(/^[A-Z0-9]{8}$/), destinationAccount: z.string().regex(/^[A-Z0-9]{8}$/), amount: z.string().regex(/^\d+\.\d{2}$/) }).safeParse(request.body);
  if (!parsed.success) throw new AppError(400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid');
  const input = parsed.data;

  if (input.sourceAccount === input.destinationAccount) throw new AppError(400, 'INVALID_REQUEST', 'Source and destination accounts must be different');

  const existing = getTransferById(db, input.transferId);
  if (existing) {
    if (existing.status === 'pending') throw new AppError(409, 'TRANSFER_ALREADY_PENDING', `Transfer with ID '${input.transferId}' is already pending`);
    throw new AppError(409, 'DUPLICATE_TRANSFER', `A transfer with ID '${input.transferId}' already exists`);
  }

  const amountMinor = parseMoney(input.amount);
  const sourceAccount = await accountService(`/internal/accounts/${input.sourceAccount}`);
  if (sourceAccount.ownerId !== userId) throw new AppError(403, 'FORBIDDEN', 'You can only initiate transfers from your own accounts');
  if (sourceAccount.balanceMinor < amountMinor) throw new AppError(422, 'INSUFFICIENT_FUNDS', 'Insufficient funds in source account');

  const identity = await getIdentity();
  if (!identity.bankPrefix || !identity.bankId) throw new AppError(503, 'BANK_NOT_REGISTERED', 'Bank not registered yet');
  if (!input.sourceAccount.startsWith(identity.bankPrefix)) throw new AppError(400, 'INVALID_REQUEST', 'Source account must belong to this bank');

  const now = new Date().toISOString();

  // Check if destination is local
  let localDest: any = null;
  try { localDest = await accountService(`/internal/accounts/${input.destinationAccount}`); } catch {}

  if (localDest) {
    // Same-bank transfer
    const rates = sourceAccount.currency !== localDest.currency ? await getExchangeRates() : null;
    const conversion = rates ? convertMoney(amountMinor, sourceAccount.currency, localDest.currency, rates) : { convertedMinor: amountMinor, exchangeRate: '1.000000' };

    const transfer: TransferRow = {
      transfer_id: input.transferId, direction: 'outgoing', status: 'completed',
      source_account: input.sourceAccount, destination_account: input.destinationAccount,
      amount_minor: amountMinor, amount_currency: sourceAccount.currency,
      source_currency: sourceAccount.currency, destination_currency: localDest.currency,
      converted_amount_minor: sourceAccount.currency === localDest.currency ? null : conversion.convertedMinor,
      exchange_rate: sourceAccount.currency === localDest.currency ? null : conversion.exchangeRate,
      rate_captured_at: sourceAccount.currency === localDest.currency ? null : (rates?.timestamp ?? null),
      error_message: null, initiated_by_user_id: userId, pending_since: null, next_retry_at: null,
      retry_count: 0, source_bank_id: identity.bankId, destination_bank_id: identity.bankId,
      created_at: now, updated_at: now, locked_amount_minor: amountMinor
    };

    // Debit source, credit destination via Account Service
    await accountService(`/internal/accounts/${input.sourceAccount}/adjust`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deltaMinor: -amountMinor }) });
    try {
      await accountService(`/internal/accounts/${input.destinationAccount}/adjust`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deltaMinor: conversion.convertedMinor }) });
    } catch (e) {
      // Refund source on failure
      await accountService(`/internal/accounts/${input.sourceAccount}/adjust`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deltaMinor: amountMinor }) });
      throw e;
    }
    insertTransfer(db, transfer);
    return reply.status(201).send(buildTransferResponse(getTransferById(db, input.transferId)!));
  }

  // Cross-bank transfer
  const directory = await getBankDirectory();
  const prefix = input.destinationAccount.slice(0, 3);
  let candidates = directory.banks.filter((b: any) => b.bank_id.startsWith(prefix) && b.bank_id !== identity.bankId);
  // If no bank matches by prefix, try all other banks (prefix may differ from bankId)
  if (candidates.length === 0) {
    candidates = directory.banks.filter((b: any) => b.bank_id !== identity.bankId);
  }
  if (candidates.length === 0) throw new AppError(404, 'BANK_NOT_FOUND', `No bank for prefix '${prefix}'`);

  let destBank: any = null;
  let remoteAccount: any = null;
  let destBankBase: string | null = null;
  for (const c of candidates) {
    for (const base of getBankBases(c.address)) {
      try {
        const res = await fetch(`${base}/accounts/${input.destinationAccount}`);
        if (res.ok) { remoteAccount = await res.json(); destBank = c; destBankBase = base; break; }
      } catch {}
    }
    if (destBank) break;
  }
  if (!destBank || !remoteAccount) throw new AppError(404, 'ACCOUNT_NOT_FOUND', `Account '${input.destinationAccount}' not found on any remote bank`);

  const rates = sourceAccount.currency !== remoteAccount.currency ? await getExchangeRates() : null;
  const conversion = rates ? convertMoney(amountMinor, sourceAccount.currency, remoteAccount.currency, rates) : { convertedMinor: amountMinor, exchangeRate: '1.000000' };

  const pendingTransfer: TransferRow = {
    transfer_id: input.transferId, direction: 'outgoing', status: 'pending',
    source_account: input.sourceAccount, destination_account: input.destinationAccount,
    amount_minor: amountMinor, amount_currency: sourceAccount.currency,
    source_currency: sourceAccount.currency, destination_currency: remoteAccount.currency,
    converted_amount_minor: sourceAccount.currency === remoteAccount.currency ? null : conversion.convertedMinor,
    exchange_rate: sourceAccount.currency === remoteAccount.currency ? null : conversion.exchangeRate,
    rate_captured_at: rates?.timestamp ?? null,
    error_message: null, initiated_by_user_id: userId, pending_since: now,
    next_retry_at: new Date(Date.now() + 60000).toISOString(), retry_count: 0,
    source_bank_id: identity.bankId, destination_bank_id: destBank.bank_id,
    created_at: now, updated_at: now, locked_amount_minor: amountMinor
  };

  // Debit source
  await accountService(`/internal/accounts/${input.sourceAccount}/adjust`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deltaMinor: -amountMinor }) });
  insertTransfer(db, pendingTransfer);

  // Try immediate delivery
  try {
    const jwt = await signInterbankToken(keys.privateKeyPem, {
      transferId: input.transferId, sourceAccount: input.sourceAccount, destinationAccount: input.destinationAccount,
      amount: formatMoney(conversion.convertedMinor), sourceAmount: formatMoney(amountMinor),
      sourceBankId: identity.bankId, destinationBankId: destBank.bank_id,
      sourceCurrency: sourceAccount.currency, destinationCurrency: remoteAccount.currency,
      exchangeRate: conversion.exchangeRate, rateCapturedAt: rates?.timestamp,
      timestamp: now, nonce: randomUUID()
    });
    const res = await fetch(`${destBankBase}/transfers/receive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jwt }) });
    if (res.ok) {
      markTransferCompleted(db, input.transferId, new Date().toISOString());
      return reply.status(201).send(buildTransferResponse(getTransferById(db, input.transferId)!));
    }
  } catch {}

  return reply.status(201).send(buildTransferResponse(getTransferById(db, input.transferId)!));
});

// POST /transfers/receive
app.post('/api/v1/transfers/receive', async (request) => {
  const parsed = z.object({ jwt: z.string().min(1) }).safeParse(request.body);
  if (!parsed.success) throw new AppError(401, 'UNAUTHORIZED', 'JWT is required');

  const [, payloadSeg] = parsed.data.jwt.split('.');
  if (!payloadSeg) throw new AppError(401, 'UNAUTHORIZED', 'Malformed inter-bank token');
  let payload: any;
  try { payload = JSON.parse(Buffer.from(payloadSeg, 'base64url').toString('utf8')); } catch { throw new AppError(401, 'UNAUTHORIZED', 'Malformed inter-bank token'); }

  const sourceBankId = payload.sourceBankId;
  if (!sourceBankId) throw new AppError(401, 'UNAUTHORIZED', 'Missing sourceBankId');

  const sourceBank = await getBankById(sourceBankId);
  if (!sourceBank) {
    // Try refreshing directory
    await fetch(`${CB_SERVICE}/api/v1/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
    const retryBank = await getBankById(sourceBankId);
    if (!retryBank) throw new AppError(403, 'FORBIDDEN', `Source bank '${sourceBankId}' is not registered`);
    Object.assign(sourceBank ?? {}, retryBank);
  }

  const bank = sourceBank!;
  const claims = await verifyInterbankToken(bank.publicKey, parsed.data.jwt);
  const identity = await getIdentity();
  if (!identity.bankId || claims.destinationBankId !== identity.bankId) throw new AppError(403, 'FORBIDDEN', 'Transfer not intended for this bank');

  if (!/^[A-Z0-9]{8}$/.test(claims.destinationAccount)) throw new AppError(400, 'INVALID_ACCOUNT_NUMBER', 'Invalid destination account');

  const destAccount = await accountService(`/internal/accounts/${claims.destinationAccount}`);
  const existing = getTransferById(db, claims.transferId);
  if (existing) return { transferId: existing.transfer_id, status: existing.status, destinationAccount: existing.destination_account, amount: formatMoney(existing.amount_minor), timestamp: existing.updated_at };

  const creditedMinor = parseMoney(claims.amount);
  const now = new Date().toISOString();

  await accountService(`/internal/accounts/${claims.destinationAccount}/adjust`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deltaMinor: creditedMinor }) });
  insertTransfer(db, {
    transfer_id: claims.transferId, direction: 'incoming', status: 'completed',
    source_account: claims.sourceAccount, destination_account: claims.destinationAccount,
    amount_minor: creditedMinor, amount_currency: destAccount.currency,
    source_currency: claims.sourceCurrency ?? null, destination_currency: claims.destinationCurrency ?? destAccount.currency,
    converted_amount_minor: null, exchange_rate: claims.exchangeRate ?? null,
    rate_captured_at: claims.rateCapturedAt ?? null, error_message: null,
    initiated_by_user_id: null, pending_since: null, next_retry_at: null, retry_count: 0,
    source_bank_id: claims.sourceBankId, destination_bank_id: claims.destinationBankId,
    created_at: now, updated_at: now, locked_amount_minor: 0
  });

  return { transferId: claims.transferId, status: 'completed', destinationAccount: claims.destinationAccount, amount: formatMoney(creditedMinor), timestamp: now };
});

// GET /transfers/:transferId
app.get('/api/v1/transfers/:transferId', async (request) => {
  const userId = await authenticateUser(request);
  const params = z.object({ transferId: z.string().uuid() }).parse(request.params);
  const transfer = getTransferById(db, params.transferId);
  if (!transfer) throw new AppError(404, 'TRANSFER_NOT_FOUND', `Transfer '${params.transferId}' not found`);
  if (transfer.initiated_by_user_id !== userId) {
    const userAccounts = await accountService(`/internal/accounts/by-owner/${userId}`) as { accounts: { accountNumber: string }[] };
    if (!userAccounts.accounts.some(a => a.accountNumber === transfer.destination_account))
      throw new AppError(403, 'FORBIDDEN', 'Not your transfer');
  }
  return buildTransferResponse(transfer);
});

// GET /users/:userId/transfers
app.get('/api/v1/users/:userId/transfers', async (request) => {
  const userId = await authenticateUser(request);
  const params = z.object({ userId: z.string() }).parse(request.params);
  if (userId !== params.userId) throw new AppError(403, 'FORBIDDEN', 'You can only view your own transfers');
  const userAccounts = await accountService(`/internal/accounts/by-owner/${params.userId}`) as { accounts: { accountNumber: string }[] };
  const accountNumbers = userAccounts.accounts.map(a => a.accountNumber);
  return { transfers: listTransfersByUser(db, params.userId, accountNumbers).map(t => ({ ...buildTransferResponse(t), direction: t.direction, currency: t.amount_currency })) };
});

await app.listen({ host: '0.0.0.0', port: PORT });

// Pending transfer retry worker
setInterval(async () => {
  try {
    const now = new Date().toISOString();
    const due = listDuePendingTransfers(db, now);
    for (const t of due) {
      if (t.pending_since && (new Date(now).getTime() - new Date(t.pending_since).getTime() >= 4 * 3600000)) {
        await accountService(`/internal/accounts/${t.source_account}/adjust`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deltaMinor: t.locked_amount_minor }) });
        markTransferTimedOut(db, t.transfer_id, now, 'Transfer timed out after 4 hours. Funds refunded.');
        continue;
      }
      try {
        const identity = await getIdentity();
        const bank = await getBankById(t.destination_bank_id ?? '');
        if (!bank) continue;
        const jwt = await signInterbankToken(keys.privateKeyPem, {
          transferId: t.transfer_id, sourceAccount: t.source_account, destinationAccount: t.destination_account,
          amount: formatMoney(t.converted_amount_minor ?? t.amount_minor), sourceAmount: formatMoney(t.amount_minor),
          sourceBankId: identity.bankId, destinationBankId: t.destination_bank_id ?? '',
          sourceCurrency: t.source_currency ?? t.amount_currency, destinationCurrency: t.destination_currency ?? t.amount_currency,
          exchangeRate: t.exchange_rate ?? undefined, rateCapturedAt: t.rate_captured_at ?? undefined,
          timestamp: t.created_at, nonce: randomUUID()
        });
        let deliveredBase: string | null = null;
        for (const base of getBankBases(bank.address)) {
          try {
            const res = await fetch(`${base}/transfers/receive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jwt }) });
            if (res.ok) { deliveredBase = base; break; }
          } catch {}
        }
        if (deliveredBase) {
          markTransferCompleted(db, t.transfer_id, new Date().toISOString());
          continue;
        }
        const retryCount = t.retry_count + 1;
        const delay = Math.min(60, 2 ** retryCount) * 60000;
        scheduleTransferRetry(db, t.transfer_id, new Date().toISOString(), new Date(Date.now() + delay).toISOString(), retryCount);
      } catch (e) {
        const retryCount = t.retry_count + 1;
        const delay = Math.min(60, 2 ** retryCount) * 60000;
        scheduleTransferRetry(db, t.transfer_id, new Date().toISOString(), new Date(Date.now() + delay).toISOString(), retryCount);
      }
    }
  } catch (e) { console.error('pending transfers failed', (e as Error).message); }
}, RETRY_MS);

console.log(`Transfer Service running on port ${PORT}`);
