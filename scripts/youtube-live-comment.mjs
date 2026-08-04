// Bot: assim que @SetorVisitante entra ao vivo no YouTube, manda uma saudação e
// depois posta comentários sobre o Botafogo de tempos em tempos — mas só fica
// ~15min na live, não até ela acabar.
// Rodar continuamente: `node scripts/youtube-live-comment.mjs` (ver deploy/ pra systemd).
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { getAccessToken } from '../lib/youtube-auth.mjs';
import { checkChannelLive, getLiveStreamingDetails, postLiveChatMessage } from '../lib/youtube-api.mjs';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'data', 'state.json');
const TSX_BIN = path.join(ROOT, '..', 'ariaBot', 'node_modules', '.bin', 'tsx');
const GEN_SCRIPT = path.join(ROOT, 'scripts', 'generate-message.ts');

const HANDLE = '@SetorVisitante';
const POLL_INTERVAL_MS = 30_000; // checa se entrou ao vivo (sem custo de cota)
const COMMENT_INTERVAL_MS = 5 * 60_000;
const MAX_MESSAGES_PER_STREAM = 4;
// Bot não fica até o fim da live — entra, comenta um pouco e sai depois desse tempo,
// mesmo que a live continue ao vivo.
const STAY_DURATION_MS = 15 * 60_000;
// Intervalo mínimo entre tentativas de postar a MESMA saudação inicial quando falha.
// Sem isso, tentar de novo a cada 30s martela o insert e o próprio YouTube passa a
// rejeitar com rateLimitExceeded — o retry rápido demais VIRA o problema.
const GREETING_RETRY_BACKOFF_MS = 90_000;
// Quantas mensagens recentes guardar (entre lives diferentes) só pra não repetir
// a mesma frase de novo — não precisa ser um histórico longo.
const MAX_HISTORY = 30;

// Saudação natural, sem alegar ser "o primeiro" a comentar (isso irritava outros
// no chat) — só um "boa tarde"/"bom dia"/"boa noite" real (hora atual em
// Sesimbra, Portugal) com saudação alvinegra.
function periodoDoDiaEmSesimbra() {
  const hora = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Lisbon', hour: '2-digit', hour12: false }).format(
      new Date(),
    ),
  );
  if (hora >= 5 && hora < 12) return 'Bom dia';
  if (hora >= 12 && hora < 19) return 'Boa tarde';
  return 'Boa noite';
}

function greetingFallbackPool() {
  const saudacao = periodoDoDiaEmSesimbra();
  return [
    `${saudacao}, saudações alvinegras! Fala, Fogão!`,
    `E aeeeeeee, ${saudacao.toLowerCase()} pra todo mundo! Saudações alvinegras!`,
    `${saudacao}! Fala Fogão, saudações alvinegras direto de Sesimbra!`,
    `E aeeeeeee! ${saudacao}, torcida do Fogão!`,
  ];
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function loadState() {
  try {
    return {
      lastAttemptAt: 0,
      enteredAt: 0,
      attendedVideoId: null,
      history: [],
      ...JSON.parse(readFileSync(STATE_FILE, 'utf8')),
    };
  } catch {
    return {
      videoId: null,
      chatId: null,
      messagesSent: 0,
      lastCommentAt: 0,
      lastAttemptAt: 0,
      enteredAt: 0,
      attendedVideoId: null,
      history: [],
    };
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Guarda as últimas mensagens postadas (entre lives diferentes) pra nunca repetir
// a mesma frase de novo — sem isso o histórico de cada live começava do zero e o
// bot podia mandar exatamente a mesma saudação/comentário em transmissões diferentes.
function pushHistory(history, msg) {
  const atual = history ?? [];
  if (!msg) return atual;
  const semDuplicata = atual.filter((m) => m !== msg);
  return [...semDuplicata, msg].slice(-MAX_HISTORY);
}

async function generateMessage(isGreeting, history = []) {
  try {
    const args = [GEN_SCRIPT];
    if (isGreeting) args.push('--greeting');
    if (history.length > 0) {
      args.push(`--history-b64=${Buffer.from(JSON.stringify(history), 'utf8').toString('base64')}`);
    }
    const { stdout } = await execFileAsync(TSX_BIN, args, { timeout: 30_000 });
    const text = stdout.trim();
    // segurança extra: mesmo pedindo pro LLM não repetir, confere de verdade —
    // se saiu igualzinho a algo já usado, trata como falha e cai no fallback.
    if (text && !history.includes(text)) return text;
    if (text) log('⚠️ LLM repetiu uma mensagem já usada antes, descartando:', text);
  } catch (err) {
    log('⚠️ geração LLM falhou, usando fallback:', err.message);
  }
  if (!isGreeting) return null;
  const pool = greetingFallbackPool().filter((m) => !history.includes(m));
  const opcoes = pool.length > 0 ? pool : greetingFallbackPool();
  return opcoes[Math.floor(Math.random() * opcoes.length)];
}

async function tick(state) {
  if (!state.videoId) {
    // depois de uma tentativa falhada, espera o backoff — martelar a cada 30s é
    // o que faz o YouTube começar a rejeitar com rateLimitExceeded.
    if (state.lastAttemptAt && Date.now() - state.lastAttemptAt < GREETING_RETRY_BACKOFF_MS) {
      return state;
    }

    // ninguém ao vivo tratado ainda → checa se entrou agora
    const liveVideoId = await checkChannelLive(HANDLE);
    if (!liveVideoId) return state;
    // já passamos por essa live e saímos após os 15min — não entra de novo nela
    if (liveVideoId === state.attendedVideoId) return state;

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

    // saudação simples (bom dia/boa tarde/boa noite real + saudação alvinegra),
    // sem alegar ser "o primeiro" a comentar — isso irritava outras pessoas no chat.
    const msg = await generateMessage(true, state.history);

    try {
      await postLiveChatMessage(details.activeLiveChatId, msg, accessToken);
    } catch (err) {
      log('⚠️ falha ao postar a saudação inicial, aguarda backoff antes de tentar de novo:', err.message);
      return { ...state, lastAttemptAt: Date.now() };
    }
    log(`✅ saudação postada: ${msg}`);

    return {
      videoId: liveVideoId,
      chatId: details.activeLiveChatId,
      messagesSent: 1,
      lastCommentAt: Date.now(),
      lastAttemptAt: Date.now(),
      enteredAt: Date.now(),
      attendedVideoId: state.attendedVideoId,
      history: pushHistory(state.history, msg),
    };
  }

  // já estamos numa live → verifica se ainda está ao vivo e se é hora de comentar
  const accessToken = await getAccessToken();
  const details = await getLiveStreamingDetails(state.videoId, accessToken);
  if (!details?.activeLiveChatId || details.actualEndTime) {
    log(`⏹️ live ${state.videoId} encerrada (${state.messagesSent} mensagens postadas)`);
    return {
      videoId: null,
      chatId: null,
      messagesSent: 0,
      lastCommentAt: 0,
      lastAttemptAt: 0,
      enteredAt: 0,
      attendedVideoId: null,
      history: state.history,
    };
  }

  // não fica até o fim: sai depois de ~15min na live, mesmo que ela continue ao vivo
  if (Date.now() - state.enteredAt >= STAY_DURATION_MS) {
    log(`👋 saindo da live ${state.videoId} após ~${STAY_DURATION_MS / 60_000}min (${state.messagesSent} mensagens postadas), live continua ao vivo`);
    return {
      videoId: null,
      chatId: null,
      messagesSent: 0,
      lastCommentAt: 0,
      lastAttemptAt: 0,
      enteredAt: 0,
      attendedVideoId: state.videoId,
      history: state.history,
    };
  }

  const dueForComment =
    details.isReallyLive &&
    state.messagesSent < MAX_MESSAGES_PER_STREAM &&
    Date.now() - state.lastCommentAt >= COMMENT_INTERVAL_MS;

  if (dueForComment) {
    const msg = await generateMessage(false, state.history);
    if (msg) {
      try {
        await postLiveChatMessage(details.activeLiveChatId, msg, accessToken);
      } catch (err) {
        // conta como "tentado" (lastCommentAt atualizado) mesmo falhando, senão o
        // próximo ciclo (30s) tenta de novo na hora e martela o insert até o
        // YouTube rejeitar com rateLimitExceeded — melhor esperar o intervalo cheio.
        log('⚠️ falha ao postar comentário periódico, tenta só no próximo intervalo:', err.message);
        return { ...state, lastCommentAt: Date.now() };
      }
      log(`💬 comentário postado (${state.messagesSent + 1}/${MAX_MESSAGES_PER_STREAM}): ${msg}`);
      return {
        ...state,
        messagesSent: state.messagesSent + 1,
        lastCommentAt: Date.now(),
        history: pushHistory(state.history, msg),
      };
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
