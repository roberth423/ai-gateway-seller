import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

const db = new Database(process.env.DATABASE_PATH || './data.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  balance REAL NOT NULL DEFAULT 0,
  api_key TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  models TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  provider_id INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  type TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'payg',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT UNIQUE,
  stripe_price_id TEXT,
  stripe_payment_method_id TEXT,
  next_billing_date TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Seed admin
const adminExists = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
if (!adminExists) {
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = bcrypt.hashSync(password, 10);
  const apiKey = 'sk-admin-' + randomBytes(24).toString('hex');
  db.prepare('INSERT INTO users (username, password_hash, role, api_key) VALUES (?, ?, ?, ?)')
    .run('admin', hash, 'admin', apiKey);
  console.log('[seed] Admin user created');
  console.log('[seed]   username: admin');
  console.log('[seed]   password:', password);
  console.log('[seed]   api_key :', apiKey);
}

// Seed providers from env
const providerCount = db.prepare('SELECT COUNT(*) as c FROM providers').get().c;
if (providerCount === 0) {
  const seeds = [];
  if (process.env.OPENROUTER_API_KEY) seeds.push({ name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', api_key: process.env.OPENROUTER_API_KEY, models: JSON.stringify(['openrouter/gpt-4o','openrouter/gpt-4o-mini','openrouter/anthropic/claude-3.5-sonnet','openrouter/anthropic/claude-3-haiku','openrouter/google/gemini-pro-1.5','openrouter/meta-llama/llama-3.1-405b-instruct']) });
  if (process.env.NINE_ROUTER_API_KEY) seeds.push({ name: '9Router', base_url: process.env.NINE_ROUTER_BASE_URL || 'https://api.9router.com/v1', api_key: process.env.NINE_ROUTER_API_KEY, models: JSON.stringify((process.env.NINE_ROUTER_MODELS || '9router/default').split(',')) });
  if (process.env.TOKENHARBOR_API_KEY) seeds.push({ name: 'TokenHarbor', base_url: process.env.TOKENHARBOR_BASE_URL || 'https://api.tokenharbor.com/v1', api_key: process.env.TOKENHARBOR_API_KEY, models: JSON.stringify((process.env.TOKENHARBOR_MODELS || 'tokenharbor/default').split(',')) });
  if (process.env.CUSTOM_PROVIDER_API_KEY && process.env.CUSTOM_PROVIDER_BASE_URL) seeds.push({ name: process.env.CUSTOM_PROVIDER_NAME || 'Custom', base_url: process.env.CUSTOM_PROVIDER_BASE_URL, api_key: process.env.CUSTOM_PROVIDER_API_KEY, models: JSON.stringify((process.env.CUSTOM_PROVIDER_MODELS || 'custom/default').split(',')) });
  const insert = db.prepare('INSERT INTO providers (name, base_url, api_key, models) VALUES (?, ?, ?, ?)');
  for (const s of seeds) insert.run(s.name, s.base_url, s.api_key, s.models);
  if (seeds.length) console.log(`[seed] ${seeds.length} provider(s) seeded`);
}

export default db;
