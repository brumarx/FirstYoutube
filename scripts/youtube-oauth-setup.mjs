// Autorização única (OAuth 2.0 Device Flow) — gera o refresh_token usado pelo
// bot pra sempre. Rodar UMA VEZ: `node scripts/youtube-oauth-setup.mjs`.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CLIENT_SECRET_FILE = path.join(
  ROOT,
  'client_secret_810722674662-v6jpsi4ltc0qe5hd7gc2mj9kgrqqv973.apps.googleusercontent.com.json',
);
const TOKEN_FILE = path.join(ROOT, 'data', 'youtube-token.json');
const SCOPE = 'https://www.googleapis.com/auth/youtube';

const { client_id, client_secret } = JSON.parse(readFileSync(CLIENT_SECRET_FILE, 'utf8')).installed;

async function requestDeviceCode() {
  const res = await fetch('https://oauth2.googleapis.com/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, scope: SCOPE }),
  });
  if (!res.ok) throw new Error(`device/code falhou: ${res.status} ${await res.text()}`);
  return res.json();
}

async function pollToken(device_code, interval) {
  const body = new URLSearchParams({
    client_id,
    client_secret,
    device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  for (;;) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await res.json();
    if (res.ok) return data;
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') {
      interval += 5;
      continue;
    }
    throw new Error(`token falhou: ${data.error} — ${data.error_description ?? ''}`);
  }
}

async function main() {
  const dc = await requestDeviceCode();
  console.log('\n=== AUTORIZAÇÃO YOUTUBE ===');
  console.log(`1. Abra no navegador: ${dc.verification_url}`);
  console.log(`2. Digite o código:  ${dc.user_code}`);
  console.log(`3. Faça login com a conta que vai comentar no chat.`);
  console.log(`\nAguardando você autorizar (expira em ${Math.round(dc.expires_in / 60)} min)...\n`);

  const token = await pollToken(dc.device_code, dc.interval ?? 5);
  writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 });
  console.log(`✅ Autorizado! Token salvo em ${TOKEN_FILE}`);
  console.log(`   scope: ${token.scope}`);
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
