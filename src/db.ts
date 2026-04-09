import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { ExchangeRateSnapshot } from './money.js';

export interface UserRow {
  id: string;
  full_name: string;
  email: string | null;
  api_key_hash: string;
  created_at: string;
}

export interface AccountRow {
  account_number: string;
  owner_id: string;
  currency: string;
  balance_minor: number;
  created_at: string;
}

export interface TransferRow {
  transfer_id: string;
  direction: 'incoming' | 'outgoing';
  status: 'pending' | 'completed' | 'failed' | 'failed_timeout';
  source_account: string;
  destination_account: string;
  amount_minor: number;
  amount_currency: string;
  source_currency: string | null;
  destination_currency: string | null;
  converted_amount_minor: number | null;
  exchange_rate: string | null;
  rate_captured_at: string | null;
  error_message: string | null;
  initiated_by_user_id: string | null;
  pending_since: string | null;
  next_retry_at: string | null;
  retry_count: number;
  source_bank_id: string | null;
  destination_bank_id: string | null;
  created_at: string;
  updated_at: string;
  locked_amount_minor: number;
}

export interface BankDirectoryRow {
  bank_id: string;
  name: string;
  address: string;
  public_key: string;
  last_heartbeat: string;
  status: string;
}

export interface BankIdentityRow {
  id: number;
  bank_id: string | null;
  bank_prefix: string | null;
  public_key: string;
  address: string;
  name: string;
  registered_at: string | null;
  expires_at: string | null;
}

export interface BankDirectorySnapshot {
  banks: BankDirectoryRow[];
  lastSyncedAt: string;
}

export type SqliteDatabase = Database.Database;

export const openDatabase = (dbPath: string) => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
};

export const migrateDatabase = (db: SqliteDatabase, identity: { name: string; address: string; publicKey: string }) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bank_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      bank_id TEXT,
      bank_prefix TEXT,
      public_key TEXT NOT NULL,
      address TEXT NOT NULL,
      name TEXT NOT NULL,
      registered_at TEXT,
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE,
      api_key_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      account_number TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      currency TEXT NOT NULL,
      balance_minor INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_owner_id ON accounts(owner_id);

    CREATE TABLE IF NOT EXISTS transfers (
      transfer_id TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      status TEXT NOT NULL,
      source_account TEXT NOT NULL,
      destination_account TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      amount_currency TEXT NOT NULL,
      source_currency TEXT,
      destination_currency TEXT,
      converted_amount_minor INTEGER,
      exchange_rate TEXT,
      rate_captured_at TEXT,
      error_message TEXT,
      initiated_by_user_id TEXT,
      pending_since TEXT,
      next_retry_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      source_bank_id TEXT,
      destination_bank_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      locked_amount_minor INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_transfers_status_retry ON transfers(status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_transfers_initiated_by_user_id ON transfers(initiated_by_user_id);

    CREATE TABLE IF NOT EXISTS bank_directory (
      bank_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      public_key TEXT NOT NULL,
      last_heartbeat TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS exchange_rates (
      currency TEXT PRIMARY KEY,
      rate TEXT NOT NULL,
      captured_at TEXT NOT NULL
    );
  `);

  const exists = db.prepare('SELECT id FROM bank_identity WHERE id = 1').get() as { id: number } | undefined;

  if (exists) {
    db.prepare(`
      UPDATE bank_identity
      SET public_key = ?, address = ?, name = ?
      WHERE id = 1
    `).run(identity.publicKey, identity.address, identity.name);
  } else {
    db.prepare(`
      INSERT INTO bank_identity (id, public_key, address, name)
      VALUES (1, ?, ?, ?)
    `).run(identity.publicKey, identity.address, identity.name);
  }
};

export const getSetting = (db: SqliteDatabase, key: string) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
};

export const setSetting = (db: SqliteDatabase, key: string, value: string) => {
  db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
};

export const getIdentity = (db: SqliteDatabase) =>
  db.prepare('SELECT * FROM bank_identity WHERE id = 1').get() as BankIdentityRow;

export const saveRegistration = (db: SqliteDatabase, bankId: string, expiresAt: string, registeredAt: string) => {
  db.prepare(`
    UPDATE bank_identity
    SET bank_id = ?, bank_prefix = ?, expires_at = ?, registered_at = ?
    WHERE id = 1
  `).run(bankId, bankId.slice(0, 3), expiresAt, registeredAt);
};

export const createUser = (db: SqliteDatabase, user: UserRow) => {
  db.prepare(`
    INSERT INTO users (id, full_name, email, api_key_hash, created_at)
    VALUES (@id, @full_name, @email, @api_key_hash, @created_at)
  `).run(user);
};

export const getUserById = (db: SqliteDatabase, userId: string) =>
  db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;

export const getUserByEmail = (db: SqliteDatabase, email: string) =>
  db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;

export const createAccount = (db: SqliteDatabase, account: AccountRow) => {
  db.prepare(`
    INSERT INTO accounts (account_number, owner_id, currency, balance_minor, created_at)
    VALUES (@account_number, @owner_id, @currency, @balance_minor, @created_at)
  `).run(account);
};

export const getAccountByNumber = (db: SqliteDatabase, accountNumber: string) =>
  db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(accountNumber) as AccountRow | undefined;

export const listAccountsByOwner = (db: SqliteDatabase, ownerId: string) =>
  db.prepare('SELECT * FROM accounts WHERE owner_id = ? ORDER BY created_at ASC').all(ownerId) as AccountRow[];

export const setAccountBalance = (db: SqliteDatabase, accountNumber: string, balanceMinor: number) => {
  db.prepare('UPDATE accounts SET balance_minor = ? WHERE account_number = ?').run(balanceMinor, accountNumber);
};

export const adjustAccountBalance = (db: SqliteDatabase, accountNumber: string, deltaMinor: number) => {
  db.prepare('UPDATE accounts SET balance_minor = balance_minor + ? WHERE account_number = ?').run(deltaMinor, accountNumber);
};

export const insertTransfer = (db: SqliteDatabase, transfer: TransferRow) => {
  db.prepare(`
    INSERT INTO transfers (
      transfer_id, direction, status, source_account, destination_account, amount_minor,
      amount_currency, source_currency, destination_currency, converted_amount_minor,
      exchange_rate, rate_captured_at, error_message, initiated_by_user_id, pending_since,
      next_retry_at, retry_count, source_bank_id, destination_bank_id, created_at,
      updated_at, locked_amount_minor
    ) VALUES (
      @transfer_id, @direction, @status, @source_account, @destination_account, @amount_minor,
      @amount_currency, @source_currency, @destination_currency, @converted_amount_minor,
      @exchange_rate, @rate_captured_at, @error_message, @initiated_by_user_id, @pending_since,
      @next_retry_at, @retry_count, @source_bank_id, @destination_bank_id, @created_at,
      @updated_at, @locked_amount_minor
    )
  `).run(transfer);
};

export const getTransferById = (db: SqliteDatabase, transferId: string) =>
  db.prepare('SELECT * FROM transfers WHERE transfer_id = ?').get(transferId) as TransferRow | undefined;

export const listDuePendingTransfers = (db: SqliteDatabase, nowIso: string) =>
  db.prepare(`
    SELECT * FROM transfers
    WHERE status = 'pending' AND next_retry_at IS NOT NULL AND next_retry_at <= ?
    ORDER BY next_retry_at ASC
  `).all(nowIso) as TransferRow[];

export const markTransferCompleted = (db: SqliteDatabase, transferId: string, updatedAt: string) => {
  db.prepare(`
    UPDATE transfers
    SET status = 'completed', error_message = NULL, next_retry_at = NULL, updated_at = ?
    WHERE transfer_id = ?
  `).run(updatedAt, transferId);
};

export const markTransferFailed = (db: SqliteDatabase, transferId: string, updatedAt: string, errorMessage: string) => {
  db.prepare(`
    UPDATE transfers
    SET status = 'failed', error_message = ?, next_retry_at = NULL, updated_at = ?
    WHERE transfer_id = ?
  `).run(errorMessage, updatedAt, transferId);
};

export const markTransferTimedOut = (db: SqliteDatabase, transferId: string, updatedAt: string, errorMessage: string) => {
  db.prepare(`
    UPDATE transfers
    SET status = 'failed_timeout', error_message = ?, next_retry_at = NULL, updated_at = ?
    WHERE transfer_id = ?
  `).run(errorMessage, updatedAt, transferId);
};

export const scheduleTransferRetry = (db: SqliteDatabase, transferId: string, updatedAt: string, nextRetryAt: string, retryCount: number) => {
  db.prepare(`
    UPDATE transfers
    SET retry_count = ?, next_retry_at = ?, updated_at = ?
    WHERE transfer_id = ?
  `).run(retryCount, nextRetryAt, updatedAt, transferId);
};

export const replaceBankDirectory = (
  db: SqliteDatabase,
  snapshot: { banks: Array<{ bankId: string; name: string; address: string; publicKey: string; lastHeartbeat: string; status: string }>; lastSyncedAt: string }
) => {
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM bank_directory').run();
    const statement = db.prepare(`
      INSERT INTO bank_directory (bank_id, name, address, public_key, last_heartbeat, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const bank of snapshot.banks) {
      statement.run(bank.bankId, bank.name, bank.address, bank.publicKey, bank.lastHeartbeat, bank.status);
    }

    setSetting(db, 'directory_last_synced_at', snapshot.lastSyncedAt);
  });

  transaction();
};

export const getCachedBankDirectory = (db: SqliteDatabase): BankDirectorySnapshot | null => {
  const lastSyncedAt = getSetting(db, 'directory_last_synced_at');
  if (!lastSyncedAt) {
    return null;
  }

  const banks = db.prepare('SELECT * FROM bank_directory ORDER BY bank_id ASC').all() as BankDirectoryRow[];
  return { banks, lastSyncedAt };
};

export const getBankById = (db: SqliteDatabase, bankId: string) =>
  db.prepare('SELECT * FROM bank_directory WHERE bank_id = ?').get(bankId) as BankDirectoryRow | undefined;

export const getBankByPrefix = (db: SqliteDatabase, prefix: string) =>
  db.prepare('SELECT * FROM bank_directory WHERE substr(bank_id, 1, 3) = ? LIMIT 1').get(prefix) as BankDirectoryRow | undefined;

export const getBanksByPrefix = (db: SqliteDatabase, prefix: string, excludeBankId?: string) =>
  excludeBankId
    ? db.prepare('SELECT * FROM bank_directory WHERE substr(bank_id, 1, 3) = ? AND bank_id != ? ORDER BY bank_id ASC').all(prefix, excludeBankId) as BankDirectoryRow[]
    : db.prepare('SELECT * FROM bank_directory WHERE substr(bank_id, 1, 3) = ? ORDER BY bank_id ASC').all(prefix) as BankDirectoryRow[];

export const replaceExchangeRates = (db: SqliteDatabase, snapshot: ExchangeRateSnapshot) => {
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM exchange_rates').run();
    const statement = db.prepare('INSERT INTO exchange_rates (currency, rate, captured_at) VALUES (?, ?, ?)');

    for (const [currency, rate] of Object.entries(snapshot.rates)) {
      statement.run(currency.toUpperCase(), rate, snapshot.timestamp);
    }

    setSetting(db, 'exchange_rates_base_currency', snapshot.baseCurrency.toUpperCase());
    setSetting(db, 'exchange_rates_timestamp', snapshot.timestamp);
  });

  transaction();
};

export const getCachedExchangeRates = (db: SqliteDatabase): ExchangeRateSnapshot | null => {
  const baseCurrency = getSetting(db, 'exchange_rates_base_currency');
  const timestamp = getSetting(db, 'exchange_rates_timestamp');

  if (!baseCurrency || !timestamp) {
    return null;
  }

  const rows = db.prepare('SELECT currency, rate FROM exchange_rates ORDER BY currency ASC').all() as Array<{ currency: string; rate: string }>;
  const rates = Object.fromEntries(rows.map((row) => [row.currency.toUpperCase(), row.rate]));

  return {
    baseCurrency: baseCurrency.toUpperCase(),
    rates,
    timestamp
  };
};
