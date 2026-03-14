import pg from 'pg';
import 'dotenv/config';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const { rows } = await db.query(`
  SELECT
    a.name,
    s.score,
    s.top_signals,
    s.confidence,
    s.narrative,
    s.scored_at
  FROM scores s
  JOIN accounts a ON a.id = s.account_id
  ORDER BY s.score DESC
`);

for (const row of rows) {
  console.log('\n─────────────────────────────────');
  console.log(`Account:    ${row.name}`);
  console.log(`Score:      ${row.score}/10 (${row.confidence})`);
  console.log(`Signals:    ${JSON.stringify(row.top_signals)}`);
  console.log(`Narrative:  ${row.narrative}`);
}

await db.end();
process.exit();