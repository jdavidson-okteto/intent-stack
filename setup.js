import pg from 'pg';
import 'dotenv/config';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

await db.query(`
  CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    domain TEXT,
    priority INT DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS signals (
    id SERIAL PRIMARY KEY,
    account_id INT REFERENCES accounts(id),
    signals JSONB,
    fetched_at TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS scores (
    id SERIAL PRIMARY KEY,
    account_id INT REFERENCES accounts(id),
    score INT,
    top_signals JSONB,
    confidence TEXT,
    narrative TEXT,
    scored_at TIMESTAMPTZ DEFAULT now()
  );
`);

console.log('Tables created successfully.');
await db.end();
process.exit();