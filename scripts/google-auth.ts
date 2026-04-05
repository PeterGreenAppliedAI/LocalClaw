/**
 * One-time OAuth2 consent flow to get a Google refresh token.
 * Run: npx tsx scripts/google-auth.ts
 *
 * 1. Opens your browser to Google's consent page
 * 2. You approve access
 * 3. Google redirects to localhost, we capture the code
 * 4. Exchange code for refresh token
 * 5. Print the token — add it to .env as GOOGLE_REFRESH_TOKEN
 */

import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFileSync } from 'node:fs';

// Load .env manually (no dotenv dependency)
const envFile = readFileSync('.env', 'utf-8');
for (const line of envFile.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
}

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3333/callback';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
  process.exit(1);
}

// Build the consent URL
const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPES);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');

console.log('\nOpening browser for Google OAuth consent...\n');
console.log('If the browser does not open, visit this URL manually:\n');
console.log(authUrl.toString());
console.log('');

// Try to open the browser
import('child_process').then(({ exec }) => {
  const url = authUrl.toString();
  const cmd = process.platform === 'darwin' ? `open "${url}"`
    : process.platform === 'win32' ? `start "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd);
});

// Start a temporary server to catch the redirect
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:3333`);

  if (url.pathname !== '/callback') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400);
    res.end('No authorization code received');
    return;
  }

  // Exchange the code for tokens
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID!,
        client_secret: CLIENT_SECRET!,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenRes.json() as Record<string, unknown>;

    if (tokens.error) {
      console.error('\nToken exchange failed:', tokens.error, tokens.error_description);
      res.writeHead(500);
      res.end('Token exchange failed. Check the terminal.');
    } else {
      const refreshToken = tokens.refresh_token as string;
      console.log('\n===========================================');
      console.log('  SUCCESS! Add this to your .env file:');
      console.log('===========================================\n');
      console.log(`GOOGLE_REFRESH_TOKEN=${refreshToken}\n`);

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Done!</h1><p>Refresh token printed in terminal. You can close this tab.</p>');
    }
  } catch (err) {
    console.error('\nFailed to exchange code:', err);
    res.writeHead(500);
    res.end('Failed. Check the terminal.');
  }

  // Shut down after handling
  setTimeout(() => { server.close(); process.exit(0); }, 1000);
});

server.listen(3333, () => {
  console.log('Waiting for OAuth callback on http://localhost:3333/callback ...\n');
});
