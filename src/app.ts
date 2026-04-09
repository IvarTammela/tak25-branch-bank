import { randomBytes, randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { createApiKey, hashApiKey, issueAccessToken, verifyAccessToken } from './auth.js';
import type { AppConfig } from './config.js';
import {
  createAccount,
  createUser,
  getAccountByNumber,
  getIdentity,
  getTransferById,
  getUserByEmail,
  getUserById,
  listAccountsByOwner,
  migrateDatabase,
  openDatabase,
  type SqliteDatabase
} from './db.js';
import { AppError, isAppError, toErrorBody } from './errors.js';
import type { KeyPair } from './keys.js';
import { ensureKeyPair } from './keys.js';
import { formatMoney } from './money.js';
import { createTransfer, getTransferStatus, receiveTransfer } from './transfers.js';

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

  app.get('/health', async () => {
    const identity = getIdentity(db);
    return {
      status: 'ok',
      bankId: identity.bank_id,
      bankPrefix: identity.bank_prefix,
      address: identity.address
    };
  });

  app.post(`${config.apiPrefix}/users`, async (request, reply) => {
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

  app.post(`${config.apiPrefix}/auth/tokens`, async (request) => {
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

  app.get(`${config.apiPrefix}/users/:userId`, async (request) => {
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

  app.get(`${config.apiPrefix}/users/:userId/accounts`, async (request) => {
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

  app.post(`${config.apiPrefix}/users/:userId/accounts`, async (request, reply) => {
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

  app.get(`${config.apiPrefix}/accounts/:accountNumber`, async (request) => {
    const params = z.object({ accountNumber: z.string().regex(/^[A-Z0-9]{8}$/) }).parse(request.params);
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

  app.post(`${config.apiPrefix}/transfers`, async (request, reply) => {
    const authenticatedUserId = await authenticateUser(request, config, keys);
    const parsed = transferSchema.safeParse(request.body);
    if (!parsed.success) {
      throw makeErrorFromZod(parsed.error.issues[0]?.message ?? 'Invalid transfer payload');
    }

    const result = await createTransfer(db, config, keys, authenticatedUserId, parsed.data);
    return reply.status(201).send(result);
  });

  app.post(`${config.apiPrefix}/transfers/receive`, async (request) => {
    const parsed = receiveTransferSchema.safeParse(request.body);
    if (!parsed.success) {
      throw makeErrorFromZod(parsed.error.issues[0]?.message ?? 'Invalid inter-bank transfer payload');
    }

    return receiveTransfer(db, config, parsed.data.jwt);
  });

  app.get(`${config.apiPrefix}/transfers/:transferId`, async (request) => {
    const authenticatedUserId = await authenticateUser(request, config, keys);
    const params = z.object({ transferId: z.string().uuid() }).parse(request.params);
    return getTransferStatus(db, params.transferId, authenticatedUserId);
  });

  return app;
};
