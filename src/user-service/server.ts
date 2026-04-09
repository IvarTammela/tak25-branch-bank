import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Fastify from 'fastify';
import { z } from 'zod';
import { createApiKey, hashApiKey, issueAccessToken, verifyAccessToken } from '../shared/auth.js';
import { ensureKeyPair } from '../shared/keys.js';
import { AppError, isAppError, toErrorBody } from '../shared/errors.js';
import { openDatabase, migrateDatabase, createUser, getUserById, getUserByEmail } from './db.js';

const PORT = Number(process.env.USER_PORT ?? '8082');
const DB_PATH = path.resolve(process.env.USER_DB_PATH ?? './data/user-service.db');
const KEY_DIR = path.resolve(process.env.KEY_DIR ?? './data/keys');
const BANK_NAME = process.env.BANK_NAME ?? 'TAK25 Branch Bank';
const TOKEN_TTL = Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? '3600');

const keys = await ensureKeyPair(KEY_DIR);
const db = openDatabase(DB_PATH);
migrateDatabase(db);

const app = Fastify({ logger: true });

app.setErrorHandler((error, request, reply) => {
  if (error instanceof z.ZodError) return reply.status(400).send({ code: 'INVALID_REQUEST', message: error.issues[0]?.message ?? 'Invalid request' });
  if (isAppError(error)) return reply.status(error.statusCode).send(toErrorBody(error));
  request.log.error({ err: error }, 'Unhandled error');
  return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
});

const registrationSchema = z.object({ fullName: z.string().trim().min(2).max(200), email: z.string().email().max(255).optional() });
const tokenSchema = z.object({ userId: z.string().regex(/^user-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), apiKey: z.string().min(16) });

app.post('/api/v1/users', async (request, reply) => {
  const parsed = registrationSchema.safeParse(request.body);
  if (!parsed.success) throw new AppError(400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid');
  if (parsed.data.email && getUserByEmail(db, parsed.data.email)) throw new AppError(409, 'DUPLICATE_USER', 'A user with this email address is already registered');
  const userId = `user-${randomUUID()}`;
  const apiKey = createApiKey();
  const createdAt = new Date().toISOString();
  createUser(db, { id: userId, full_name: parsed.data.fullName, email: parsed.data.email ?? null, api_key_hash: hashApiKey(apiKey), created_at: createdAt });
  reply.header('x-api-key', apiKey);
  return reply.status(201).send({ userId, fullName: parsed.data.fullName, email: parsed.data.email, createdAt });
});

app.post('/api/v1/auth/tokens', async (request) => {
  const body = request.body as { userId?: string; apiKey?: string } | null;
  if (!body?.userId || !body?.apiKey) throw new AppError(400, 'INVALID_REQUEST', 'userId and apiKey are required');
  const user = getUserById(db, body.userId);
  if (!user || hashApiKey(body.apiKey) !== user.api_key_hash) throw new AppError(401, 'UNAUTHORIZED', 'Invalid userId or API key');
  const token = await issueAccessToken(keys.privateKeyPem, BANK_NAME, user.id, TOKEN_TTL);
  return { accessToken: token, tokenType: 'Bearer', expiresIn: TOKEN_TTL };
});

const authenticateUser = async (request: any) => {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new AppError(401, 'UNAUTHORIZED', 'Authentication is required');
  return verifyAccessToken(keys.publicKeyPem, BANK_NAME, header.slice(7));
};

app.get('/api/v1/users/:userId', async (request) => {
  const userId = await authenticateUser(request);
  const params = z.object({ userId: z.string() }).parse(request.params);
  if (userId !== params.userId) throw new AppError(403, 'FORBIDDEN', 'You can only access your own user profile');
  const user = getUserById(db, params.userId);
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', `User with ID '${params.userId}' not found`);
  return { userId: user.id, fullName: user.full_name, email: user.email ?? undefined, createdAt: user.created_at };
});

// Internal endpoint for other services
app.get('/internal/users/:userId', async (request) => {
  const { userId } = request.params as { userId: string };
  const user = getUserById(db, userId);
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', `User ${userId} not found`);
  return { userId: user.id, fullName: user.full_name, email: user.email };
});

await app.listen({ host: '0.0.0.0', port: PORT });
console.log(`User Service running on port ${PORT}`);
