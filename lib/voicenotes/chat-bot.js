// ═══════════════════════════════════════════════════
// Google Chat Bot — POST /api/voicenotes/chat-bot
// ═══════════════════════════════════════════════════
//
// HTTP endpoint for a Google Chat App. Receives interaction
// events (messages, added to space) and responds.
//
// Supports:
//   "transport today" / "transport tomorrow" / "transport [date]"
//   "add note [text]" / "note [text]" / just any text → creates to-do
//   #category hashtags for categorization
//   @student mentions for tagging
//
// Setup: Register as a Chat App in Google Cloud Console
//   → Chat API → Configuration → HTTP endpoint URL
//   → Point to: https://las-link-board.vercel.app/api/voicenotes/chat-bot

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pmhoeqxuamvqlwsatozu.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

module.exports = async (req, res) => {
  // Wrap everything in try/catch — Google Chat shows "not responding" if we crash
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Parse body if Vercel hasn't auto-parsed it ──
  // Google Chat sends application/json but Vercel's body parser may not
  // handle it for dynamic [action] routes. Manually parse if needed.
  let body = req.body;
  if (!body || (typeof body === 'object' && !body.type)) {
    // Body might be a string, a Buffer, or not parsed at all
    try {
      if (typeof body === 'string') {
        body = JSON.parse(body);
      } else if (Buffer.isBuffer(body)) {
        body = JSON.parse(body.toString('utf8'));
      } else if (!body || Object.keys(body).length === 0) {
        // Try reading the raw stream
        const chunks = [];
        await new Promise((resolve, reject) => {
          req.on('data', chunk => chunks.push(chunk));
          req.on('end', resolve);
          req.on('error', reject);
        });
        if (chunks.length > 0) {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
      }
    } catch (parseErr) {
      console.error('Body parse error:', parseErr.message, '| raw body type:', typeof req.body);
      return res.status(200).json({ text: 'Failed to parse request body.' });
    }
  }

  if (!SERVICE_KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY not set in Vercel environment');
    return res.status(200).json({ text: 'Bot configuration error: SUPABASE_SERVICE_ROLE_KEY not set. Add it in Vercel Settings → Environment Variables.' });
  }

  const event = body || {};

  // ── Normalize event format ──
  // Google Chat Apps configured as "Workspace Add-on" or using the newer API
  // nest chat data under event.chat (with commonEventObject, authorizationEventObject).
  // Classic Chat App HTTP endpoints send type/message/user/space at top level.
  // Support both formats.
  let chatEvent;
  if (event.chat) {
    // Workspace Add-on / newer format: data is inside event.chat
    chatEvent = event.chat;
  } else if (event.type) {
    // Classic Chat App format: data is at top level
    chatEvent = event;
  } else {
    // Unknown format — log it and respond gracefully
    console.error('Unknown event format. Keys:', Object.keys(event).join(','));
    return res.status(200).json({ text: 'Received event in an unrecognized format.' });
  }

  const eventType = chatEvent.type || '';
  const spaceType = (chatEvent.space && chatEvent.space.type) || '';
  const chatUser = chatEvent.user || (event.commonEventObject && event.commonEventObject.userLocale ? null : null) || {};

  console.log('Chat bot event:', eventType, '| space:', spaceType, '| user:', chatUser.email || 'unknown');

  // ─── ADDED_TO_SPACE ───
  if (eventType === 'ADDED_TO_SPACE') {
    return res.json({
      text: 'Hi! I\'m LinkBoard. I can help you manage transport requests and to-do notes.\n\n' +
        '*Commands:*\n' +
        '• `transport today` — see today\'s transport requests\n' +
        '• `transport tomorrow` — see tomorrow\'s\n' +
        '• `transport [date]` — e.g. "transport March 30"\n' +
        '• `note [text]` — add a to-do note (use #category and @student)\n' +
        '• `help` — show this message again'
    });
  }

  // ─── REMOVED_FROM_SPACE ───
  if (eventType === 'REMOVED_FROM_SPACE') {
    return res.status(200).end();
  }

  // ─── MESSAGE ───
  if (eventType === 'MESSAGE') {
    const message = chatEvent.message || {};
    const rawText = (message.text || '').trim();
    const sender = chatEvent.user || {};
    const senderEmail = sender.email || '';
    const isGroup = spaceType === 'ROOM' || spaceType === 'SPACE';

    // Strip bot mention if present (e.g., "@LinkBoard transport today")
    const cleanText = rawText.replace(/@\S+\s*/g, '').trim();
    const lowerText = cleanText.toLowerCase();

    // ── Google Chat registered slash commands ──
    // When the user picks a registered slash command (e.g. /medical, /transport),
    // Google Chat sends message.slashCommand with a commandId, and the
    // arguments are in message.argumentText (text AFTER the command name).
    const slashCommand = message.slashCommand;
    if (slashCommand) {
      // Extract the command name from the annotations or from the text
      let commandName = '';
      const annotations = message.annotations || [];
      for (const ann of annotations) {
        if (ann.type === 'SLASH_COMMAND' && ann.slashCommand) {
          commandName = (ann.slashCommand.commandName || '').replace(/^\//, '').toLowerCase();
          break;
        }
      }
      // Fallback: parse command name from message text
      if (!commandName) {
        const cmdMatch = rawText.match(/^\/(\w[\w-]*)/);
        commandName = cmdMatch ? cmdMatch[1].toLowerCase() : '';
      }

      const argText = (message.argumentText || '').trim();

      // /transport → show transport requests
      if (commandName === 'transport') {
        const transportQuery = argText ? 'transport ' + argText : 'transport today';
        return await handleTransportQuery(res, senderEmail, transportQuery, isGroup);
      }

      // /help
      if (commandName === 'help') {
        return res.json({
          text: '*LinkBoard Commands:*\n' +
            '• `/transport today` — today\'s transport requests\n' +
            '• `/transport tomorrow` — tomorrow\'s requests\n' +
            '• `/transport [date]` — e.g. "/transport March 30"\n' +
            '• `/medical Check prescription for Sarah` — add note to Medical category\n' +
            '• `/admin Order new supplies` — add note to Admin category\n' +
            '• `/general` `/followup` — any category name works\n' +
            '• `note [text]` — add a to-do note (uncategorized)\n' +
            '• Use `@student name` to tag a student'
        });
      }

      // /note → generic note command; first word can be a category name
      // e.g. "/note medical Check prescription" or "/note Pick up supplies"
      if (commandName === 'note' || commandName === 'add') {
        if (!argText) {
          return res.json({
            text: 'Please include note text.\n' +
              'Example: `/note medical Check prescription for Sarah`\n' +
              'Or just: `/note Pick up supplies`'
          });
        }
        // Try to match first word as a category
        const firstWordMatch = argText.match(/^(\w[\w-]*)\s+([\s\S]+)/);
        if (firstWordMatch) {
          const possibleCat = firstWordMatch[1].toLowerCase().replace(/-/g, ' ');
          const remainder = firstWordMatch[2].trim();
          // Check if the first word matches an existing category
          const userId = await findUserByEmail(senderEmail);
          if (userId) {
            const catId = await findCategoryByName(userId, possibleCat);
            if (catId) {
              return await handleCreateNote(res, senderEmail, remainder, possibleCat);
            }
          }
        }
        // No category match — create uncategorized note with full text
        return await handleCreateNote(res, senderEmail, argText);
      }

      // Any other slash command → treat as a note category
      if (commandName) {
        const catName = commandName.replace(/-/g, ' ');
        if (argText) {
          return await handleCreateNote(res, senderEmail, argText, catName);
        } else {
          return res.json({
            text: 'Please include a note after the command.\n' +
              'Example: `/' + commandName + ' Check prescription for Sarah`'
          });
        }
      }
    }

    // ── Transport query (plain text) ──
    if (lowerText.startsWith('transport')) {
      return await handleTransportQuery(res, senderEmail, cleanText, isGroup);
    }

    // ── Help ──
    if (lowerText === 'help' || lowerText === 'commands') {
      return res.json({
        text: '*LinkBoard Commands:*\n' +
          '• `/transport today` — today\'s transport requests\n' +
          '• `/transport tomorrow` — tomorrow\'s requests\n' +
          '• `/transport [date]` — e.g. "/transport March 30"\n' +
          '• `/medical Check prescription for Sarah` — add note to Medical category\n' +
          '• `/admin Order new supplies` — add note to Admin category\n' +
          '• `/general` `/followup` — any category name works\n' +
          '• `note [text]` — add a to-do note (uncategorized)\n' +
          '• Use `@student name` to tag a student'
      });
    }

    // ── Slash category commands typed as text: /medical note text, /admin note text ──
    const slashWithText = cleanText.match(/^\/(\w[\w-]*)\s+([\s\S]+)/);
    if (slashWithText) {
      const slashCat = slashWithText[1].toLowerCase().replace(/-/g, ' ');
      const slashNote = slashWithText[2].trim();
      return await handleCreateNote(res, senderEmail, slashNote, slashCat);
    }

    // ── Slash category without text: /medical (no note body) ──
    const slashOnly = cleanText.match(/^\/(\w[\w-]*)$/);
    if (slashOnly) {
      const cmdName = slashOnly[1].toLowerCase();
      // /transport without args → show today's requests
      if (cmdName === 'transport') {
        return await handleTransportQuery(res, senderEmail, 'transport today', isGroup);
      }
      return res.json({
        text: 'Please include a note after the command.\n' +
          'Example: `/' + cmdName + ' Check prescription for Sarah`'
      });
    }

    // ── Create note (explicit or default) ──
    let noteText = cleanText;
    if (lowerText.startsWith('note ')) noteText = cleanText.substring(5).trim();
    else if (lowerText.startsWith('add note ')) noteText = cleanText.substring(9).trim();
    else if (lowerText.startsWith('add ')) noteText = cleanText.substring(4).trim();

    if (noteText) {
      return await handleCreateNote(res, senderEmail, noteText);
    }

    return res.json({ text: 'I didn\'t understand that. Type `help` to see available commands.' });
  }

  // ─── CARD_CLICKED (future: interactive buttons) ───
  if (eventType === 'CARD_CLICKED') {
    return res.json({ text: 'Action received.' });
  }

  return res.status(200).json({ text: 'Message received.' });

  } catch (err) {
    // Always return a valid response so Google Chat doesn't show "not responding"
    console.error('Chat bot error:', err);
    return res.status(200).json({ text: 'Something went wrong. Error: ' + (err.message || 'Unknown error') });
  }
};

// ─── Transport Query Handler ───
// isGroup: when true (group space), show ALL transport requests for the date
async function handleTransportQuery(res, senderEmail, text, isGroup) {
  const targetDate = parseDateFromText(text);
  const dateStr = targetDate.toISOString().split('T')[0];
  const nextDay = new Date(targetDate);
  nextDay.setDate(nextDay.getDate() + 1);
  const nextDateStr = nextDay.toISOString().split('T')[0];

  // Build query — in group spaces show all requests, in DMs show only the user's
  let queryUrl = SUPABASE_URL + '/rest/v1/transport_requests?' +
    'date_time=gte.' + dateStr + 'T00:00:00&date_time=lt.' + nextDateStr + 'T00:00:00' +
    '&order=date_time.asc';

  if (!isGroup) {
    // DM — scope to user's requests
    const userId = await findUserByEmail(senderEmail);
    if (!userId) {
      return res.json({ text: 'I couldn\'t find your LinkBoard account. Make sure you\'re signed up with the same email.' });
    }
    queryUrl += '&user_id=eq.' + userId;
  }

  // Query transport requests for that date
  try {
    const trRes = await fetch(queryUrl, {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY }
    });

    if (!trRes.ok) {
      return res.json({ text: 'Failed to load transport requests. Please try again.' });
    }

    const requests = await trRes.json();
    const dateLabel = targetDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    if (requests.length === 0) {
      return res.json({ text: `No transport requests for *${dateLabel}*.` });
    }

    // Build a card with the day's requests
    const widgets = requests.map(tr => {
      const time = tr.date_time ? new Date(tr.date_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'TBD';
      const type = (tr.appointment_type || 'other').charAt(0).toUpperCase() + (tr.appointment_type || 'other').slice(1);
      return {
        decoratedText: {
          topLabel: time + ' — ' + type,
          text: '<b>' + (tr.student_name || 'Unknown') + '</b>' +
            (tr.student_house ? ' (' + tr.student_house + ')' : '') +
            ' → ' + (tr.destination || 'TBD'),
          wrapText: true
        }
      };
    });

    return res.json({
      cardsV2: [{
        cardId: 'transport_digest_' + dateStr,
        card: {
          header: {
            title: 'Transport Requests',
            subtitle: dateLabel + ' — ' + requests.length + ' request(s)',
            imageUrl: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/directions_car/default/48px.svg',
            imageType: 'CIRCLE'
          },
          sections: [{ widgets }]
        }
      }]
    });

  } catch (e) {
    return res.json({ text: 'Error loading transport requests: ' + e.message });
  }
}

// ─── Create Note Handler ───
async function handleCreateNote(res, senderEmail, text, forceCategoryName) {
  const userId = await findUserByEmail(senderEmail);
  if (!userId) {
    return res.json({ text: 'I couldn\'t find your LinkBoard account. Make sure you\'re signed up with the same email.' });
  }

  // Parse hashtag category or use forced category from slash command
  let categoryId = null;
  let categoryLabel = '';
  let cleanText = text;

  // Slash command category takes priority (e.g., /medical)
  const catNameToFind = forceCategoryName || null;
  const hashMatch = !catNameToFind ? text.match(/#(\w+)/) : null;
  const searchCatName = catNameToFind || (hashMatch ? hashMatch[1].toLowerCase() : null);

  if (hashMatch) cleanText = text.replace(/#\w+/g, '').trim();

  if (searchCatName) {
    try {
      // Search with ilike for fuzzy match (e.g., "followup" matches "Follow-up")
      const catRes = await fetch(
        SUPABASE_URL + '/rest/v1/todo_categories?user_id=eq.' + userId + '&name=ilike.*' + encodeURIComponent(searchCatName) + '*',
        { headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY } }
      );
      if (catRes.ok) {
        const cats = await catRes.json();
        if (cats.length > 0) {
          categoryId = cats[0].id;
          categoryLabel = cats[0].name;
        }
      }
    } catch (e) { /* skip categorization */ }
  }

  // Parse @student mention
  let taggedStudent = '';
  const atMatch = text.match(/@([\w\s]+?)(?=\s*[#,.\n]|$)/);
  if (atMatch) {
    taggedStudent = atMatch[1].trim();
    cleanText = cleanText.replace(/@[\w\s]+/, '').trim();
  }

  const title = cleanText.split(/[.!?\n]/)[0].substring(0, 80);

  // Create the note
  try {
    const noteRes = await fetch(SUPABASE_URL + '/rest/v1/voice_notes', {
      method: 'POST',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        user_id: userId,
        transcript: cleanText,
        title: title,
        category_id: categoryId,
        tagged_student: taggedStudent,
        priority: 'normal',
        status: 'pending'
      })
    });

    if (noteRes.ok) {
      const catLabel = categoryLabel ? ' → ' + categoryLabel : (categoryId ? '' : ' (uncategorized)');
      const studentLabel = taggedStudent ? ' — tagged: ' + taggedStudent : '';
      return res.json({
        text: 'Note added: *' + title + '*' + catLabel + studentLabel
      });
    } else {
      return res.json({ text: 'Failed to save note. Please try again.' });
    }
  } catch (e) {
    return res.json({ text: 'Error creating note: ' + e.message });
  }
}

// ─── Helpers ───

// Check if a category name exists for a user (fuzzy match).
// Returns the category id if found, null otherwise.
async function findCategoryByName(userId, name) {
  if (!userId || !name) return null;
  try {
    const catRes = await fetch(
      SUPABASE_URL + '/rest/v1/todo_categories?user_id=eq.' + userId + '&name=ilike.*' + encodeURIComponent(name) + '*&limit=1',
      { headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY } }
    );
    if (catRes.ok) {
      const cats = await catRes.json();
      return cats.length > 0 ? cats[0].id : null;
    }
  } catch (e) { /* not found */ }
  return null;
}

async function findUserByEmail(email) {
  if (!email) return null;
  try {
    const res = await fetch(
      SUPABASE_URL + '/auth/v1/admin/users',
      {
        headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY }
      }
    );
    if (res.ok) {
      const data = await res.json();
      const users = data.users || data || [];
      const user = users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
      return user ? user.id : null;
    }
  } catch (e) {
    console.error('User lookup failed:', e.message);
  }
  return null;
}

function parseDateFromText(text) {
  const lower = text.toLowerCase();

  // "transport today"
  if (lower.includes('today')) return startOfDay(new Date());

  // "transport tomorrow"
  if (lower.includes('tomorrow')) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return startOfDay(d);
  }

  // "transport monday" / "transport tuesday" etc.
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < days.length; i++) {
    if (lower.includes(days[i])) {
      const d = new Date();
      const today = d.getDay();
      const diff = (i - today + 7) % 7 || 7; // next occurrence
      d.setDate(d.getDate() + diff);
      return startOfDay(d);
    }
  }

  // "transport March 30" / "transport 30 March" / "transport 2026-03-30"
  // Try to parse a date from the text after "transport"
  const dateStr = text.replace(/^transport\s*/i, '').trim();
  if (dateStr) {
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) return startOfDay(parsed);
  }

  // Default to today
  return startOfDay(new Date());
}

function startOfDay(d) {
  d.setHours(0, 0, 0, 0);
  return d;
}
