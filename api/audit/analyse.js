// ═══════════════════════════════════════════════════
// Orah Audit — Analyse — POST /api/audit/analyse
// ═══════════════════════════════════════════════════
//
// Receives an anonymised statistics summary (no PII —
// counts, rates, and gap metrics only) from the browser,
// calls Claude to generate structured audit findings,
// and returns a findings JSON object.
//
// GDPR COMPLIANCE: This route receives only aggregated
// statistics. No student names, IDs, emails, or other
// PII are accepted or logged. Intentional by design.
//
// Request: JSON { stats, score, school }
//   stats  — anonymised data summary object (counts/rates)
//   score  — pre-calculated health score (0–100)
//   school — school identifier string (e.g. "LAS")
//
// Response: JSON {
//   score, critical[], warnings[], strengths[],
//   pulseReadiness
// }
//
// Finding shape: { title, detail, module, metric }
//   module: 'students'|'pastoral'|'leave'|'location'|'rolls'|'api'
//
// Auth: Uses the user's own Anthropic API key from
// voicetype_settings (same as all other AI features).

const { decrypt } = require('../voicetype/crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function buildPrompt(stats, score, school) {
  const s = stats;

  const lines = [
    `You are an expert boarding school operations consultant auditing ${school}'s use of Orah boarding management software.`,
    '',
    'Below is an anonymised usage statistics summary. No student names, emails, or PII are present — only counts and rates.',
    '',
    '── STUDENTS ──',
    `Total active students: ${s.students?.total ?? 'unknown'}`,
    `Houses: ${s.students?.houseCount ?? 'unknown'}`,
    `Missing room_number: ${s.students?.missingRoom ?? 0}`,
    `Missing medical_info: ${s.students?.missingMedical ?? 0}`,
    `Missing diet_info: ${s.students?.missingDiet ?? 0}`,
    `Missing year_level: ${s.students?.missingYearLevel ?? 0}`,
    `No photo: ${s.students?.noPhoto ?? 0}`,
    `Unassigned to house: ${s.students?.noHouse ?? 0}`,
    `International students: ${s.students?.international ?? 0}`,
    '',
    '── PASTORAL NOTES (last 90 days) ──',
    `Total notes: ${s.pastoral?.total ?? 0}`,
    `Students with 0 notes this term: ${s.pastoral?.zeroNoteStudents ?? 0}`,
    `Students with 0 notes in last 30 days: ${s.pastoral?.zeroNotes30d ?? 0}`,
    `Category distribution: ${JSON.stringify(s.pastoral?.categoryDistribution ?? {})}`,
    `Severity distribution: ${JSON.stringify(s.pastoral?.severityDistribution ?? {})}`,
    `High-severity notes with no follow-up: ${s.pastoral?.highNoFollowUp ?? 0}`,
    `Boarding staff writing notes: ${s.pastoral?.staffActive ?? 0} of ${s.pastoral?.staffTotal ?? 0}`,
    `House note rates (notes/student): ${JSON.stringify(s.pastoral?.houseRates ?? {})}`,
    `School average notes/student: ${s.pastoral?.avgPerStudent ?? 0}`,
    '',
    '── LEAVE ──',
    `Total leave requests: ${s.leave?.total ?? 0}`,
    `Missing return time: ${s.leave?.missingReturn ?? 0}`,
    `No approver recorded: ${s.leave?.noApprover ?? 0}`,
    `Approved same-day: ${s.leave?.sameDay ?? 0}`,
    `Pending >48h: ${s.leave?.pendingOld ?? 0}`,
    `Leave type distribution: ${JSON.stringify(s.leave?.typeDistribution ?? {})}`,
    `Students with top-10% leave frequency: ${s.leave?.highFrequencyStudents ?? 0}`,
    '',
    '── LOCATION ──',
    `Students with no location update in 7+ days: ${s.location?.gapOver7d ?? 0}`,
    `Students off-campus with no associated leave: ${s.location?.offCampusNoLeave ?? 0}`,
    `Students with conflicting simultaneous records: ${s.location?.conflicting ?? 0}`,
    '',
    '── ATTENDANCE ROLLS ──',
    `Average roll-checks per day: ${s.rolls?.avgPerDay ?? 0}`,
    `Houses with roll frequency <4/day: ${JSON.stringify(s.rolls?.lowFrequencyHouses ?? [])}`,
    `Rolls taken outside expected time window: ${s.rolls?.outOfWindow ?? 0}`,
    `Students absent with no explanation: ${s.rolls?.unexplainedAbsences ?? 0}`,
    '',
    '── API SECURITY ──',
    'KNOWN ISSUE: The "students_sync" API key is 1,798 days old (created ~2019) with no IP whitelist. Flag as critical.',
    `Additional keys >180 days: ${s.apiKeys?.oldKeys ?? 0}`,
    `Keys with no IP whitelist: ${s.apiKeys?.noWhitelist ?? 0}`,
    '',
    `── PRE-CALCULATED HEALTH SCORE: ${score}/100 ──`,
    'The score was calculated using these deductions from 100:',
    '  −15: Known old API key (students_sync)',
    '  −10: No IP whitelist on any key',
    '  −10: >10% students with 0 pastoral notes this term',
    '  −15: >15% students with location gap >7 days',
    '   −8: <70% boarding staff writing pastoral notes',
    '   −8: >5% leave requests missing return time',
    '  −10: Pastoral notes <2/student/month average',
    '   −8: Roll checks <4/day average in any house',
    '',
    'Adjust the score slightly (±5 max) if you see strong mitigating or compounding factors. Justify briefly in a finding.',
    '',
    '── YOUR TASK ──',
    'Return ONLY a valid JSON object (no markdown, no explanation outside the JSON) in exactly this shape:',
    '',
    JSON.stringify({
      score: 72,
      critical: [{ title: 'Example critical', detail: 'Explanation.', module: 'api', metric: '1 key (1,798 days old)' }],
      warnings: [{ title: 'Example warning', detail: 'Explanation.', module: 'pastoral', metric: '23 students' }],
      strengths: [{ title: 'Example strength', detail: 'What is working well.', module: 'students', metric: '247 of 247 assigned to house' }],
      pulseReadiness: 'One paragraph assessing whether the data quality is sufficient to build the Pulse Student Insights Dashboard on, and what should be fixed first.'
    }, null, 2),
    '',
    'Rules:',
    '- critical: issues requiring immediate action (score impact ≥10 or safety risk)',
    '- warnings: issues that degrade data quality or workflow (score impact <10)',
    '- strengths: at least 2 things that are working well',
    '- pulseReadiness: specific, actionable paragraph about Pulse build readiness',
    '- module must be one of: students, pastoral, leave, location, rolls, api',
    '- metric must be a short quantified string (e.g. "31 of 247 students (13%)")',
    '- Output ONLY the JSON object. No text before or after it.'
  ];

  return lines.join('\n');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth — verify Supabase session and get user ID
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const token = auth.replace('Bearer ', '');
  let user;
  try {
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + token }
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Invalid session' });
    user = await userRes.json();
  } catch {
    return res.status(401).json({ error: 'Auth check failed' });
  }
  if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });

  // Fetch user's Anthropic API key from voicetype_settings (same as all AI features)
  const apiHeaders = {
    'apikey': SERVICE_KEY,
    'Authorization': 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json'
  };
  let anthropicKey = '';
  let anthropicBaseUrl = '';
  try {
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/voicetype_settings?user_id=eq.' + user.id + '&select=anthropic_api_key,anthropic_base_url&limit=1',
      { headers: apiHeaders }
    );
    if (r.ok) {
      const rows = await r.json();
      if (rows.length > 0) {
        anthropicKey = decrypt(rows[0].anthropic_api_key || '');
        anthropicBaseUrl = rows[0].anthropic_base_url || '';
      }
    }
  } catch {
    // will fail below if key is missing
  }

  if (!anthropicKey) {
    return res.status(400).json({ error: 'No Anthropic API key found. Add one in Settings → VoiceType to use the audit tool.' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { stats, score, school } = body || {};

  if (!stats || score === undefined) {
    return res.status(400).json({ error: 'Missing stats or score' });
  }

  const prompt = buildPrompt(stats, score, school || 'LAS');

  try {
    const claudeUrl = (anthropicBaseUrl || 'https://api.anthropic.com') + '/v1/messages';
    const claudeRes = await fetch(claudeUrl, {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return res.status(502).json({ error: 'Claude API error ' + claudeRes.status + ': ' + errText.slice(0, 200) });
    }

    const claudeData = await claudeRes.json();
    const raw = (claudeData.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Extract JSON from response (handle any accidental leading/trailing text)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(502).json({ error: 'Claude returned non-JSON response' });
    }

    let findings;
    try {
      findings = JSON.parse(jsonMatch[0]);
    } catch (e) {
      return res.status(502).json({ error: 'Failed to parse Claude JSON: ' + e.message });
    }

    // Validate expected shape
    const required = ['score', 'critical', 'warnings', 'strengths', 'pulseReadiness'];
    for (const key of required) {
      if (findings[key] === undefined) {
        return res.status(502).json({ error: 'Claude response missing field: ' + key });
      }
    }

    return res.json(findings);

  } catch (e) {
    return res.status(500).json({ error: 'Analysis failed: ' + e.message });
  }
};
