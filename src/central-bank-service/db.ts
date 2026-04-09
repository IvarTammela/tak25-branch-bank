import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type SqliteDatabase = Database.Database;

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

export interface BankDirectoryRow {
  bank_id: string;
  name: string;
  address: string;
  public_key: string;
  last_heartbeat: string;
  status: string;
}

export interface ExchangeRateSnapshot {
  baseCurrency: string;
  rates: Record<string, string>;
  timestamp: string;
}

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
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bank_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      bank_id TEXT, bank_prefix TEXT, public_key TEXT NOT NULL,
      address TEXT NOT NULL, name TEXT NOT NULL,
      registered_at TEXT, expires_at TEXT
    );
    CREATE TABLE IF NOT EXISTS bank_directory (
      bank_id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL,
      public_key TEXT NOT NULL, last_heartbeat TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exchange_rates (
      currency TEXT PRIMARY KEY, rate TEXT NOT NULL, captured_at TEXT NOT NULL
    );
  `);

  const exists = db.prepare('SELECT id FROM bank_identity WHERE id = 1').get() as { id: number } | undefined;
  if (exists) {
    db.prepare('UPDATE bank_identity SET public_key = ?, address = ?, name = ? WHERE id = 1').run(identity.publicKey, identity.address, identity.name);
  } else {
    db.prepare('INSERT INTO bank_identity (id, public_key, address, name) VALUES (1, ?, ?, ?)').run(identity.publicKey, identity.address, identity.name);
  }
};

export const getSetting = (db: SqliteDatabase, key: string) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
};

export const setSetting = (db: SqliteDatabase, key: string, value: string) => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
};

export const getIdentity = (db: SqliteDatabase) =>
  db.prepare('SELECT * FROM bank_identity WHERE id = 1').get() as BankIdentityRow;

export const saveRegistration = (db: SqliteDatabase, bankId: string, expiresAt: string, registeredAt: string) => {
  db.prepare('UPDATE bank_identity SET bank_id = ?, bank_prefix = ?, expires_at = ?, registered_at = ? WHERE id = 1').run(bankId, bankId.slice(0, 3), expiresAt, registeredAt);
};

export const replaceBankDirectory = (db: SqliteDatabase, snapshot: { banks: Array<{ bankId: string; name: string; address: string; publicKey: string; lastHeartbeat: string; status: string }>; lastSyncedAt: string }) => {
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM bank_directory').run();
    const stmt = db.prepare('INSERT INTO bank_directory (bank_id, name, address, public_key, last_heartbeat, status) VALUES (?, ?, ?, ?, ?, ?)');
    for (const b of snapshot.banks) stmt.run(b.bankId, b.name, b.address, b.publicKey, b.lastHeartbeat, b.status);
    setSetting(db, 'directory_last_synced_at', snapshot.lastSyncedAt);
  });
  transaction();
};

export const getCachedBankDirectory = (db: SqliteDatabase) => {
  const lastSyncedAt = getSetting(db, 'directory_last_synced_at');
  if (!lastSyncedAt) return null;
  const banks = db.prepare('SELECT * FROM bank_directory ORDER BY bank_id ASC').all() as BankDirectoryRow[];
  return { banks, lastSyncedAt };
};

export const getBankById = (db: SqliteDatabase, bankId: string) =>
  db.prepare('SELECT * FROM bank_directory WHERE bank_id = ?').get(bankId) as BankDirectoryRow | undefined;

export const replaceExchangeRates = (db: SqliteDatabase, snapshot: ExchangeRateSnapshot) => {
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM exchange_rates').run();
    const stmt = db.prepare('INSERT INTO exchange_rates (currency, rate, captured_at) VALUES (?, ?, ?)');
    for (const [currency, rate] of Object.entries(snapshot.rates)) stmt.run(currency.toUpperCase(), rate, snapshot.timestamp);
    setSetting(db, 'exchange_rates_base_currency', snapshot.baseCurrency.toUpperCase());
    setSetting(db, 'exchange_rates_timestamp', snapshot.timestamp);
  });
  transaction();
};

export const getCachedExchangeRates = (db: SqliteDatabase): ExchangeRateSnapshot | null => {
  const baseCurrency = getSetting(db, 'exchange_rates_base_currency');
  const timestamp = getSetting(db, 'exchange_rates_timestamp');
  if (!baseCurrency || !timestamp) return null;
  const rows = db.prepare('SELECT currency, rate FROM exchange_rates ORDER BY currency ASC').all() as Array<{ currency: string; rate: string }>;
  return { baseCurrency: baseCurrency.toUpperCase(), rates: Object.fromEntries(rows.map(r => [r.currency.toUpperCase(), r.rate])), timestamp };
};
