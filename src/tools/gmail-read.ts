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

export function createGmailSearchTool(): LocalClawTool {
  return {
    name: 'gmail_search',
    description: 'Search Gmail inbox. Returns subject, sender, date, and snippet for matching emails. Read-only — cannot send, delete, or modify emails. WHEN TO USE: User asks about their emails, wants to find a specific email, or check for messages from someone.',
    parameterDescription: 'query (required): Gmail search query (same syntax as Gmail search bar). maxResults (optional): Max emails to return (default 5).',
    example: 'gmail_search[{"query": "from:amazon.com subject:order", "maxResults": 5}]',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query (e.g., "from:john subject:meeting", "is:unread", "newer_than:7d")' },
        maxResults: { type: 'number', description: 'Max results to return (default 5, max 20)' },
      },
      required: ['query'],
    },
    category: 'owner',

    async execute(params): Promise<string> {
      const auth = getAuth();
      if (!auth) return 'Gmail not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in .env.';

      const query = params.query as string;
      const maxResults = Math.min((params.maxResults as number) ?? 5, 20);

      try {
        const gmail = google.gmail({ version: 'v1', auth });

        const listRes = await gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults,
        });

        const messages = listRes.data.messages ?? [];
        if (messages.length === 0) return `No emails found matching: "${query}"`;

        const results: string[] = [];
        for (const msg of messages) {
          const detail = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id!,
            format: 'metadata',
            metadataHeaders: ['Subject', 'From', 'Date'],
          });

          const headers = detail.data.payload?.headers ?? [];
          const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
          const from = headers.find(h => h.name === 'From')?.value ?? '(unknown)';
          const date = headers.find(h => h.name === 'Date')?.value ?? '';
          const snippet = detail.data.snippet ?? '';

          results.push(`- **${subject}**\n  From: ${from}\n  Date: ${date}\n  ${snippet}`);
        }

        return `Found ${messages.length} email(s) matching "${query}":\n\n${results.join('\n\n')}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Gmail search failed: ${msg}`;
      }
    },
  };
}

export function createGmailReadTool(): LocalClawTool {
  return {
    name: 'gmail_read',
    description: 'Read the full content of a specific email by ID. Use gmail_search first to find the email, then gmail_read to get the full body. Read-only.',
    parameterDescription: 'id (required): The email message ID from gmail_search results.',
    example: 'gmail_read[{"id": "18f3a2b4c5d6e7f8"}]',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Gmail message ID' },
      },
      required: ['id'],
    },
    category: 'owner',

    async execute(params): Promise<string> {
      const auth = getAuth();
      if (!auth) return 'Gmail not configured.';

      const id = params.id as string;
      if (!id) return 'Missing email ID. Use gmail_search first to find emails.';

      try {
        const gmail = google.gmail({ version: 'v1', auth });

        const detail = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'full',
        });

        const headers = detail.data.payload?.headers ?? [];
        const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
        const from = headers.find(h => h.name === 'From')?.value ?? '';
        const date = headers.find(h => h.name === 'Date')?.value ?? '';

        // Extract body text
        let body = '';
        const payload = detail.data.payload;
        if (payload?.body?.data) {
          body = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
        } else if (payload?.parts) {
          const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
          if (textPart?.body?.data) {
            body = Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
          } else {
            const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
            if (htmlPart?.body?.data) {
              body = Buffer.from(htmlPart.body.data, 'base64url').toString('utf-8')
                .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            }
          }
        }

        return `**${subject}**\nFrom: ${from}\nDate: ${date}\n\n${body.slice(0, 3000)}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Gmail read failed: ${msg}`;
      }
    },
  };
}
