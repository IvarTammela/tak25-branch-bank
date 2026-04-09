import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type SqliteDatabase = Database.Database;
export interface AccountRow { account_number: string; owner_id: string; currency: string; balance_minor: number; created_at: string; }

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
    CREATE TABLE IF NOT EXISTS accounts (
      account_number TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
      currency TEXT NOT NULL, balance_minor INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_owner_id ON accounts(owner_id);
  `);
};

export const createAccount = (db: SqliteDatabase, account: AccountRow) => {
  db.prepare('INSERT INTO accounts (account_number, owner_id, currency, balance_minor, created_at) VALUES (@account_number, @owner_id, @currency, @balance_minor, @created_at)').run(account);
};

export const getAccountByNumber = (db: SqliteDatabase, accountNumber: string) =>
  db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(accountNumber) as AccountRow | undefined;

export const listAccountsByOwner = (db: SqliteDatabase, ownerId: string) =>
  db.prepare('SELECT * FROM accounts WHERE owner_id = ? ORDER BY created_at ASC').all(ownerId) as AccountRow[];

export const listAllAccounts = (db: SqliteDatabase) =>
  db.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all() as AccountRow[];

export const adjustAccountBalance = (db: SqliteDatabase, accountNumber: string, deltaMinor: number) => {
  db.prepare('UPDATE accounts SET balance_minor = balance_minor + ? WHERE account_number = ?').run(deltaMinor, accountNumber);
};
