// Servidor HTTP de controle do bot — expõe uma API simples (protegida por token)
// pra uma UI (ver ui/index.html) poder forçar a próxima saudação e testar a
// geração de mensagens da LLM sem precisar mexer em arquivo nem reiniciar nada.
// Roda embutido no MESMO processo do bot (youtube-live-comment.mjs) porque é
// esse processo que segura o `state` em memória — gravar direto no state.json
// por fora seria sobrescrito no próximo ciclo dele.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const TOKEN_FILE_NAME = 'control-token.txt';

function loadOrCreateToken(dataDir) {
  const tokenPath = path.join(dataDir, TOKEN_FILE_NAME);
  if (existsSync(tokenPath)) return readFileSync(tokenPath, 'utf8').trim();
  const token = randomBytes(24).toString('hex');
  writeFileSync(tokenPath, token);
  return token;
}

function isAuthorized(req, token) {
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.dataDir - onde guardar/ler o token (data/).
 * @param {string} opts.uiHtmlPath - caminho do arquivo HTML da UI.
 * @param {() => object} opts.getState - snapshot atual do state do bot.
 * @param {(text: string | null) => void} opts.setForcedGreeting
 * @param {(days: number[]) => void} opts.setEnabledWeekdays
 * @param {(args: { enabled: boolean, max: number }) => void} opts.setCommentSettings
 * @param {(args: { greeting: boolean, title?: string, chatContext?: Array<{author:string,text:string}> }) => Promise<string | null>} opts.testMessage
 * @param {(...args: unknown[]) => void} opts.log
 */
export function startControlServer({ port, dataDir, uiHtmlPath, getState, setForcedGreeting, setEnabledWeekdays, setCommentSettings, testMessage, log }) {
  const token = loadOrCreateToken(dataDir);
  log(`🔑 UI de controle: token em ${path.join(dataDir, TOKEN_FILE_NAME)} (gere de novo apagando esse arquivo)`);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(readFileSync(uiHtmlPath, 'utf8'));
        return;
      }

      if (!url.pathname.startsWith('/api/')) {
        res.writeHead(404);
        res.end();
        return;
      }

      if (!isAuthorized(req, token)) {
        sendJson(res, 401, { error: 'token inválido ou ausente' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const state = getState();
        sendJson(res, 200, {
          live: Boolean(state.videoId),
          videoId: state.videoId,
          messagesSent: state.messagesSent,
          enteredAt: state.enteredAt || null,
          attendedVideoId: state.attendedVideoId,
          preShowVideoId: state.preShowVideoId,
          preShowScheduledStartTime: state.preShowScheduledStartTime,
          forcedGreetingText: state.forcedGreetingText ?? null,
          enabledWeekdays: state.enabledWeekdays ?? [0, 1, 2, 3, 4, 5, 6],
          commentingEnabled: state.commentingEnabled !== false,
          maxMessagesPerStream: state.maxMessagesPerStream ?? 4,
          history: (state.history ?? []).slice(-8),
          recentChat: (state.recentChat ?? []).slice(-8),
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/forced-greeting') {
        const body = await readJsonBody(req);
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        setForcedGreeting(text || null);
        sendJson(res, 200, { forcedGreetingText: text || null });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/weekdays') {
        const body = await readJsonBody(req);
        const days = Array.isArray(body.days)
          ? [...new Set(body.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
          : null;
        if (!days) {
          sendJson(res, 400, { error: 'days deve ser uma lista de inteiros entre 0 (domingo) e 6 (sábado)' });
          return;
        }
        setEnabledWeekdays(days);
        sendJson(res, 200, { enabledWeekdays: days });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/comment-settings') {
        const body = await readJsonBody(req);
        const enabled = Boolean(body.enabled);
        const max = Number(body.max);
        if (!Number.isInteger(max) || max < 0 || max > 50) {
          sendJson(res, 400, { error: 'max deve ser um inteiro entre 0 e 50' });
          return;
        }
        setCommentSettings({ enabled, max });
        sendJson(res, 200, { commentingEnabled: enabled, maxMessagesPerStream: max });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/test-message') {
        const body = await readJsonBody(req);
        const text = await testMessage({
          greeting: Boolean(body.greeting),
          title: typeof body.title === 'string' ? body.title : undefined,
          chatContext: Array.isArray(body.chatContext) ? body.chatContext : undefined,
        });
        sendJson(res, 200, { text });
        return;
      }

      res.writeHead(404);
      res.end();
    } catch (err) {
      log('⚠️ erro na UI de controle:', err.message);
      sendJson(res, 500, { error: err.message });
    }
  });

  server.listen(port, () => log(`🖥️ UI de controle em http://0.0.0.0:${port}`));
  return server;
}
