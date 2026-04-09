import { AppError } from '../shared/errors.js';
import {
  getCachedBankDirectory,
  getCachedExchangeRates,
  getIdentity,
  replaceBankDirectory,
  replaceExchangeRates,
  saveRegistration,
  type SqliteDatabase,
  type ExchangeRateSnapshot
} from './db.js';

export interface AppConfig {
  centralBankBaseUrl: string;
  bankName: string;
  bankAddress: string;
}

interface CentralBankDirectoryResponse {
  banks: Array<{
    bankId: string;
    name: string;
    address: string;
    publicKey: string;
    lastHeartbeat: string;
    status: string;
  }>;
  lastSyncedAt: string;
}

interface RegisterBankResponse {
  bankId: string;
  expiresAt: string;
}

const requestJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as T | { code?: string; message?: string }) : null;

    if (!response.ok) {
      const errorPayload = payload as { code?: string; message?: string } | null;
      throw new AppError(response.status, errorPayload?.code ?? 'CENTRAL_BANK_UNAVAILABLE', errorPayload?.message ?? 'Central bank request failed');
    }

    return payload as T;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(503, 'CENTRAL_BANK_UNAVAILABLE', 'Central bank is temporarily unavailable');
  }
};

const normalizeBankAddress = (address: string) => address.replace(/\/+$/, '');

export const refreshBankDirectory = async (db: SqliteDatabase, config: AppConfig) => {
  const snapshot = await requestJson<CentralBankDirectoryResponse>(`${config.centralBankBaseUrl}/banks`);
  replaceBankDirectory(db, snapshot);
  return snapshot;
};

export const getBankDirectoryWithFallback = async (db: SqliteDatabase, config: AppConfig) => {
  try {
    return await refreshBankDirectory(db, config);
  } catch (error) {
    const cached = getCachedBankDirectory(db);
    if (cached) {
      return {
        banks: cached.banks.map((bank) => ({
          bankId: bank.bank_id,
          name: bank.name,
          address: bank.address,
          publicKey: bank.public_key,
          lastHeartbeat: bank.last_heartbeat,
          status: bank.status
        })),
        lastSyncedAt: cached.lastSyncedAt
      };
    }

    throw error;
  }
};

export const refreshExchangeRates = async (db: SqliteDatabase, config: AppConfig) => {
  const snapshot = await requestJson<ExchangeRateSnapshot>(`${config.centralBankBaseUrl}/exchange-rates`);
  replaceExchangeRates(db, snapshot);
  return snapshot;
};

export const getExchangeRatesWithFallback = async (db: SqliteDatabase, config: AppConfig) => {
  try {
    return await refreshExchangeRates(db, config);
  } catch (error) {
    const cached = getCachedExchangeRates(db);
    if (cached) {
      return cached;
    }

    throw error;
  }
};

export const ensureBankRegistration = async (db: SqliteDatabase, config: AppConfig, publicKeyPem: string) => {
  const identity = getIdentity(db);

  try {
    const directory = await refreshBankDirectory(db, config);
    const existing = directory.banks.find((bank) => normalizeBankAddress(bank.address) === normalizeBankAddress(identity.address));
    if (existing) {
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      saveRegistration(db, existing.bankId, expiresAt, identity.registered_at ?? now);
      return getIdentity(db);
    }
  } catch (error) {
    if (identity.bank_id) {
      return identity;
    }

    throw error;
  }

  const registration = await requestJson<RegisterBankResponse>(`${config.centralBankBaseUrl}/banks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: config.bankName,
      address: config.bankAddress,
      publicKey: publicKeyPem
    })
  });

  saveRegistration(db, registration.bankId, registration.expiresAt, new Date().toISOString());
  return getIdentity(db);
};

export const sendHeartbeat = async (db: SqliteDatabase, config: AppConfig) => {
  const identity = getIdentity(db);
  if (!identity.bank_id) {
    return ensureBankRegistration(db, config, identity.public_key);
  }

  try {
    const response = await requestJson<{ expiresAt: string }>(`${config.centralBankBaseUrl}/banks/${identity.bank_id}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timestamp: new Date().toISOString() })
    });

    saveRegistration(db, identity.bank_id, response.expiresAt, identity.registered_at ?? new Date().toISOString());
    return getIdentity(db);
  } catch (error) {
    if (error instanceof AppError && (error.statusCode === 404 || error.statusCode === 410)) {
      return ensureBankRegistration(db, config, identity.public_key);
    }

    throw error;
  }
};
