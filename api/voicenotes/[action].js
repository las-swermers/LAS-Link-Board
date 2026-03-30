// ═══════════════════════════════════════════════════
// Voice Notes API Router — /api/voicenotes/[action]
// ═══════════════════════════════════════════════════
// Single serverless function that routes to the appropriate handler
// based on the action parameter. Consolidates all voicenotes endpoints
// to stay within Vercel Hobby plan's 12-function limit.

const orahProxy = require('../../lib/voicenotes/orah-proxy');
const sendTransport = require('../../lib/voicenotes/send-transport');
const googleChat = require('../../lib/voicenotes/google-chat');
const chatBot = require('../../lib/voicenotes/chat-bot');
const googleAuth = require('../../lib/voicenotes/google-auth');
const googleAuthCallback = require('../../lib/voicenotes/google-auth-callback');
const createCalendarEvent = require('../../lib/voicenotes/create-calendar-event');

module.exports = async (req, res) => {
  const { action } = req.query;

  switch (action) {
    case 'orah-proxy':
      return orahProxy(req, res);
    case 'send-transport':
      return sendTransport(req, res);
    case 'google-chat':
      return googleChat(req, res);
    case 'chat-bot':
      return chatBot(req, res);
    case 'google-auth':
      return googleAuth(req, res);
    case 'google-auth-callback':
      return googleAuthCallback(req, res);
    case 'create-calendar-event':
      return createCalendarEvent(req, res);
    default:
      return res.status(404).json({ error: 'Unknown action: ' + action });
  }
};
