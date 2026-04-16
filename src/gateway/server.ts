import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { html as uiHtml } from '../ui.js';

const PORT = Number(process.env.PORT ?? '8081');
const USER_SERVICE = process.env.USER_SERVICE_URL ?? 'http://localhost:8082';
const ACCOUNT_SERVICE = process.env.ACCOUNT_SERVICE_URL ?? 'http://localhost:8083';
const TRANSFER_SERVICE = process.env.TRANSFER_SERVICE_URL ?? 'http://localhost:8084';
const CB_SERVICE = process.env.CB_SERVICE_URL ?? 'http://localhost:8085';
const BANK_ADDRESS = process.env.BANK_ADDRESS ?? `http://localhost:${PORT}`;

const app = Fastify({
  logger: true,
  ajv: { customOptions: { allErrors: true } }
});

app.addContentTypeParser('application/json', { parseAs: 'string' }, (req: any, body: any, done: any) => {
  try { done(null, body && (body as string).length > 0 ? JSON.parse(body as string) : {}); }
  catch (e: any) { done(e, undefined); }
});
app.addContentTypeParser('*', (req: any, payload: any, done: any) => { done(null, {}); });

// Disable body validation on gateway - services validate themselves
app.addHook('preValidation', async (request) => {
  // Skip Fastify's built-in body validation for proxy routes
  if (request.url !== '/' && request.url !== '/health') {
    (request as any).validationError = null;
  }
});

// Fix #2: Ensure all errors use {code, message} format
app.setErrorHandler((error: any, request, reply) => {
  if (error.validation) {
    return reply.status(400).send({ code: 'INVALID_REQUEST', message: error.message });
  }
  request.log.error({ err: error }, 'Gateway error');
  return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
});

const errorSchema = { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } } as const;

const transferResponseSchema = {
  type: 'object', properties: {
    transferId: { type: 'string' }, status: { type: 'string', enum: ['completed', 'failed', 'pending', 'failed_timeout'] },
    sourceAccount: { type: 'string' }, destinationAccount: { type: 'string' },
    amount: { type: 'string' }, convertedAmount: { type: 'string' },
    exchangeRate: { type: 'string' }, rateCapturedAt: { type: 'string' },
    timestamp: { type: 'string' }, errorMessage: { type: 'string' },
    pendingSince: { type: 'string' }, nextRetryAt: { type: 'string' }, retryCount: { type: 'number' }
  }
} as const;

await app.register(swagger, {
  openapi: {
    info: { title: 'TAK25 Branch Bank API', version: '1.0.0', description: 'Branch bank API - microservices architecture' },
    servers: [{ url: BANK_ADDRESS }],
    components: { securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } }
  }
});
await app.register(swaggerUi, { routePrefix: '/docs' });

const proxy = async (serviceUrl: string, request: any, reply: any, pathOverride?: string) => {
  const url = `${serviceUrl}${pathOverride ?? request.url}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (request.headers.authorization) headers.authorization = request.headers.authorization;

  try {
    const res = await fetch(url, {
      method: request.method,
      headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? JSON.stringify(request.body ?? {}) : undefined
    });
    const text = await res.text();
    const apiKey = res.headers.get('x-api-key');
    if (apiKey) reply.header('x-api-key', apiKey);
    reply.status(res.status).header('content-type', res.headers.get('content-type') ?? 'application/json').send(text);
  } catch (error) {
    reply.status(502).send(JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: `Service at ${serviceUrl} is unavailable` }));
  }
};

// UI
app.get('/', async (request, reply) => { reply.header('content-type', 'text/html; charset=utf-8'); return reply.send(uiHtml); });

// Fix #1: Health response schema matches actual response
app.get('/health', { schema: { tags: ['System'], summary: 'Health check',
  response: { 200: { type: 'object', properties: { status: { type: 'string' }, timestamp: { type: 'string' } } } }
} }, async (req, rep) => proxy(CB_SERVICE, req, rep));

// Non-prefixed aliases for cross-bank interoperability (branch-bank spec paths are relative to bank address)
app.get('/accounts/:accountNumber', { schema: false as any }, async (req, rep) => proxy(ACCOUNT_SERVICE, req, rep, `/api/v1${req.url}`));
app.post('/transfers/receive', { schema: false as any }, async (req, rep) => proxy(TRANSFER_SERVICE, req, rep, `/api/v1${req.url}`));

// Also expose /api/v1/health so external central bank's health probe passes
// for a /api/v1-suffixed BANK_ADDRESS registration. Rewrites to /health on CB service.
app.get('/api/v1/health', { schema: { tags: ['System'], summary: 'Health check (prefixed)' } },
  async (req, rep) => proxy(CB_SERVICE, req, rep, '/health'));

// Fix #4: apiKey documented in response description + x-api-key header noted
app.post('/api/v1/users', { schema: { tags: ['Users'], summary: 'Register a new user',
  description: 'Registers a new user. API key is returned in the X-API-Key response header. Use it with POST /auth/tokens to get a Bearer token.',
  body: { type: 'object', required: ['fullName'], properties: { fullName: { type: 'string', minLength: 2, maxLength: 200 }, email: { type: 'string', format: 'email' } } },
  response: {
    201: { type: 'object', description: 'User registered. Check X-API-Key response header for the API key.', properties: { userId: { type: 'string' }, fullName: { type: 'string' }, email: { type: 'string' }, createdAt: { type: 'string' } } },
    400: errorSchema, 409: errorSchema }
} }, async (req, rep) => proxy(USER_SERVICE, req, rep));

app.post('/api/v1/auth/tokens', { schema: { tags: ['Auth'], summary: 'Get Bearer token',
  body: { type: 'object', required: ['userId', 'apiKey'], properties: { userId: { type: 'string' }, apiKey: { type: 'string' } } },
  response: { 200: { type: 'object', properties: { accessToken: { type: 'string' }, tokenType: { type: 'string' }, expiresIn: { type: 'number' } } },
    400: errorSchema, 401: errorSchema }
} }, async (req, rep) => proxy(USER_SERVICE, req, rep));

app.get('/api/v1/users/:userId', { schema: { tags: ['Users'], summary: 'Get user profile', security: [{ BearerAuth: [] }],
  params: { type: 'object', properties: { userId: { type: 'string' } } },
  response: { 200: { type: 'object', properties: { userId: { type: 'string' }, fullName: { type: 'string' }, email: { type: 'string' }, createdAt: { type: 'string' } } },
    401: errorSchema, 403: errorSchema, 404: errorSchema }
} }, async (req, rep) => proxy(USER_SERVICE, req, rep));

// Fix #7: Response schemas for list endpoints
app.get('/api/v1/users/:userId/accounts', { schema: { tags: ['Accounts'], summary: 'List user accounts', security: [{ BearerAuth: [] }],
  params: { type: 'object', properties: { userId: { type: 'string' } } },
  response: { 200: { type: 'object', properties: { userId: { type: 'string' }, accounts: { type: 'array', items: { type: 'object', properties: { accountNumber: { type: 'string' }, currency: { type: 'string' }, balance: { type: 'string' }, createdAt: { type: 'string' } } } } } },
    401: errorSchema, 403: errorSchema, 404: errorSchema }
} }, async (req, rep) => proxy(ACCOUNT_SERVICE, req, rep));

app.post('/api/v1/users/:userId/accounts', { schema: { tags: ['Accounts'], summary: 'Create account', security: [{ BearerAuth: [] }],
  body: { type: 'object', required: ['currency'], properties: { currency: { type: 'string', pattern: '^[A-Z]{3}$', description: 'ISO 4217 (EUR, USD, GBP, SEK)' } } },
  response: { 201: { type: 'object', properties: { accountNumber: { type: 'string' }, ownerId: { type: 'string' }, currency: { type: 'string' }, balance: { type: 'string' }, createdAt: { type: 'string' } } },
    400: errorSchema, 401: errorSchema, 404: errorSchema }
} }, async (req, rep) => proxy(ACCOUNT_SERVICE, req, rep));

app.get('/api/v1/accounts', { schema: { tags: ['Accounts'], summary: 'List all accounts',
  response: { 200: { type: 'object', properties: { accounts: { type: 'array', items: { type: 'object', properties: { accountNumber: { type: 'string' }, ownerName: { type: 'string' }, currency: { type: 'string' }, balance: { type: 'string' }, createdAt: { type: 'string' } } } } } } }
} }, async (req, rep) => proxy(ACCOUNT_SERVICE, req, rep));

app.get('/api/v1/accounts/:accountNumber', { schema: { tags: ['Accounts'], summary: 'Look up account (unauthenticated)',
  params: { type: 'object', properties: { accountNumber: { type: 'string', pattern: '^[A-Z0-9]{8}$' } } },
  response: { 200: { type: 'object', properties: { accountNumber: { type: 'string' }, ownerName: { type: 'string' }, currency: { type: 'string' } } },
    400: errorSchema, 404: errorSchema }
} }, async (req, rep) => proxy(ACCOUNT_SERVICE, req, rep));

app.post('/api/v1/accounts/:accountNumber/deposit', { schema: { tags: ['Accounts'], summary: 'Deposit funds', security: [{ BearerAuth: [] }],
  body: { type: 'object', required: ['amount'], properties: { amount: { type: 'string', pattern: '^\\d+\\.\\d{2}$', description: 'e.g. "100.00"' } } },
  response: { 200: { type: 'object', properties: { accountNumber: { type: 'string' }, balance: { type: 'string' } } },
    400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema }
} }, async (req, rep) => proxy(ACCOUNT_SERVICE, req, rep));

// Fix #5: rateCapturedAt added to transfer response. Fix #6: transfer status has response schema
app.post('/api/v1/transfers', { schema: { tags: ['Transfers'], summary: 'Initiate transfer', security: [{ BearerAuth: [] }],
  body: { type: 'object', required: ['transferId', 'sourceAccount', 'destinationAccount', 'amount'], properties: { transferId: { type: 'string', format: 'uuid' }, sourceAccount: { type: 'string', pattern: '^[A-Z0-9]{8}$' }, destinationAccount: { type: 'string', pattern: '^[A-Z0-9]{8}$' }, amount: { type: 'string', pattern: '^\\d+\\.\\d{2}$' } } },
  response: { 201: transferResponseSchema, 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 422: errorSchema, 503: errorSchema }
} }, async (req, rep) => proxy(TRANSFER_SERVICE, req, rep));

app.post('/api/v1/transfers/receive', { schema: { tags: ['Transfers'], summary: 'Receive inter-bank transfer (JWT)',
  body: { type: 'object', required: ['jwt'], properties: { jwt: { type: 'string', description: 'ES256 signed JWT containing transfer details' } } },
  response: { 200: { type: 'object', properties: { transferId: { type: 'string' }, status: { type: 'string' }, destinationAccount: { type: 'string' }, amount: { type: 'string' }, timestamp: { type: 'string' } } },
    401: errorSchema, 403: errorSchema, 404: errorSchema }
} }, async (req, rep) => proxy(TRANSFER_SERVICE, req, rep));

// Fix #6: transfer status response schema
app.get('/api/v1/transfers/:transferId', { schema: { tags: ['Transfers'], summary: 'Get transfer status', security: [{ BearerAuth: [] }],
  params: { type: 'object', properties: { transferId: { type: 'string', format: 'uuid' } } },
  response: { 200: transferResponseSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema }
} }, async (req, rep) => proxy(TRANSFER_SERVICE, req, rep));

// Fix #7: transfer history response schema
app.get('/api/v1/users/:userId/transfers', { schema: { tags: ['Transfers'], summary: 'List transfer history', security: [{ BearerAuth: [] }],
  params: { type: 'object', properties: { userId: { type: 'string' } } },
  response: { 200: { type: 'object', properties: { transfers: { type: 'array', items: { type: 'object', properties: {
    transferId: { type: 'string' }, direction: { type: 'string', enum: ['incoming', 'outgoing'] }, status: { type: 'string' },
    sourceAccount: { type: 'string' }, destinationAccount: { type: 'string' }, amount: { type: 'string' }, currency: { type: 'string' },
    convertedAmount: { type: 'string' }, exchangeRate: { type: 'string' }, errorMessage: { type: 'string' }, createdAt: { type: 'string' }
  } } } } }, 401: errorSchema, 403: errorSchema }
} }, async (req, rep) => proxy(TRANSFER_SERVICE, req, rep));

app.post('/api/v1/sync', { schema: { tags: ['Admin'], summary: 'Sync with central bank' } }, async (req, rep) => proxy(CB_SERVICE, req, rep));
app.get('/api/v1/banks', { schema: { tags: ['Admin'], summary: 'List registered banks' } }, async (req, rep) => proxy(CB_SERVICE, req, rep));

await app.listen({ host: '0.0.0.0', port: PORT });
console.log(`API Gateway running on port ${PORT}`);
