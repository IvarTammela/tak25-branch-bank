import path from 'node:path';

const normalizeUrl = (value: string) => value.replace(/\/+$/, '');

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseCurrencies = (value: string | undefined) => {
  const fallback = ['EUR', 'USD', 'GBP', 'SEK'];
  if (!value) {
    return fallback;
  }

  const currencies = value
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);

  return currencies.length > 0 ? currencies : fallback;
};

export interface AppConfig {
  host: string;
  port: number;
  apiPrefix: string;
  dbPath: string;
  keyDir: string;
  bankName: string;
  bankAddress: string;
  centralBankBaseUrl: string;
  supportedCurrencies: string[];
  accessTokenTtlSeconds: number;
  directorySyncIntervalMs: number;
  heartbeatIntervalMs: number;
  retryPollIntervalMs: number;
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => ({
  host: env.HOST ?? '0.0.0.0',
  port: parsePositiveInt(env.PORT, 8081),
  apiPrefix: '/api/v1',
  dbPath: path.resolve(env.DB_PATH ?? './data/branch-bank.db'),
  keyDir: path.resolve(env.KEY_DIR ?? './data/keys'),
  bankName: env.BANK_NAME ?? 'TAK25 Branch Bank',
  bankAddress: normalizeUrl(env.BANK_ADDRESS ?? 'http://localhost:8081'),
  centralBankBaseUrl: normalizeUrl(env.CENTRAL_BANK_BASE_URL ?? 'https://test.diarainfra.com/central-bank/api/v1'),
  supportedCurrencies: parseCurrencies(env.SUPPORTED_CURRENCIES),
  accessTokenTtlSeconds: parsePositiveInt(env.ACCESS_TOKEN_TTL_SECONDS, 3600),
  directorySyncIntervalMs: parsePositiveInt(env.DIRECTORY_SYNC_INTERVAL_MS, 300000),
  heartbeatIntervalMs: parsePositiveInt(env.HEARTBEAT_INTERVAL_MS, 600000),
  retryPollIntervalMs: parsePositiveInt(env.RETRY_POLL_INTERVAL_MS, 15000)
});
