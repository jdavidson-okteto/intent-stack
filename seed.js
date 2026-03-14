import pg from 'pg';
import 'dotenv/config';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const accounts = [
  { name: 'Armakuni', domain: 'armakuni.com', priority: 1 },
  { name: 'BrainRocket', domain: 'brainrocket.com', priority: 1 },
  { name: 'FloQast', domain: 'floqast.com', priority: 1 },
  { name: 'Hornetsecurity', domain: 'hornetsecurity.com', priority: 1 },
  { name: 'SKELAR', domain: 'skelar.com', priority: 1 },
  { name: 'Riverside.fm', domain: 'riverside.fm', priority: 1 },
  { name: 'Omnissa', domain: 'omnissa.com', priority: 1 },
  { name: 'Lyzr AI', domain: 'lyzr.ai', priority: 1 },
  { name: 'Nscale', domain: 'nscale.com', priority: 1 },
  { name: 'Supabase', domain: 'supabase.com', priority: 1 },
];

for (const a of accounts) {
  await db.query(
    'INSERT INTO accounts (name, domain, priority) VALUES ($1, $2, $3)',
    [a.name, a.domain, a.priority]
  );
}

console.log(`Seeded ${accounts.length} accounts.`);
await db.end();
process.exit();