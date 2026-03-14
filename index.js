import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import pg from 'pg';
import cron from 'node-cron';
import { execSync } from 'child_process';
import 'dotenv/config';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Auto-refresh Salesforce token ───────────────────────────────────────────
function refreshSalesforceToken() {
  try {
    const result = execSync('sf org display --target-org intent-stack --json', {
      encoding: 'utf8'
    });
    const data = JSON.parse(result);
    process.env.SF_ACCESS_TOKEN = data.result.accessToken;
    process.env.SF_INSTANCE_URL = data.result.instanceUrl;
    console.log('Salesforce token refreshed.');
  } catch (err) {
    console.error('Failed to refresh Salesforce token:', err.message);
  }
}

// ─── Your customer list ───────────────────────────────────────────────────────
const CURRENT_CUSTOMERS = [
  'Ruggable', 'Replicated', 'Visible Ideas', 'Quickwork Technologies',
  'Telescope Technology', 'ARMO', 'World 50', 'Exivity', 'Flexera Software',
  'Sirona Medical', 'Kudosity', 'Lawrence Berkeley National Laboratory',
  'Acerta', 'Lema Labs', 'HelloHeart', 'Xapiens International Group',
  'SURFSonar Software', 'CoverWallet', 'Wave Financial', 'Fiverr',
  'iCapital Network', 'Hinge Health', 'monday.com', 'Upwork',
  'Pulsar', 'Yotpo', 'LaunchDarkly', 'ServiceTitan', 'Mercadona', 'Nexxen',
];

// ─── Scoring rubric ───────────────────────────────────────────────────────────
const RUBRIC = `
You are a B2B sales signal evaluator for a developer tooling and platform company called Okteto.
Score accounts 1-10 on purchase intent based on the signals below.

HIGH-INTENT signals (each one increases score significantly):
- Kubernetes confirmed: Apollo tech stack or web signals confirm Kubernetes usage
- Engineering headcount growth 20%+: Apollo shows 6-month headcount growth over 20%
- Active Platform or Developer Experience job posting: Apollo or web signals show hiring for platform engineering, DevEx, internal developer portal, or developer productivity roles
- New Platform or DevEx leader hired: a new VP/Director/Head of Platform, DevEx, or Developer Productivity has joined
- Any Platform or DevEx hire: any engineer hired into a platform, DevEx, or internal tooling role
- Employee from a current Okteto customer has moved to this account: Apollo confirms a person from a customer company now works here
- Previous Salesforce opportunity: this account was in our pipeline before — use the stage, loss reason, and competitors to understand context
- Gong call history: there are recorded conversations with this account — use the call briefs and key points for context
- Recent funding round: Apollo shows funding in the last 6 months
- Born-in-cloud company: founded after 2002 with 300-5000 employees — cloud-native by default, boost score by 1-2 points

LOW-INTENT signals:
- No engineering hiring activity
- Shrinking engineering headcount or layoffs
- No mention of Kubernetes, platform teams, or developer tooling
- Already using a direct competitor with no signs of switching
- Already has an open Salesforce opportunity — account is already in pipeline, flag as "In Pipeline" not a new prospect

Score guide:
- 8-10: Multiple high-intent signals, especially CRM + Apollo signals together
- 5-7: One or two high-intent signals
- 1-4: Low-intent or no signals

Return ONLY valid JSON: { "score": number, "top_signals": string[], "confidence": "high"|"medium"|"low" }
`;

// ─── Auto-prospect from Apollo ────────────────────────────────────────────────
async function prospectNewAccounts() {
  console.log('Prospecting new accounts from Apollo...');

  const allCandidates = [];
  const totalPages = 50;

  // Consultancy/agency keywords to exclude
  const EXCLUDE_KEYWORDS = [
    'consulting', 'consultancy', 'agency', 'advisory', 'services firm',
    'managed services', 'systems integrator', 'staffing', 'outsourcing',
  ];

  for (let page = 1; page <= totalPages; page++) {
    try {
      const res = await axios.post(
        'https://api.apollo.io/api/v1/mixed_companies/search',
        {
          // Geography — US, Canada, Israel, Europe
          organization_locations: [
            'United States',
            'Canada',
            'Israel',
            'United Kingdom',
            'Germany',
            'France',
            'Netherlands',
            'Sweden',
            'Spain',
            'Denmark',
            'Finland',
            'Norway',
            'Switzerland',
            'Poland',
            'Czech Republic',
            'Romania',
            'Portugal',
          ],

          // Company size
          organization_num_employees_ranges: ['201,500', '501,1000', '1001,5000'],

          // Active job postings matching your ICP roles
          q_organization_job_titles: [
            'platform engineer',
            'platform engineering',
            'developer experience',
            'devex engineer',
            'internal developer platform',
            'developer productivity',
            'devops engineer',
            'devops',
          ],

          // Must use mature CI/CD or container tech
          currently_using_any_of_technology_uids: [
            'kubernetes',
            'docker',
            'github_actions',
            'argocd',
            'jenkins',
            'gitlab',
          ],

          per_page: 100,
          page,
        },
        { headers: { 'x-api-key': process.env.APOLLO_API_KEY } }
      );

      const orgs = [
        ...(res.data.organizations || []),
        ...(res.data.accounts || []),
      ];

      console.log(`Page ${page}: ${orgs.length} companies. Total: ${allCandidates.length}`);

      if (orgs.length === 0) {
        console.log('No more results, stopping.');
        break;
      }

      for (const org of orgs) {
        if (!org.primary_domain) continue;

        // Skip consultancies and agencies
        const nameAndKeywords = `${org.name} ${(org.keywords || []).join(' ')}`.toLowerCase();
        if (EXCLUDE_KEYWORDS.some(k => nameAndKeywords.includes(k))) continue;

        let icpScore = 0;
        const employeeCount = org.estimated_num_employees || 0;
        const growth6mo = org.organization_headcount_six_month_growth || 0;
        const growth12mo = org.organization_headcount_twelve_month_growth || 0;
        const foundedYear = org.founded_year || 0;

        // Growth signals
        if (growth12mo >= 0.2) icpScore += 4;   // 20%+ growth in last year — your key signal
        if (growth12mo >= 0.5) icpScore += 2;   // 50%+ bonus
        if (growth6mo >= 0.2) icpScore += 2;    // also growing fast recently

        // Born in cloud
        if (foundedYear >= 2002) icpScore += 2;

        // Sweet spot size
        if (employeeCount >= 300 && employeeCount <= 2000) icpScore += 1;

        // Recent funding
        if (org.latest_funding_round_date) {
          const fundingAge = Date.now() - new Date(org.latest_funding_round_date).getTime();
          if (fundingAge < 180 * 24 * 60 * 60 * 1000) icpScore += 2;
        }

        allCandidates.push({
          name: org.name,
          domain: org.primary_domain,
          icpScore,
        });
      }

      const totalPagesAvailable = res.data.pagination?.total_pages || 0;
      if (page >= totalPagesAvailable) {
        console.log(`Reached last page (${totalPagesAvailable}), stopping.`);
        break;
      }

      await new Promise(r => setTimeout(r, 300));

    } catch (err) {
      console.error(`Apollo page ${page} failed:`, err.message);
      break;
    }
  }

  const top = allCandidates
    .sort((a, b) => b.icpScore - a.icpScore)
    .slice(0, 50);

  console.log(`Top ${top.length} from ${allCandidates.length} total.`);

  await db.query('DELETE FROM accounts WHERE priority = 0');

  let added = 0;
  for (const candidate of top) {
    try {
      await db.query(
        'INSERT INTO accounts (name, domain, priority) VALUES ($1, $2, $3) ON CONFLICT (domain) DO NOTHING',
        [candidate.name, candidate.domain, 0]
      );
      added++;
    } catch (err) {
      console.error(`Failed to insert ${candidate.name}:`, err.message);
    }
  }

  console.log(`Added ${added} fresh prospect accounts.`);
}

// ─── Apollo enrichment ────────────────────────────────────────────────────────
async function enrichFromApollo(domain, accountName) {
  try {
    const orgRes = await axios.post(
      'https://api.apollo.io/api/v1/mixed_companies/search',
      { q_organization_domains_list: [domain], per_page: 1 },
      { headers: { 'x-api-key': process.env.APOLLO_API_KEY } }
    );

    const org = orgRes.data.organizations?.[0] || orgRes.data.accounts?.[0];
    if (!org) return null;

    const jobRes = await axios.post(
      'https://api.apollo.io/api/v1/mixed_companies/search',
      {
        q_organization_domains_list: [domain],
        q_organization_job_titles: [
          'platform engineer', 'developer experience',
          'devex engineer', 'internal developer portal', 'developer productivity',
        ],
        per_page: 1,
      },
      { headers: { 'x-api-key': process.env.APOLLO_API_KEY } }
    );

    const hasDevExJobs = (
      jobRes.data.organizations?.[0]?.num_jobs ||
      jobRes.data.accounts?.[0]?.num_jobs || 0
    ) > 0;

    const customerMatches = [];
    const shuffled = [...CURRENT_CUSTOMERS].sort(() => 0.5 - Math.random()).slice(0, 3);

    for (const customer of shuffled) {
      try {
        const peopleRes = await axios.post(
          'https://api.apollo.io/api/v1/mixed_people/search',
          {
            q_organization_domains_list: [domain],
            q_keywords: customer,
            per_page: 1,
          },
          { headers: { 'x-api-key': process.env.APOLLO_API_KEY } }
        );
        const people = peopleRes.data.people || [];
        if (people.length > 0) {
          customerMatches.push({
            customer,
            person: people[0].name,
            title: people[0].title,
          });
        }
      } catch { /* skip */ }
    }

    const foundedYear = org.founded_year;
    const employeeCount = org.estimated_num_employees;
    const headcount6moGrowth = org.organization_headcount_six_month_growth
      ? Math.round(org.organization_headcount_six_month_growth * 100)
      : null;

    return {
      source: 'apollo',
      company_name: org.name,
      linkedin_url: org.linkedin_url || null,
      founded_year: foundedYear,
      employee_count: employeeCount,
      revenue: org.organization_revenue_printed,
      location: [org.organization_city, org.organization_country].filter(Boolean).join(', '),
      headcount_6mo_growth: headcount6moGrowth,
      technologies: org.technologies?.map(t => t.name) || [],
      uses_kubernetes: org.technologies?.some(t =>
        t.name?.toLowerCase().includes('kubernetes')
      ) || false,
      latest_funding_date: org.latest_funding_round_date,
      latest_funding_amount: org.funding_events?.[0]?.amount,
      active_devex_jobs: hasDevExJobs,
      num_open_jobs: org.num_jobs,
      customer_employee_matches: customerMatches,
      born_in_cloud: foundedYear != null && employeeCount != null &&
        foundedYear >= 2002 && employeeCount >= 300 && employeeCount <= 5000,
    };
  } catch (err) {
    console.error(`Apollo enrichment failed for ${domain}:`, err.message);
    return null;
  }
}

// ─── Salesforce enrichment ────────────────────────────────────────────────────
async function enrichFromSalesforce(domain) {
  try {
    const accountRes = await axios.get(
      `${process.env.SF_INSTANCE_URL}/services/data/v59.0/query`,
      {
        params: { q: `SELECT Id, Name FROM Account WHERE Domain__c = '${domain}' LIMIT 1` },
        headers: { Authorization: `Bearer ${process.env.SF_ACCESS_TOKEN}` },
      }
    );

    const account = accountRes.data.records?.[0];
    if (!account) return null;
    const accountId = account.Id;

    const oppRes = await axios.get(
      `${process.env.SF_INSTANCE_URL}/services/data/v59.0/query`,
      {
        params: {
          q: `SELECT Id, Name, StageName, IsWon, IsClosed,
                     Loss_Reason__c, Loss_Reason_Description__c,
                     CloseDate, Gong__MainCompetitors__c
              FROM Opportunity
              WHERE AccountId = '${accountId}'
              ORDER BY CloseDate DESC LIMIT 1`
        },
        headers: { Authorization: `Bearer ${process.env.SF_ACCESS_TOKEN}` },
      }
    );

    const opp = oppRes.data.records?.[0];

    const gongRes = await axios.get(
      `${process.env.SF_INSTANCE_URL}/services/data/v59.0/query`,
      {
        params: {
          q: `SELECT Id, Name,
                     Gong__Call_Brief__c,
                     Gong__Call_Key_Points__c,
                     Gong__Call_Highlights_Next_Steps__c,
                     Gong__Call_Start__c
              FROM Gong__Gong_Call__c
              WHERE Gong__Primary_Account__c = '${accountId}'
              ORDER BY Gong__Call_Start__c DESC LIMIT 3`
        },
        headers: { Authorization: `Bearer ${process.env.SF_ACCESS_TOKEN}` },
      }
    );

    const calls = gongRes.data.records || [];

return {
  source: 'salesforce',
  account_name: account.Name,
  has_open_opportunity: opp ? !opp.IsClosed : false,
  previous_opportunity: opp ? {
    stage: opp.StageName,
    is_won: opp.IsWon,
    is_lost: opp.IsClosed && !opp.IsWon,
    loss_reason: opp.Loss_Reason__c,
    loss_description: opp.Loss_Reason_Description__c,
    competitors: opp.Gong__MainCompetitors__c,
    close_date: opp.CloseDate,
  } : null,
      gong_calls: calls
        .filter(c =>
          c.Gong__Call_Brief__c &&
          !c.Gong__Call_Brief__c.includes('marked as private')
        )
        .map(c => ({
          title: c.Name,
          date: c.Gong__Call_Start__c,
          brief: c.Gong__Call_Brief__c,
          key_points: c.Gong__Call_Key_Points__c,
          next_steps: c.Gong__Call_Highlights_Next_Steps__c,
        })),
    };
  } catch (err) {
    console.error(`Salesforce enrichment failed for ${domain}:`, err.message);
    return null;
  }
}

// ─── Signal layer ─────────────────────────────────────────────────────────────
function buildQueries(accountName) {
  const shuffled = [...CURRENT_CUSTOMERS].sort(() => 0.5 - Math.random());
  const customerSample = shuffled.slice(0, 2);
  return [
    `"${accountName}" Kubernetes`,
    `"${accountName}" ("platform engineer" OR "developer experience" OR "DevEx" OR "internal developer portal" OR "developer productivity") job hiring`,
    `"${accountName}" engineering hiring growth 2024 2025`,
    `site:linkedin.com "${accountName}" "${customerSample[0]}" OR "${customerSample[1]}"`,
  ];
}

async function fetchSignals(accountId, accountName) {
  const queries = buildQueries(accountName);
  const results = [];

  for (const q of queries) {
    try {
      const { data } = await axios.post(
        'https://google.serper.dev/search',
        { q, num: 3 },
        { headers: { 'X-API-KEY': process.env.SERPER_API_KEY } }
      );
      results.push({
        q,
        hits: data.organic?.slice(0, 3).map(r => ({ title: r.title, snippet: r.snippet })),
      });
    } catch (err) {
      console.error(`Serper failed for "${q}":`, err.message);
      results.push({ q, hits: [] });
    }
  }

  await db.query(
    'INSERT INTO signals (account_id, signals, fetched_at) VALUES ($1, $2, now())',
    [accountId, JSON.stringify(results)]
  );

  return results;
}

// ─── Scoring layer ────────────────────────────────────────────────────────────
async function scoreAccount(accountName, signals, crmData) {
  const res = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: RUBRIC,
    messages: [{
      role: 'user',
      content: `Account: ${accountName}
Web signals: ${JSON.stringify(signals)}
CRM data: ${JSON.stringify(crmData)}`,
    }],
  });

  const text = res.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON found in response: ${text}`);
  return JSON.parse(match[0]);
}

// ─── Narrative layer ──────────────────────────────────────────────────────────
async function generateNarrative(accountName, signals, crmData, score) {
  const res = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `You are writing a rep briefing for Okteto, a developer platform company.

STRICT FORMATTING RULES — follow exactly:
- Do NOT include any title, header, company name, score line, or preamble
- Do NOT use any markdown — no **, no ##, no *, no ---, no #
- Do NOT number the sections
- Start your response with exactly "Why this account:" on its own line
- Then write 3-4 plain sentences
- Then write "Why now:" on its own line
- Then write 3-4 plain sentences
- Nothing else before, after, or between

Content rules:
- If there is a previous Salesforce opportunity, reference what happened and why now is different
- If there are Gong call briefs, reference specific things that were discussed
- If Apollo shows Kubernetes in the tech stack, mention it specifically
- If Apollo shows a customer employee match, name the person and their previous company
- If Apollo shows recent funding, reference it as a reason timing is right
- Be specific, never generic. Every claim must be grounded in the data below

Account: ${accountName}
Score: ${score.score}/10
Top signals: ${score.top_signals.join(', ')}
Web signals: ${JSON.stringify(signals.slice(0, 2))}
CRM data: ${JSON.stringify(crmData)}`,
    }],
  });

  return res.content[0].text;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────
async function runPipeline() {
  refreshSalesforceToken();
  console.log('Pipeline started...');

  // Step 1: auto-prospect top candidates from Apollo
  await prospectNewAccounts();

  // Step 2: clear today's scores
  await db.query(`DELETE FROM scores WHERE scored_at::date = CURRENT_DATE`);

  // Step 3: score top 10 from freshly prospected list
  const { rows: accounts } = await db.query(
    'SELECT * FROM accounts ORDER BY priority DESC LIMIT 10'
  );

  const scores = [];

  for (const account of accounts) {
    try {
      console.log(`Processing ${account.name}...`);

      const [signals, apolloData, salesforceData] = await Promise.all([
        fetchSignals(account.id, account.name),
        enrichFromApollo(account.domain, account.name),
        enrichFromSalesforce(account.domain),
      ]);

      const crmData = { apollo: apolloData, salesforce: salesforceData };
      const score = await scoreAccount(account.name, signals, crmData);

      await db.query(
        `INSERT INTO scores (account_id, score, top_signals, confidence, crm_data)
         VALUES ($1, $2, $3, $4, $5)`,
        [account.id, score.score, JSON.stringify(score.top_signals), score.confidence, JSON.stringify(crmData)]
      );

      scores.push({ account, score, signals, crmData });
      console.log(`Scored ${account.name}: ${score.score}/10`);
    } catch (err) {
      console.error(`Failed on ${account.name}:`, err.message);
    }
  }

  // Step 4: narratives for top 10
  const top = scores
    .sort((a, b) => b.score.score - a.score.score)
    .slice(0, 10);

  for (const { account, score, signals, crmData } of top) {
    try {
      const narrative = await generateNarrative(account.name, signals, crmData, score);

      await db.query(
        `UPDATE scores SET narrative = $1
         WHERE account_id = $2
         AND scored_at = (SELECT MAX(scored_at) FROM scores WHERE account_id = $2)`,
        [narrative, account.id]
      );

      console.log(`Narrative written for ${account.name}`);
    } catch (err) {
      console.error(`Narrative failed for ${account.name}:`, err.message);
    }
  }

  console.log('Pipeline complete.');
}

runPipeline();