import { randomBytes } from 'node:crypto';
import path from 'node:path';
import Fastify from 'fastify';
import { z } from 'zod';
import { verifyAccessToken } from '../shared/auth.js';
import { ensureKeyPair } from '../shared/keys.js';
import { AppError, isAppError, toErrorBody } from '../shared/errors.js';
import { formatMoney, parseMoney } from '../shared/money.js';
import { openDatabase, migrateDatabase, createAccount, getAccountByNumber, listAccountsByOwner, listAllAccounts, adjustAccountBalance } from './db.js';

const PORT = Number(process.env.ACCOUNT_PORT ?? '8083');
const DB_PATH = path.resolve(process.env.ACCOUNT_DB_PATH ?? './data/account-service.db');
const KEY_DIR = path.resolve(process.env.KEY_DIR ?? './data/keys');
const BANK_NAME = process.env.BANK_NAME ?? 'TAK25 Branch Bank';
const SUPPORTED_CURRENCIES = (process.env.SUPPORTED_CURRENCIES ?? 'EUR,USD,GBP,SEK').split(',').map(c => c.trim().toUpperCase());
const CB_SERVICE = process.env.CB_SERVICE_URL ?? 'http://localhost:8085';
const USER_SERVICE = process.env.USER_SERVICE_URL ?? 'http://localhost:8082';

const keys = await ensureKeyPair(KEY_DIR);
const db = openDatabase(DB_PATH);
migrateDatabase(db);

const app = Fastify({ logger: true });

app.addContentTypeParser('application/json', { parseAs: 'string' }, (req: any, body: any, done: any) => {
  try { done(null, body && (body as string).length > 0 ? JSON.parse(body as string) : {}); }
  catch (e: any) { done(e, undefined); }
});

app.setErrorHandler((error, request, reply) => {
  if (error instanceof z.ZodError) return reply.status(400).send({ code: 'INVALID_REQUEST', message: error.issues[0]?.message ?? 'Invalid request' });
  if (isAppError(error)) return reply.status(error.statusCode).send(toErrorBody(error));
  request.log.error({ err: error }, 'Unhandled error');
  return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
});

const authenticateUser = async (request: any) => {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new AppError(401, 'UNAUTHORIZED', 'Authentication is required');
  return verifyAccessToken(keys.publicKeyPem, BANK_NAME, header.slice(7));
};

const getIdentity = async () => {
  const res = await fetch(`${CB_SERVICE}/internal/identity`);
  return res.json() as Promise<{ bankId: string; bankPrefix: string }>;
};

const getUserName = async (userId: string) => {
  try {
    const res = await fetch(`${USER_SERVICE}/internal/users/${userId}`);
    if (res.ok) { const data = await res.json() as { fullName: string }; return data.fullName; }
  } catch {}
  return userId;
};

const accountAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const generateAccountNumber = (prefix: string) => {
  for (let i = 0; i < 50; i++) {
    const suffix = Array.from(randomBytes(5), v => accountAlphabet[v % accountAlphabet.length]).join('');
    const num = `${prefix}${suffix}`;
    if (!getAccountByNumber(db, num)) return num;
  }
  throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Could not generate unique account number');
};

// Public endpoints
app.get('/api/v1/users/:userId/accounts', async (request) => {
  const userId = await authenticateUser(request);
  const params = z.object({ userId: z.string() }).parse(request.params);
  if (userId !== params.userId) throw new AppError(403, 'FORBIDDEN', 'You can only access your own accounts');
  return { userId: params.userId, accounts: listAccountsByOwner(db, params.userId).map(a => ({ accountNumber: a.account_number, currency: a.currency, balance: formatMoney(a.balance_minor), createdAt: a.created_at })) };
});

app.post('/api/v1/users/:userId/accounts', async (request, reply) => {
  const userId = await authenticateUser(request);
  const params = z.object({ userId: z.string() }).parse(request.params);
  if (userId !== params.userId) throw new AppError(403, 'FORBIDDEN', 'You can only create accounts for your own user');
  const body = z.object({ currency: z.string().regex(/^[A-Z]{3}$/) }).safeParse(request.body);
  if (!body.success) throw new AppError(400, 'INVALID_REQUEST', body.error.issues[0]?.message ?? 'Invalid');
  if (!SUPPORTED_CURRENCIES.includes(body.data.currency)) throw new AppError(400, 'UNSUPPORTED_CURRENCY', `Currency '${body.data.currency}' is not supported`);
  const identity = await getIdentity();
  if (!identity.bankPrefix) throw new AppError(503, 'BANK_NOT_REGISTERED', 'Bank not registered yet');
  const accountNumber = generateAccountNumber(identity.bankPrefix);
  const createdAt = new Date().toISOString();
  createAccount(db, { account_number: accountNumber, owner_id: params.userId, currency: body.data.currency, balance_minor: 10000, created_at: createdAt });
  return reply.status(201).send({ accountNumber, ownerId: params.userId, currency: body.data.currency, balance: '100.00', createdAt });
});

app.get('/api/v1/accounts', async () => {
  const accounts = listAllAccounts(db);
  const result = [];
  for (const a of accounts) {
    const ownerName = await getUserName(a.owner_id);
    result.push({ accountNumber: a.account_number, ownerName, currency: a.currency, balance: formatMoney(a.balance_minor), createdAt: a.created_at });
  }
  return { accounts: result };
});

app.get('/api/v1/accounts/:accountNumber', async (request) => {
  const raw = z.object({ accountNumber: z.string() }).parse(request.params);
  if (!/^[A-Z0-9]{8}$/.test(raw.accountNumber)) throw new AppError(400, 'INVALID_ACCOUNT_NUMBER', 'Account number must be exactly 8 characters');
  const account = getAccountByNumber(db, raw.accountNumber);
  if (!account) throw new AppError(404, 'ACCOUNT_NOT_FOUND', `Account with number '${raw.accountNumber}' not found`);
  const ownerName = await getUserName(account.owner_id);
  return { accountNumber: account.account_number, ownerName, currency: account.currency };
});

app.post('/api/v1/accounts/:accountNumber/deposit', async (request, reply) => {
  const userId = await authenticateUser(request);
  const params = z.object({ accountNumber: z.string().regex(/^[A-Z0-9]{8}$/) }).parse(request.params);
  const body = z.object({ amount: z.string().regex(/^\d+\.\d{2}$/) }).parse(request.body);
  const account = getAccountByNumber(db, params.accountNumber);
  if (!account) throw new AppError(404, 'ACCOUNT_NOT_FOUND', `Account not found`);
  if (account.owner_id !== userId) throw new AppError(403, 'FORBIDDEN', 'You can only deposit to your own accounts');
  const amountMinor = parseMoney(body.amount);
  adjustAccountBalance(db, account.account_number, amountMinor);
  const updated = getAccountByNumber(db, account.account_number)!;
  return reply.status(200).send({ accountNumber: updated.account_number, balance: formatMoney(updated.balance_minor) });
});

// Internal endpoints for Transfer Service
app.get('/internal/accounts/:accountNumber', async (request) => {
  const { accountNumber } = request.params as { accountNumber: string };
  const account = getAccountByNumber(db, accountNumber);
  if (!account) throw new AppError(404, 'ACCOUNT_NOT_FOUND', `Account ${accountNumber} not found`);
  return { accountNumber: account.account_number, ownerId: account.owner_id, currency: account.currency, balanceMinor: account.balance_minor };
});

app.post('/internal/accounts/:accountNumber/adjust', async (request) => {
  const { accountNumber } = request.params as { accountNumber: string };
  const { deltaMinor } = request.body as { deltaMinor: number };
  const account = getAccountByNumber(db, accountNumber);
  if (!account) throw new AppError(404, 'ACCOUNT_NOT_FOUND', `Account ${accountNumber} not found`);
  adjustAccountBalance(db, accountNumber, deltaMinor);
  const updated = getAccountByNumber(db, accountNumber)!;
  return { accountNumber: updated.account_number, balanceMinor: updated.balance_minor };
});

app.get('/internal/accounts/by-owner/:ownerId', async (request) => {
  const { ownerId } = request.params as { ownerId: string };
  return { accounts: listAccountsByOwner(db, ownerId).map(a => ({ accountNumber: a.account_number, currency: a.currency, balanceMinor: a.balance_minor })) };
});

await app.listen({ host: '0.0.0.0', port: PORT });
console.log(`Account Service running on port ${PORT}`);
