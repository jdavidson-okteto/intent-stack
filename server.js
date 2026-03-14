import express from 'express';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const app = express();
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/api/results', async (req, res) => {
  const { rows } = await db.query(`
    SELECT
      a.name,
      a.domain,
      s.score,
      s.top_signals,
      s.confidence,
      s.narrative,
      s.scored_at,
      s.crm_data
    FROM scores s
    JOIN accounts a ON a.id = s.account_id
    ORDER BY s.score DESC, s.scored_at DESC
  `);

  const results = rows.map(r => {
    let apolloData = {};
    try {
      const crm = typeof r.crm_data === 'string'
        ? JSON.parse(r.crm_data)
        : r.crm_data || {};
      apolloData = crm.apollo || {};
    } catch {}
    return { ...r, apollo_data: apolloData };
  });

  res.json(results);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard running at http://localhost:${PORT}`));