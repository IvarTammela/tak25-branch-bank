import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type SqliteDatabase = Database.Database;
export interface UserRow { id: string; full_name: string; email: string | null; api_key_hash: string; created_at: string; }

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
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, full_name TEXT NOT NULL, email TEXT UNIQUE,
      api_key_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
};

export const createUser = (db: SqliteDatabase, user: UserRow) => {
  db.prepare('INSERT INTO users (id, full_name, email, api_key_hash, created_at) VALUES (@id, @full_name, @email, @api_key_hash, @created_at)').run(user);
};

export const getUserById = (db: SqliteDatabase, userId: string) =>
  db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;

export const getUserByEmail = (db: SqliteDatabase, email: string) =>
  db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
