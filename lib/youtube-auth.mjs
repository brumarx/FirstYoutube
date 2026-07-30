import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CLIENT_SECRET_FILE = path.join(
  ROOT,
  'client_secret_810722674662-v6jpsi4ltc0qe5hd7gc2mj9kgrqqv973.apps.googleusercontent.com.json',
);
const TOKEN_FILE = path.join(ROOT, 'data', 'youtube-token.json');

let cachedAccessToken = null;
let cachedExpiresAt = 0;

/** Troca o refresh_token salvo por um access_token novo (cacheado até ~1min antes de expirar). */
export async function getAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && now < cachedExpiresAt) return cachedAccessToken;

  const { client_id, client_secret } = JSON.parse(readFileSync(CLIENT_SECRET_FILE, 'utf8')).installed;
  const { refresh_token } = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id,
      client_secret,
      refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`refresh token falhou: ${data.error} — ${data.error_description ?? ''}`);

  cachedAccessToken = data.access_token;
  cachedExpiresAt = now + (data.expires_in - 60) * 1000;
  return cachedAccessToken;
}
