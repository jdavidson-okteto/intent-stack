import pg from 'pg';
import 'dotenv/config';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await db.query('DELETE FROM scores');
await db.query('DELETE FROM signals');
await db.query('DELETE FROM accounts');
console.log('Cleared.');
await db.end();
process.exit();