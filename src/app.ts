import { randomBytes, randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { z } from 'zod';

import { createApiKey, hashApiKey, issueAccessToken, verifyAccessToken } from './auth.js';
import type { AppConfig } from './config.js';
import {
  adjustAccountBalance,
  createAccount,
  createUser,
  getAccountByNumber,
  getIdentity,
  getTransferById,
  getUserByEmail,
  getUserById,
  listAccountsByOwner,
  listAllAccounts,
  listTransfersByUser,
  migrateDatabase,
  openDatabase,
  type SqliteDatabase
} from './db.js';
import { AppError, isAppError, toErrorBody } from './errors.js';
import type { KeyPair } from './keys.js';
import { ensureKeyPair } from './keys.js';
import { formatMoney, parseMoney } from './money.js';
import { refreshBankDirectory, refreshExchangeRates } from './central-bank.js';
import { createTransfer, getTransferStatus, receiveTransfer } from './transfers.js';
import { html as uiHtml } from './ui.js';

const registrationSchema = z.object({
  fullName: z.string().trim().min(2).max(200),
  email: z.string().email().max(255).optional()
});

const tokenSchema = z.object({
  userId: z.string().regex(/^user-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  apiKey: z.string().min(16)
});

const accountSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/)
});

const transferSchema = z.object({
  transferId: z.string().uuid(),
  sourceAccount: z.string().regex(/^[A-Z0-9]{8}$/),
  destinationAccount: z.string().regex(/^[A-Z0-9]{8}$/),
  amount: z.string().regex(/^\d+\.\d{2}$/)
});

const receiveTransferSchema = z.object({
  jwt: z.string().min(20)
});

const accountAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const makeErrorFromZod = (message: string) => new AppError(400, 'INVALID_REQUEST', message);

const getBearerToken = (request: FastifyRequest) => {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication is required');
  }

  return header.slice('Bearer '.length);
};

const generateAccountNumber = (db: SqliteDatabase, prefix: string) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const suffix = Array.from(randomBytes(5), (value) => accountAlphabet[value % accountAlphabet.length]).join('');
    const accountNumber = `${prefix}${suffix}`;
    if (!getAccountByNumber(db, accountNumber)) {
      return accountNumber;
    }
  }

  throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Could not generate a unique account number');
};

const authenticateUser = async (request: FastifyRequest, config: AppConfig, keys: KeyPair) => {
  const token = getBearerToken(request);
  return verifyAccessToken(keys.publicKeyPem, config.bankName, token);
};

export interface BranchApp extends FastifyInstance {
  state: {
    db: SqliteDatabase;
    config: AppConfig;
    keys: KeyPair;
  };
}

export const buildApp = async (config: AppConfig): Promise<BranchApp> => {
  const keys = await ensureKeyPair(config.keyDir);
  const db = openDatabase(config.dbPath);
  migrateDatabase(db, {
    name: config.bankName,
    address: config.bankAddress,
    publicKey: keys.publicKeyPem
  });

  const app = Fastify({ logger: true }) as unknown as BranchApp;
  app.state = { db, config, keys };

  const errorSchema = { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } as const;

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'TAK25 Branch Bank API',
        version: '1.0.0',
        description: 'Branch bank API for the distributed banking system'
      },
      servers: [{ url: config.bankAddress }],
      components: {
        securitySchemes: {
          BearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT'
          }
        }
      }
    }
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs'
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        code: 'INVALID_REQUEST',
        message: error.issues[0]?.message ?? 'Invalid request payload'
      });
    }

    if (isAppError(error)) {
      request.log.warn({ err: error, code: error.code }, error.message);
      return reply.status(error.statusCode).send(toErrorBody(error));
    }

    request.log.error({ err: error }, 'Unhandled request error');
    return reply.status(500).send({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred'
    });
  });

  app.addHook('onClose', async () => {
    db.close();
  });

  app.get('/', async (request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return reply.send(uiHtml);
  });

  app.get('/health', { schema: { tags: ['System'], summary: 'Health check' } }, async () => {
    const identity = getIdentity(db);
    return {
      status: 'ok',
      bankId: identity.bank_id,
      bankPrefix: identity.bank_prefix,
      address: identity.address
    };
  });

  app.post(`${config.apiPrefix}/sync`, { schema: {
    tags: ['Admin'],
    summary: 'Sync bank directory and exchange rates from central bank',
  } }, async () => {
    const directory = await refreshBankDirectory(db, config);
    const rates = await refreshExchangeRates(db, config);
    return {
      banks: directory.banks.map((b: { bankId: string; name: string; address: string; status: string }) => ({ bankId: b.bankId, name: b.name, address: b.address, status: b.status })),
      exchangeRates: rates.rates,
      syncedAt: directory.lastSyncedAt
    };
  });

  app.get(`${config.apiPrefix}/banks`, { schema: {
    tags: ['Admin'],
    summary: 'List registered banks from cached directory',
  } }, async () => {
    const cached = await refreshBankDirectory(db, config);
    return {
      banks: cached.banks.map((b: { bankId: string; name: string; address: string; status: string }) => ({ bankId: b.bankId, name: b.name, address: b.address, status: b.status })),
      lastSyncedAt: cached.lastSyncedAt
    };
  });

  app.post(`${config.apiPrefix}/users`, { schema: {
    tags: ['Users'],
    summary: 'Register a new user',
    body: { type: 'object', required: ['fullName'], properties: { fullName: { type: 'string' }, email: { type: 'string' } } },
    response: { 201: { type: 'object', properties: { userId: { type: 'string' }, fullName: { type: 'string' }, email: { type: 'string' }, createdAt: { type: 'string' } } }, 400: errorSchema, 409: errorSchema }
  } }, async (request, reply) => {
    const parsed = registrationSchema.safeParse(request.body);
    if (!parsed.success) {
      throw makeErrorFromZod(parsed.error.issues[0]?.message ?? 'Invalid registration payload');
    }

    if (parsed.data.email && getUserByEmail(db, parsed.data.email)) {
      throw new AppError(409, 'DUPLICATE_USER', 'A user with this email address is already registered');
    }

    const userId = `user-${randomUUID()}`;
    const apiKey = createApiKey();
    const createdAt = new Date().toISOString();

    createUser(db, {
      id: userId,
      full_name: parsed.data.fullName,
      email: parsed.data.email ?? null,
      api_key_hash: hashApiKey(apiKey),
      created_at: createdAt
    });

    reply.header('x-api-key', apiKey);
    return reply.status(201).send({
      userId,
      fullName: parsed.data.fullName,
      email: parsed.data.email,
      createdAt
    });
  });

  app.post(`${config.apiPrefix}/auth/tokens`, { schema: {
    tags: ['Auth'],
    summary: 'Get Bearer token',
    body: { type: 'object', required: ['userId', 'apiKey'], properties: { userId: { type: 'string' }, apiKey: { type: 'string' } } },
    response: { 200: { type: 'object', properties: { accessToken: { type: 'string' }, tokenType: { type: 'string' }, expiresIn: { type: 'number' } } }, 400: errorSchema, 401: errorSchema }
  } }, async (request) => {
    const parsed = tokenSchema.safeParse(request.body);
    if (!parsed.success) {
      throw makeErrorFromZod(parsed.error.issues[0]?.message ?? 'Invalid token request');
    }

    const user = getUserById(db, parsed.data.userId);
    if (!user || hashApiKey(parsed.data.apiKey) !== user.api_key_hash) {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid userId or API key');
    }

    const token = await issueAccessToken(keys.privateKeyPem, config.bankName, user.id, config.accessTokenTtlSeconds);
    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresIn: config.accessTokenTtlSeconds
    };
  });

  app.get(`${config.apiPrefix}/users/:userId`, { schema: {
    tags: ['Users'],
    summary: 'Get user profile',
    security: [{ BearerAuth: [] }],
    params: { type: 'object', properties: { userId: { type: 'string' } } },
    response: { 200: { type: 'object', properties: { userId: { type: 'string' }, fullName: { type: 'string' }, email: { type: 'string' }, createdAt: { type: 'string' } } }, 401: errorSchema, 403: errorSchema, 404: errorSchema }
  } }, async (request) => {
    const userId = await authenticateUser(request, config, keys);
    const params = z.object({ userId: z.string() }).parse(request.params);

    if (userId !== params.userId) {
      throw new AppError(403, 'FORBIDDEN', 'You can only access your own user profile');
    }

    const user = getUserById(db, params.userId);
    if (!user) {
      throw new AppError(404, 'USER_NOT_FOUND', `User with ID '${params.userId}' not found`);
    }

    return {
      userId: user.id,
      fullName: user.full_name,
      email: user.email ?? undefined,
      createdAt: user.created_at
    };
  });

  app.get(`${config.apiPrefix}/users/:userId/accounts`, { schema: {
    tags: ['Accounts'],
    summary: 'List user accounts',
    security: [{ BearerAuth: [] }],
    params: { type: 'object', properties: { userId: { type: 'string' } } },
    response: { 200: { type: 'object', properties: { userId: { type: 'string' }, accounts: { type: 'array', items: { type: 'object', properties: { accountNumber: { type: 'string' }, currency: { type: 'string' }, balance: { type: 'string' }, createdAt: { type: 'string' } } } } } }, 401: errorSchema, 403: errorSchema, 404: errorSchema }
  } }, async (request) => {
    const userId = await authenticateUser(request, config, keys);
    const params = z.object({ userId: z.string() }).parse(request.params);

    if (userId !== params.userId) {
      throw new AppError(403, 'FORBIDDEN', 'You can only access your own accounts');
    }

    const user = getUserById(db, params.userId);
    if (!user) {
      throw new AppError(404, 'USER_NOT_FOUND', `User with ID '${params.userId}' not found`);
    }

    return {
      userId: user.id,
      accounts: listAccountsByOwner(db, user.id).map((account) => ({
        accountNumber: account.account_number,
        currency: account.currency,
        balance: formatMoney(account.balance_minor),
        createdAt: account.created_at
      }))
    };
  });

  app.post(`${config.apiPrefix}/users/:userId/accounts`, { schema: {
    tags: ['Accounts'],
    summary: 'Create account',
    security: [{ BearerAuth: [] }],
    params: { type: 'object', properties: { userId: { type: 'string' } } },
    body: { type: 'object', required: ['currency'], properties: { currency: { type: 'string', description: 'ISO 4217 code (EUR, USD, GBP, SEK)' } } },
    response: { 201: { type: 'object', properties: { accountNumber: { type: 'string' }, ownerId: { type: 'string' }, currency: { type: 'string' }, balance: { type: 'string' }, createdAt: { type: 'string' } } }, 400: errorSchema, 401: errorSchema, 404: errorSchema }
  } }, async (request, reply) => {
    const authenticatedUserId = await authenticateUser(request, config, keys);
    const params = z.object({ userId: z.string() }).parse(request.params);

    if (authenticatedUserId !== params.userId) {
      throw new AppError(403, 'FORBIDDEN', 'You can only create accounts for your own user');
    }

    const parsed = accountSchema.safeParse(request.body);
    if (!parsed.success) {
      throw makeErrorFromZod(parsed.error.issues[0]?.message ?? 'Invalid account payload');
    }

    const user = getUserById(db, params.userId);
    if (!user) {
      throw new AppError(404, 'USER_NOT_FOUND', `User with ID '${params.userId}' not found`);
    }

    if (!config.supportedCurrencies.includes(parsed.data.currency)) {
      throw new AppError(400, 'UNSUPPORTED_CURRENCY', `Currency '${parsed.data.currency}' is not supported by this bank`);
    }

    const identity = getIdentity(db);
    if (!identity.bank_prefix) {
      throw new AppError(503, 'BANK_NOT_REGISTERED', 'Bank registration with the central bank is not ready yet');
    }

    const createdAt = new Date().toISOString();
    const accountNumber = generateAccountNumber(db, identity.bank_prefix);

    createAccount(db, {
      account_number: accountNumber,
      owner_id: user.id,
      currency: parsed.data.currency,
      balance_minor: 0,
      created_at: createdAt
    });

    return reply.status(201).send({
      accountNumber,
      ownerId: user.id,
      currency: parsed.data.currency,
      balance: '0.00',
      createdAt
    });
  });

  app.get(`${config.apiPrefix}/accounts`, { schema: {
    tags: ['Accounts'],
    summary: 'List all accounts',
  } }, async () => {
    return {
      accounts: listAllAccounts(db).map((row) => ({
        accountNumber: row.account_number,
        ownerName: row.full_name,
        currency: row.currency,
        balance: formatMoney(row.balance_minor),
        createdAt: row.created_at
      }))
    };
  });

  app.get(`${config.apiPrefix}/accounts/:accountNumber`, { schema: {
    tags: ['Accounts'],
    summary: 'Look up account (unauthenticated)',
    params: { type: 'object', properties: { accountNumber: { type: 'string' } } },
    response: { 200: { type: 'object', properties: { accountNumber: { type: 'string' }, ownerName: { type: 'string' }, currency: { type: 'string' } } }, 400: errorSchema, 404: errorSchema }
  } }, async (request) => {
    const raw = z.object({ accountNumber: z.string() }).parse(request.params);
    if (!/^[A-Z0-9]{8}$/.test(raw.accountNumber)) {
      throw new AppError(400, 'INVALID_ACCOUNT_NUMBER', 'Account number must be exactly 8 characters');
    }
    const params = raw;
    const account = getAccountByNumber(db, params.accountNumber);
    if (!account) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', `Account with number '${params.accountNumber}' not found`);
    }

    const user = getUserById(db, account.owner_id);
    if (!user) {
      throw new AppError(404, 'USER_NOT_FOUND', `User with ID '${account.owner_id}' not found`);
    }

    return {
      accountNumber: account.account_number,
      ownerName: user.full_name,
      currency: account.currency
    };
  });

  app.post(`${config.apiPrefix}/accounts/:accountNumber/deposit`, { schema: {
    tags: ['Accounts'],
    summary: 'Deposit funds',
    security: [{ BearerAuth: [] }],
    params: { type: 'object', properties: { accountNumber: { type: 'string' } } },
    body: { type: 'object', required: ['amount'], properties: { amount: { type: 'string', description: 'Amount like "100.00"' } } },
    response: { 200: { type: 'object', properties: { accountNumber: { type: 'string' }, balance: { type: 'string' } } }, 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema }
  } }, async (request, reply) => {
    const authenticatedUserId = await authenticateUser(request, config, keys);
    const params = z.object({ accountNumber: z.string().regex(/^[A-Z0-9]{8}$/) }).parse(request.params);
    const body = z.object({ amount: z.string().regex(/^\d+\.\d{2}$/) }).parse(request.body);

    const account = getAccountByNumber(db, params.accountNumber);
    if (!account) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', `Account with number '${params.accountNumber}' not found`);
    }
    if (account.owner_id !== authenticatedUserId) {
      throw new AppError(403, 'FORBIDDEN', 'You can only deposit to your own accounts');
    }

    const amountMinor = parseMoney(body.amount);
    adjustAccountBalance(db, account.account_number, amountMinor);
    const updated = getAccountByNumber(db, account.account_number)!;

    return reply.status(200).send({
      accountNumber: updated.account_number,
      balance: formatMoney(updated.balance_minor)
    });
  });

  app.post(`${config.apiPrefix}/transfers`, { schema: {
    tags: ['Transfers'],
    summary: 'Initiate transfer',
    security: [{ BearerAuth: [] }],
    body: { type: 'object', required: ['transferId', 'sourceAccount', 'destinationAccount', 'amount'], properties: { transferId: { type: 'string', format: 'uuid' }, sourceAccount: { type: 'string' }, destinationAccount: { type: 'string' }, amount: { type: 'string', description: 'Amount like "100.00"' } } },
    response: { 201: { type: 'object', properties: { transferId: { type: 'string' }, status: { type: 'string' }, sourceAccount: { type: 'string' }, destinationAccount: { type: 'string' }, amount: { type: 'string' }, convertedAmount: { type: 'string' }, exchangeRate: { type: 'string' }, rateCapturedAt: { type: 'string' }, timestamp: { type: 'string' } } }, 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 422: errorSchema, 503: errorSchema }
  } }, async (request, reply) => {
    const authenticatedUserId = await authenticateUser(request, config, keys);
    const parsed = transferSchema.safeParse(request.body);
    if (!parsed.success) {
      throw makeErrorFromZod(parsed.error.issues[0]?.message ?? 'Invalid transfer payload');
    }

    const result = await createTransfer(db, config, keys, authenticatedUserId, parsed.data);
    return reply.status(201).send(result);
  });

  app.get(`${config.apiPrefix}/users/:userId/transfers`, { schema: {
    tags: ['Transfers'],
    summary: 'List transfer history',
    security: [{ BearerAuth: [] }],
    params: { type: 'object', properties: { userId: { type: 'string' } } },
    response: { 200: { type: 'object', properties: { transfers: { type: 'array', items: { type: 'object', properties: { transferId: { type: 'string' }, direction: { type: 'string' }, status: { type: 'string' }, sourceAccount: { type: 'string' }, destinationAccount: { type: 'string' }, amount: { type: 'string' }, currency: { type: 'string' }, convertedAmount: { type: 'string' }, exchangeRate: { type: 'string' }, errorMessage: { type: 'string' }, createdAt: { type: 'string' } } } } } }, 401: errorSchema, 403: errorSchema }
  } }, async (request) => {
    const authenticatedUserId = await authenticateUser(request, config, keys);
    const params = z.object({ userId: z.string() }).parse(request.params);

    if (authenticatedUserId !== params.userId) {
      throw new AppError(403, 'FORBIDDEN', 'You can only view your own transfers');
    }

    return {
      transfers: listTransfersByUser(db, params.userId).map((t) => ({
        transferId: t.transfer_id,
        direction: t.direction,
        status: t.status,
        sourceAccount: t.source_account,
        destinationAccount: t.destination_account,
        amount: formatMoney(t.amount_minor),
        currency: t.amount_currency,
        convertedAmount: t.converted_amount_minor !== null ? formatMoney(t.converted_amount_minor) : undefined,
        exchangeRate: t.exchange_rate ?? undefined,
        errorMessage: t.error_message ?? undefined,
        createdAt: t.created_at
      }))
    };
  });

  app.post(`${config.apiPrefix}/transfers/receive`, { schema: {
    tags: ['Transfers'],
    summary: 'Receive inter-bank transfer (JWT)',
    body: { type: 'object', required: ['jwt'], properties: { jwt: { type: 'string' } } },
    response: { 200: { type: 'object', properties: { transferId: { type: 'string' }, status: { type: 'string' }, destinationAccount: { type: 'string' }, amount: { type: 'string' }, timestamp: { type: 'string' } } }, 401: errorSchema, 403: errorSchema, 404: errorSchema }
  } }, async (request) => {
    const parsed = receiveTransferSchema.safeParse(request.body);
    if (!parsed.success) {
      throw makeErrorFromZod(parsed.error.issues[0]?.message ?? 'Invalid inter-bank transfer payload');
    }

    return receiveTransfer(db, config, parsed.data.jwt);
  });

  app.get(`${config.apiPrefix}/transfers/:transferId`, { schema: {
    tags: ['Transfers'],
    summary: 'Get transfer status',
    security: [{ BearerAuth: [] }],
    params: { type: 'object', properties: { transferId: { type: 'string', format: 'uuid' } } },
    response: { 200: { type: 'object', properties: { transferId: { type: 'string' }, status: { type: 'string' }, sourceAccount: { type: 'string' }, destinationAccount: { type: 'string' }, amount: { type: 'string' }, convertedAmount: { type: 'string' }, exchangeRate: { type: 'string' }, timestamp: { type: 'string' }, pendingSince: { type: 'string' }, nextRetryAt: { type: 'string' }, retryCount: { type: 'number' }, errorMessage: { type: 'string' } } }, 401: errorSchema, 404: errorSchema }
  } }, async (request) => {
    const authenticatedUserId = await authenticateUser(request, config, keys);
    const params = z.object({ transferId: z.string().uuid() }).parse(request.params);
    return getTransferStatus(db, params.transferId, authenticatedUserId);
  });

  return app;
};
