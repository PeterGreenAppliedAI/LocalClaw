import { google } from 'googleapis';
import type { LocalClawTool } from './types.js';

function getAuth() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) return null;

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

export function createCalendarListTool(): LocalClawTool {
  return {
    name: 'calendar_list',
    description: 'List upcoming events from Google Calendar. Returns event title, time, location, and description. Read-only — cannot create, modify, or delete events. WHEN TO USE: User asks about their schedule, upcoming meetings, what\'s on their calendar.',
    parameterDescription: 'days (optional): How many days ahead to look (default 7). maxResults (optional): Max events to return (default 10).',
    example: 'calendar_list[{"days": 7, "maxResults": 10}]',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Days ahead to look (default 7)' },
        maxResults: { type: 'number', description: 'Max events to return (default 10, max 50)' },
      },
    },
    category: 'owner',

    async execute(params): Promise<string> {
      const auth = getAuth();
      if (!auth) return 'Google Calendar not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in .env.';

      const days = (params.days as number) ?? 7;
      const maxResults = Math.min((params.maxResults as number) ?? 10, 50);

      const now = new Date();
      const until = new Date(now);
      until.setDate(until.getDate() + days);

      try {
        const calendar = google.calendar({ version: 'v3', auth });

        const res = await calendar.events.list({
          calendarId: 'primary',
          timeMin: now.toISOString(),
          timeMax: until.toISOString(),
          maxResults,
          singleEvents: true,
          orderBy: 'startTime',
        });

        const events = res.data.items ?? [];
        if (events.length === 0) return `No events found in the next ${days} days.`;

        const results = events.map(event => {
          const start = event.start?.dateTime ?? event.start?.date ?? '';
          const end = event.end?.dateTime ?? event.end?.date ?? '';

          // Format the time nicely
          let timeStr = '';
          if (event.start?.dateTime) {
            const startDate = new Date(start);
            const endDate = new Date(end);
            timeStr = `${startDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} ${startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} – ${endDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
          } else {
            // All-day event
            timeStr = `${new Date(start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} (all day)`;
          }

          let line = `- **${event.summary ?? '(no title)'}**\n  ${timeStr}`;
          if (event.location) line += `\n  Location: ${event.location}`;
          if (event.description) line += `\n  ${event.description.slice(0, 200)}`;
          return line;
        });

        return `Upcoming events (next ${days} days):\n\n${results.join('\n\n')}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Calendar list failed: ${msg}`;
      }
    },
  };
}

export function createCalendarSearchTool(): LocalClawTool {
  return {
    name: 'calendar_search',
    description: 'Search Google Calendar events by keyword. Returns matching events with title, time, and details. Read-only.',
    parameterDescription: 'query (required): Search term to match against event titles and descriptions. days (optional): How many days ahead/behind to search (default 30).',
    example: 'calendar_search[{"query": "dentist", "days": 60}]',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term' },
        days: { type: 'number', description: 'Days to search ahead and behind (default 30)' },
      },
      required: ['query'],
    },
    category: 'owner',

    async execute(params): Promise<string> {
      const auth = getAuth();
      if (!auth) return 'Google Calendar not configured.';

      const query = params.query as string;
      const days = (params.days as number) ?? 30;

      const now = new Date();
      const past = new Date(now);
      past.setDate(past.getDate() - days);
      const future = new Date(now);
      future.setDate(future.getDate() + days);

      try {
        const calendar = google.calendar({ version: 'v3', auth });

        const res = await calendar.events.list({
          calendarId: 'primary',
          timeMin: past.toISOString(),
          timeMax: future.toISOString(),
          q: query,
          maxResults: 20,
          singleEvents: true,
          orderBy: 'startTime',
        });

        const events = res.data.items ?? [];
        if (events.length === 0) return `No calendar events found matching "${query}" within ${days} days.`;

        const results = events.map(event => {
          const start = event.start?.dateTime ?? event.start?.date ?? '';
          const startDate = new Date(start);
          const timeStr = event.start?.dateTime
            ? `${startDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} ${startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
            : `${startDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} (all day)`;

          let line = `- **${event.summary ?? '(no title)'}** — ${timeStr}`;
          if (event.location) line += `\n  Location: ${event.location}`;
          return line;
        });

        return `Found ${events.length} event(s) matching "${query}":\n\n${results.join('\n\n')}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Calendar search failed: ${msg}`;
      }
    },
  };
}
