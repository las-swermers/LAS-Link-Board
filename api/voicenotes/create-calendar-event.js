// ═══════════════════════════════════════════════════
// Create Calendar Event — POST /api/voicenotes/create-calendar-event
// ═══════════════════════════════════════════════════
//
// Creates a Google Calendar event using stored OAuth tokens.
// Automatically refreshes expired access tokens.
//
// Request: JSON { transport_request, calendar_ids: ["primary", "other@group..."] }
// Auth: Bearer token from Supabase session

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing auth' });
  const token = auth.replace('Bearer ', '');

  let userId;
  try {
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + token }
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Invalid session' });
    const user = await userRes.json();
    userId = user.id;
  } catch (e) {
    return res.status(401).json({ error: 'Auth failed' });
  }

  const { transport_request, calendar_ids } = req.body || {};
  if (!transport_request) return res.status(400).json({ error: 'Missing transport_request' });

  // Get stored Google tokens
  let settings;
  try {
    const sRes = await fetch(
      SUPABASE_URL + '/rest/v1/orah_settings?user_id=eq.' + userId + '&limit=1',
      { headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY } }
    );
    const rows = sRes.ok ? await sRes.json() : [];
    settings = rows[0];
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load settings' });
  }

  if (!settings || !settings.google_refresh_token) {
    return res.status(400).json({ error: 'Google Calendar not connected. Go to Settings → Integrations → Connect Google Calendar.' });
  }

  // Get valid access token (refresh if expired)
  let accessToken = settings.google_access_token;
  const isExpired = !settings.google_token_expiry || new Date(settings.google_token_expiry) <= new Date();

  if (isExpired) {
    try {
      const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: settings.google_refresh_token,
          grant_type: 'refresh_token'
        }).toString()
      });
      if (!refreshRes.ok) {
        return res.status(401).json({ error: 'Google token refresh failed. Please reconnect Google Calendar.' });
      }
      const newTokens = await refreshRes.json();
      accessToken = newTokens.access_token;

      // Update stored token
      await fetch(SUPABASE_URL + '/rest/v1/orah_settings?user_id=eq.' + userId, {
        method: 'PATCH',
        headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          google_access_token: accessToken,
          google_token_expiry: new Date(Date.now() + (newTokens.expires_in || 3600) * 1000).toISOString()
        })
      });
    } catch (e) {
      return res.status(502).json({ error: 'Token refresh error: ' + e.message });
    }
  }

  // Build the calendar event
  const tr = transport_request;
  const type = (tr.appointment_type || 'Other').charAt(0).toUpperCase() + (tr.appointment_type || 'other').slice(1);
  const event = {
    summary: 'Transport: ' + tr.student_name + ' — ' + type,
    description: 'Student: ' + tr.student_name +
      (tr.student_house ? '\nHouse: ' + tr.student_house : '') +
      (tr.student_year ? '\nYear: ' + tr.student_year : '') +
      '\n\nAppointment: ' + type +
      '\nPickup: ' + (tr.pickup_location || 'School Reception') +
      '\nDestination: ' + (tr.destination || 'TBD') +
      (tr.appointment_details ? '\n\nDetails: ' + tr.appointment_details : '') +
      (tr.special_instructions ? '\n\nInstructions: ' + tr.special_instructions : '') +
      '\n\n— Created via LAS LinkBoard',
    location: tr.destination || '',
    start: {
      dateTime: tr.date_time || new Date().toISOString(),
      timeZone: 'Europe/Zurich'
    },
    end: {
      dateTime: tr.return_time || new Date(new Date(tr.date_time || Date.now()).getTime() + 2 * 3600000).toISOString(),
      timeZone: 'Europe/Zurich'
    },
    colorId: getColorId(tr.appointment_type)
  };

  // Create event on each specified calendar (default to primary)
  const calendars = (calendar_ids && calendar_ids.length > 0) ? calendar_ids : ['primary'];
  const results = [];

  for (const calId of calendars) {
    try {
      const calRes = await fetch(
        'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calId) + '/events',
        {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + accessToken,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(event)
        }
      );
      if (calRes.ok) {
        const created = await calRes.json();
        results.push({ calendar: calId, eventId: created.id, link: created.htmlLink, status: 'created' });
      } else {
        const errText = await calRes.text();
        results.push({ calendar: calId, error: errText, status: 'failed' });
      }
    } catch (e) {
      results.push({ calendar: calId, error: e.message, status: 'failed' });
    }
  }

  return res.status(200).json({ success: true, results });
};

function getColorId(type) {
  const map = { medical: '11', dental: '6', specialist: '5', therapy: '7', legal: '9', family: '10' };
  return map[(type || '').toLowerCase()] || '1';
}
