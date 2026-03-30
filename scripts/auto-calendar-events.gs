/**
 * ═══════════════════════════════════════════════════════════════
 * LinkBoard — Auto-Add Transport Events to Google Calendar
 * ═══════════════════════════════════════════════════════════════
 *
 * SETUP:
 * 1. Open https://script.google.com and create a new project
 * 2. Paste this entire file into Code.gs
 * 3. Update the CONFIG section below
 * 4. Deploy → New deployment → Web app
 *    - Execute as: Me (your school account)
 *    - Who has access: Anyone (or Anyone within your org)
 * 5. Copy the Web app URL
 * 6. In LinkBoard → Settings → Integrations → set the
 *    "Calendar Apps Script URL" to the web app URL
 *
 * When a transport request is submitted, LinkBoard will POST
 * event data to this script, which creates events on the
 * specified calendar(s) automatically.
 */

// ─── CONFIG ───
const CONFIG = {
  // Add your calendar IDs here. Events will be created on ALL of them.
  // Find Calendar ID: Google Calendar → Settings → click calendar → Calendar ID
  CALENDARS: [
    { id: 'primary', label: 'My Calendar' }
    // Add more:
    // { id: 'transport@group.calendar.google.com', label: 'Transport' },
    // { id: 'nurse@group.calendar.google.com', label: 'Nurse' },
  ],

  // Timezone for events
  TIMEZONE: 'Europe/Zurich',

  // Secret token to verify requests come from LinkBoard (set this to a random string)
  SECRET: 'change-me-to-a-random-string'
};

/**
 * Handle POST requests from LinkBoard
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // Verify secret
    if (data.secret !== CONFIG.SECRET) {
      return ContentService.createTextOutput(JSON.stringify({ error: 'Invalid secret' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const tr = data.transport_request;
    if (!tr || !tr.student_name) {
      return ContentService.createTextOutput(JSON.stringify({ error: 'Missing transport data' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const results = [];

    // Create event on each configured calendar
    CONFIG.CALENDARS.forEach(function(cal) {
      try {
        const event = createTransportEvent(cal.id, tr);
        results.push({ calendar: cal.label, eventId: event.getId(), status: 'created' });
      } catch (err) {
        results.push({ calendar: cal.label, error: err.message, status: 'failed' });
      }
    });

    return ContentService.createTextOutput(JSON.stringify({ success: true, results: results }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Create a transport event on the specified calendar
 */
function createTransportEvent(calendarId, tr) {
  var cal = CalendarApp.getCalendarById(calendarId);
  if (!cal) {
    // Try primary calendar if ID doesn't match
    if (calendarId === 'primary') cal = CalendarApp.getDefaultCalendar();
    else throw new Error('Calendar not found: ' + calendarId);
  }

  var type = capitalize(tr.appointment_type || 'Other');
  var title = 'Transport: ' + tr.student_name + ' — ' + type;

  // Parse dates
  var startTime = tr.date_time ? new Date(tr.date_time) : new Date();
  var endTime = tr.return_time ? new Date(tr.return_time) : new Date(startTime.getTime() + 2 * 60 * 60 * 1000);

  var description =
    'Student: ' + tr.student_name + '\n' +
    (tr.student_house ? 'House: ' + tr.student_house + '\n' : '') +
    (tr.student_year ? 'Year: ' + tr.student_year + '\n' : '') +
    '\nAppointment: ' + type + '\n' +
    'Pickup: ' + (tr.pickup_location || 'School Reception') + '\n' +
    'Destination: ' + (tr.destination || 'TBD') + '\n' +
    (tr.appointment_details ? '\nDetails: ' + tr.appointment_details + '\n' : '') +
    (tr.special_instructions ? '\nSpecial Instructions: ' + tr.special_instructions + '\n' : '') +
    '\n— Created via LAS LinkBoard';

  var event = cal.createEvent(title, startTime, endTime, {
    description: description,
    location: tr.destination || ''
  });

  // Set color based on appointment type
  var colorMap = {
    'medical': CalendarApp.EventColor.RED,
    'dental': CalendarApp.EventColor.ORANGE,
    'specialist': CalendarApp.EventColor.YELLOW,
    'therapy': CalendarApp.EventColor.CYAN,
    'legal': CalendarApp.EventColor.GRAPE,
    'family': CalendarApp.EventColor.GREEN
  };
  var color = colorMap[(tr.appointment_type || '').toLowerCase()];
  if (color) event.setColor(color);

  return event;
}

/**
 * Handle GET requests (for testing)
 */
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    message: 'LinkBoard Calendar Integration is running',
    calendars: CONFIG.CALENDARS.map(function(c) { return c.label; })
  })).setMimeType(ContentService.MimeType.JSON);
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
