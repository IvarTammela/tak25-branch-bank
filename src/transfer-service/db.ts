import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type SqliteDatabase = Database.Database;

export interface TransferRow {
  transfer_id: string; direction: string; status: string; source_account: string;
  destination_account: string; amount_minor: number; amount_currency: string;
  source_currency: string | null; destination_currency: string | null;
  converted_amount_minor: number | null; exchange_rate: string | null;
  rate_captured_at: string | null; error_message: string | null;
  initiated_by_user_id: string | null; pending_since: string | null;
  next_retry_at: string | null; retry_count: number; source_bank_id: string | null;
  destination_bank_id: string | null; created_at: string; updated_at: string;
  locked_amount_minor: number;
}

export const openDatabase = (dbPath: string) => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
};

export const migrateDatabase = (db: SqliteDatabase) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transfers (
      transfer_id TEXT PRIMARY KEY, direction TEXT NOT NULL, status TEXT NOT NULL,
      source_account TEXT NOT NULL, destination_account TEXT NOT NULL,
      amount_minor INTEGER NOT NULL, amount_currency TEXT NOT NULL,
      source_currency TEXT, destination_currency TEXT,
      converted_amount_minor INTEGER, exchange_rate TEXT, rate_captured_at TEXT,
      error_message TEXT, initiated_by_user_id TEXT,
      pending_since TEXT, next_retry_at TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
      source_bank_id TEXT, destination_bank_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      locked_amount_minor INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_status_retry ON transfers(status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_transfers_initiated_by ON transfers(initiated_by_user_id);
  `);
};

export const insertTransfer = (db: SqliteDatabase, t: TransferRow) => {
  db.prepare(`INSERT INTO transfers (transfer_id,direction,status,source_account,destination_account,amount_minor,amount_currency,source_currency,destination_currency,converted_amount_minor,exchange_rate,rate_captured_at,error_message,initiated_by_user_id,pending_since,next_retry_at,retry_count,source_bank_id,destination_bank_id,created_at,updated_at,locked_amount_minor) VALUES (@transfer_id,@direction,@status,@source_account,@destination_account,@amount_minor,@amount_currency,@source_currency,@destination_currency,@converted_amount_minor,@exchange_rate,@rate_captured_at,@error_message,@initiated_by_user_id,@pending_since,@next_retry_at,@retry_count,@source_bank_id,@destination_bank_id,@created_at,@updated_at,@locked_amount_minor)`).run(t);
};

export const getTransferById = (db: SqliteDatabase, transferId: string) =>
  db.prepare('SELECT * FROM transfers WHERE transfer_id = ?').get(transferId) as TransferRow | undefined;

export const listTransfersByUser = (db: SqliteDatabase, userId: string, userAccountNumbers: string[]) => {
  if (userAccountNumbers.length === 0) {
    return db.prepare('SELECT * FROM transfers WHERE initiated_by_user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId) as TransferRow[];
  }
  const placeholders = userAccountNumbers.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM transfers WHERE initiated_by_user_id = ? OR destination_account IN (${placeholders}) ORDER BY created_at DESC LIMIT 100`).all(userId, ...userAccountNumbers) as TransferRow[];
};

export const listDuePendingTransfers = (db: SqliteDatabase, nowIso: string) =>
  db.prepare("SELECT * FROM transfers WHERE status = 'pending' AND next_retry_at IS NOT NULL AND next_retry_at <= ? ORDER BY next_retry_at ASC").all(nowIso) as TransferRow[];

export const markTransferCompleted = (db: SqliteDatabase, transferId: string, updatedAt: string) => {
  db.prepare("UPDATE transfers SET status = 'completed', error_message = NULL, next_retry_at = NULL, updated_at = ? WHERE transfer_id = ?").run(updatedAt, transferId);
};

export const markTransferFailed = (db: SqliteDatabase, transferId: string, updatedAt: string, errorMessage: string) => {
  db.prepare("UPDATE transfers SET status = 'failed', error_message = ?, next_retry_at = NULL, updated_at = ? WHERE transfer_id = ?").run(errorMessage, updatedAt, transferId);
};

export const markTransferTimedOut = (db: SqliteDatabase, transferId: string, updatedAt: string, errorMessage: string) => {
  db.prepare("UPDATE transfers SET status = 'failed_timeout', error_message = ?, next_retry_at = NULL, updated_at = ? WHERE transfer_id = ?").run(errorMessage, updatedAt, transferId);
};

export const scheduleTransferRetry = (db: SqliteDatabase, transferId: string, updatedAt: string, nextRetryAt: string, retryCount: number) => {
  db.prepare('UPDATE transfers SET retry_count = ?, next_retry_at = ?, updated_at = ? WHERE transfer_id = ?').run(retryCount, nextRetryAt, updatedAt, transferId);
};
