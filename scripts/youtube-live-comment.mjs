// Bot: assim que @SetorVisitante entra ao vivo no YouTube, comenta primeiro e
// depois posta comentários sobre o Botafogo de tempos em tempos, até a live acabar.
// Rodar continuamente: `node scripts/youtube-live-comment.mjs` (ver deploy/ pra systemd).
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { getAccessToken } from '../lib/youtube-auth.mjs';
import {
  checkChannelLive,
  countLiveChatMessages,
  getLiveStreamingDetails,
  postLiveChatMessage,
} from '../lib/youtube-api.mjs';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'data', 'state.json');
const TSX_BIN = path.join(ROOT, '..', 'ariaBot', 'node_modules', '.bin', 'tsx');
const GEN_SCRIPT = path.join(ROOT, 'scripts', 'generate-message.ts');

const HANDLE = '@SetorVisitante';
const POLL_INTERVAL_MS = 30_000; // checa se entrou ao vivo (sem custo de cota)
const COMMENT_INTERVAL_MS = 12 * 60_000; // intervalo entre comentários "interessantes" — espaçado, sem spammar o chat
const MAX_MESSAGES_PER_STREAM = 6;

// A diferença de horário Sesimbra x Brasil varia (~3-5h, depende do horário de
// verão de cada lado), então só afirmamos "madrugada" quando é realmente tarde
// AGORA em Sesimbra — nunca fixo (senão fica falso boa parte do ano/horário).
function ehMadrugadaEmSesimbra() {
  const hora = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Lisbon', hour: '2-digit', hour12: false }).format(
      new Date(),
    ),
  );
  return hora >= 23 || hora <= 6;
}

const FIRST_FALLBACK_BASE = [
  'EHHHHHHHHHHH primeiro a entrar dessa vez! Vamo Fogão!',
  'CHEGUEI PRIMEIRO DE NOVO! Bora Botafogo!',
  'Primeiro a entrar, alvinegro até debaixo d\'água!',
  'Opa Dep, cheguei primeiro! Bora Fogão!',
  'EHHHHHHHH primeiro direto de Sesimbra, Portugal!',
];

const FIRST_FALLBACK_MADRUGADA = [
  'EHHHHHHHH primeiro de Sesimbra, já tá de madrugada aqui e eu não perco!',
  'Opa Dep, cheguei primeiro! Bora Fogão, mesmo de madrugada em Portugal!',
  'PRIMEIRO DE NOVO, direto de Sesimbra e já são tantas da manhã aqui, mas Botafogo é Botafogo!',
];

function firstFallbackPool() {
  return ehMadrugadaEmSesimbra() ? [...FIRST_FALLBACK_BASE, ...FIRST_FALLBACK_MADRUGADA] : FIRST_FALLBACK_BASE;
}

// Fallback genérico pro momento em que a live começa mas NÃO temos certeza de
// sermos os primeiros (chat já tinha mensagens) — nunca alega "primeiro" aqui.
const NORMAL_FALLBACK = [
  'Chegueiii! Bora Botafogo, vamo com tudo!',
  'Presente! Vamo Fogão, hoje é dia de fumaça!',
  'Tá todo mundo aqui já? Vamo Botafogo, alvinegro até debaixo d\'água!',
];

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { videoId: null, chatId: null, messagesSent: 0, lastCommentAt: 0 };
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function generateMessage(isFirst) {
  try {
    const args = isFirst ? [GEN_SCRIPT, '--first'] : [GEN_SCRIPT];
    const { stdout } = await execFileAsync(TSX_BIN, args, { timeout: 30_000 });
    const text = stdout.trim();
    if (text) return text;
  } catch (err) {
    log('⚠️ geração LLM falhou, usando fallback:', err.message);
  }
  if (!isFirst) return null;
  const pool = firstFallbackPool();
  return pool[Math.floor(Math.random() * pool.length)];
}

async function tick(state) {
  if (!state.videoId) {
    // ninguém ao vivo tratado ainda → checa se entrou agora
    const liveVideoId = await checkChannelLive(HANDLE);
    if (!liveVideoId) return state;

    const accessToken = await getAccessToken();
    const details = await getLiveStreamingDetails(liveVideoId, accessToken);
    if (!details?.activeLiveChatId) {
      log('sem activeLiveChatId ainda, tenta de novo no próximo ciclo');
      return state;
    }
    // chat costuma abrir bem antes da transmissão real (vídeo ainda "upcoming"),
    // postar nessa sala de espera falha às vezes e gastaria comentário à toa.
    if (!details.isReallyLive) {
      log(`⏳ ${liveVideoId} ainda em pré-show (sala de espera), aguardando começar de verdade`);
      return state;
    }

    log(`🔴 ao vivo de verdade: ${liveVideoId}`);

    // só afirma "primeiro" se o chat estiver mesmo vazio ainda (verificado via API,
    // não assumido) — senão posta um comentário normal, sem alegar algo que não sabemos.
    let souRealmentePrimeiro = false;
    try {
      souRealmentePrimeiro = (await countLiveChatMessages(details.activeLiveChatId, accessToken)) === 0;
    } catch (err) {
      log('⚠️ não deu pra confirmar se sou o primeiro, assumindo que não:', err.message);
    }

    const msg =
      (await generateMessage(souRealmentePrimeiro)) ??
      NORMAL_FALLBACK[Math.floor(Math.random() * NORMAL_FALLBACK.length)];
    await postLiveChatMessage(details.activeLiveChatId, msg, accessToken);
    log(`✅ mensagem postada (primeiro=${souRealmentePrimeiro}): ${msg}`);

    return {
      videoId: liveVideoId,
      chatId: details.activeLiveChatId,
      messagesSent: 1,
      lastCommentAt: Date.now(),
    };
  }

  // já estamos numa live → verifica se ainda está ao vivo e se é hora de comentar
  const accessToken = await getAccessToken();
  const details = await getLiveStreamingDetails(state.videoId, accessToken);
  if (!details?.activeLiveChatId || details.actualEndTime) {
    log(`⏹️ live ${state.videoId} encerrada (${state.messagesSent} mensagens postadas)`);
    return { videoId: null, chatId: null, messagesSent: 0, lastCommentAt: 0 };
  }

  const dueForComment =
    details.isReallyLive &&
    state.messagesSent < MAX_MESSAGES_PER_STREAM &&
    Date.now() - state.lastCommentAt >= COMMENT_INTERVAL_MS;

  if (dueForComment) {
    const msg = await generateMessage(false);
    if (msg) {
      await postLiveChatMessage(details.activeLiveChatId, msg, accessToken);
      log(`💬 comentário postado (${state.messagesSent + 1}/${MAX_MESSAGES_PER_STREAM}): ${msg}`);
      return { ...state, messagesSent: state.messagesSent + 1, lastCommentAt: Date.now() };
    }
  }

  return state;
}

async function main() {
  log(`iniciando bot de live chat para ${HANDLE}`);
  let state = loadState();
  for (;;) {
    try {
      state = await tick(state);
      saveState(state);
    } catch (err) {
      log('❌ erro no ciclo:', err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main();
