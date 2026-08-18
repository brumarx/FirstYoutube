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
import {
  checkChannelLive,
  fetchLiveChatMessages,
  getLiveStreamingDetails,
  getOwnChannelId,
  postLiveChatMessage,
} from '../lib/youtube-api.mjs';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'data', 'state.json');
const TSX_BIN = path.join(ROOT, '..', 'ariaBot', 'node_modules', '.bin', 'tsx');
const GEN_SCRIPT = path.join(ROOT, 'scripts', 'generate-message.ts');

const HANDLE = '@SetorVisitante';
const POLL_INTERVAL_MS = 10_000; // varre o canal atrás de uma NOVA live (scraping, sem custo de cota)
// Depois que já sabemos qual vídeo vai ficar ao vivo (pré-show), poll rápido só
// nesse vídeo via API — é o que decide se o bot chega no "pódio" (entre os 5
// primeiros comentários) ou perde pra quem já está com o dedo no gatilho no chat.
const PRESHOW_POLL_INTERVAL_MS = 5_000;
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
// Quantas mensagens recentes de OUTRAS pessoas no chat manter como contexto pro
// LLM poder reagir de forma natural — só da live atual, reseta a cada transmissão.
const MAX_CHAT_CONTEXT = 10;

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
    `${saudacao}! Fala Fogão, e aeeeeeee!`,
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
      preShowVideoId: null,
      pendingGreeting: null,
      history: [],
      chatPageToken: null,
      recentChat: [],
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
      preShowVideoId: null,
      pendingGreeting: null,
      history: [],
      chatPageToken: null,
      recentChat: [],
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

async function generateMessage(isGreeting, history = [], extra = {}) {
  try {
    const args = [GEN_SCRIPT];
    if (isGreeting) args.push('--greeting');
    if (history.length > 0) {
      args.push(`--history-b64=${Buffer.from(JSON.stringify(history), 'utf8').toString('base64')}`);
    }
    if (extra.title) {
      args.push(`--live-title-b64=${Buffer.from(extra.title, 'utf8').toString('base64')}`);
    }
    if (extra.chatContext?.length > 0) {
      args.push(`--chat-context-b64=${Buffer.from(JSON.stringify(extra.chatContext), 'utf8').toString('base64')}`);
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

async function tick(state, ownChannelId) {
  if (!state.videoId) {
    // depois de uma tentativa falhada, espera o backoff — martelar a cada 30s é
    // o que faz o YouTube começar a rejeitar com rateLimitExceeded.
    if (state.lastAttemptAt && Date.now() - state.lastAttemptAt < GREETING_RETRY_BACKOFF_MS) {
      return state;
    }

    // já sabemos qual vídeo vai ficar ao vivo (achado num ciclo anterior, ainda em
    // pré-show) → pula o scraping do canal e vai direto pra API nesse vídeo, com
    // poll rápido (ver PRESHOW_POLL_INTERVAL_MS), pra pegar o instante exato em
    // que vira "ao vivo de verdade" em vez de só notar até 30s depois.
    let liveVideoId = state.preShowVideoId;
    if (!liveVideoId) {
      liveVideoId = await checkChannelLive(HANDLE);
      if (!liveVideoId) return state;
      // já passamos por essa live e saímos após os 15min — não entra de novo nela
      if (liveVideoId === state.attendedVideoId) return state;
    }

    const accessToken = await getAccessToken();
    const details = await getLiveStreamingDetails(liveVideoId, accessToken);
    if (!details) {
      // vídeo sumiu (ex: live cancelada) — esquece esse candidato e volta a varrer o canal
      return { ...state, preShowVideoId: null, pendingGreeting: null };
    }
    if (!details.activeLiveChatId) {
      log('sem activeLiveChatId ainda, tenta de novo no próximo ciclo');
      return { ...state, preShowVideoId: liveVideoId };
    }

    // chat costuma abrir bem antes da transmissão real (vídeo ainda "upcoming"),
    // e é justamente nessa sala de espera que o resto da torcida já está comentando
    // — esperar o `isReallyLive` pra só então postar custava o "pódio" inteiro pra
    // quem não tinha esse escrúpulo. O erro INVALID_REQUEST_METADATA que motivou
    // essa espera acontece de vez em quando de qualquer jeito, inclusive já ao vivo
    // de verdade (ver histórico do bot) — não é exclusivo da sala de espera, então
    // não vale a pena abrir mão do pódio pra evitar algo que o backoff já cobre.
    if (!details.isReallyLive) {
      log(`⏳ ${liveVideoId} ainda em pré-show (sala de espera) — chat já aberto, tenta postar a saudação mesmo assim`);
    } else {
      log(`🔴 ao vivo de verdade: ${liveVideoId}`);
    }

    // saudação simples (bom dia/boa tarde/boa noite real + saudação alvinegra),
    // sem alegar ser "o primeiro" a comentar — isso irritava outras pessoas no chat.
    // Passa o título real da live pra saudação poder soar como quem realmente
    // entrou nessa transmissão específica, em vez de um texto genérico.
    const msg = state.pendingGreeting ?? (await generateMessage(true, state.history, { title: details.title }));

    try {
      await postLiveChatMessage(details.activeLiveChatId, msg, accessToken);
    } catch (err) {
      log('⚠️ falha ao postar a saudação inicial, aguarda backoff antes de tentar de novo:', err.message);
      return { ...state, preShowVideoId: liveVideoId, pendingGreeting: msg, lastAttemptAt: Date.now() };
    }
    log(`✅ saudação postada: ${msg}`);

    return {
      videoId: liveVideoId,
      chatId: details.activeLiveChatId,
      messagesSent: 1,
      lastCommentAt: Date.now(),
      lastAttemptAt: Date.now(),
      // só começa a contar os ~15min de permanência quando o jogo estiver realmente
      // ao vivo — se a saudação saiu ainda na sala de espera, esperar aqui evita
      // gastar esse tempo (e sair cedo demais) antes do jogo começar de verdade.
      enteredAt: details.isReallyLive ? Date.now() : 0,
      attendedVideoId: state.attendedVideoId,
      preShowVideoId: null,
      pendingGreeting: null,
      history: pushHistory(state.history, msg),
      chatPageToken: null,
      recentChat: [],
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
      preShowVideoId: null,
      pendingGreeting: null,
      history: state.history,
      chatPageToken: null,
      recentChat: [],
    };
  }

  // lê mensagens novas do chat (delta via pageToken, então cada chamada só traz o
  // que chegou desde a última) pra dar contexto de reação — não derruba o ciclo se
  // falhar, só segue sem contexto novo dessa vez.
  try {
    const { items, nextPageToken } = await fetchLiveChatMessages(
      details.activeLiveChatId,
      accessToken,
      state.chatPageToken,
    );
    const deOutros = ownChannelId ? items.filter((m) => m.channelId !== ownChannelId) : items;
    state = {
      ...state,
      recentChat: deOutros.length > 0 ? [...state.recentChat, ...deOutros].slice(-MAX_CHAT_CONTEXT) : state.recentChat,
      chatPageToken: nextPageToken,
    };
  } catch (err) {
    log('⚠️ falha ao ler mensagens do chat, segue sem contexto novo:', err.message);
  }

  // saudação foi postada ainda na sala de espera (enteredAt zerado) — só começa a
  // contar os ~15min de permanência quando o jogo estiver realmente ao vivo.
  if (!state.enteredAt) {
    if (!details.isReallyLive) return state;
    state = { ...state, enteredAt: Date.now() };
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
      preShowVideoId: null,
      pendingGreeting: null,
      history: state.history,
      chatPageToken: null,
      recentChat: [],
    };
  }

  const dueForComment =
    details.isReallyLive &&
    state.messagesSent < MAX_MESSAGES_PER_STREAM &&
    Date.now() - state.lastCommentAt >= COMMENT_INTERVAL_MS;

  if (dueForComment) {
    const msg = await generateMessage(false, state.history, {
      title: details.title,
      chatContext: state.recentChat,
    });
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
  // buscado uma vez só (não muda durante a execução) — usado pra filtrar as
  // próprias mensagens fora do contexto de chat passado pro LLM.
  const ownChannelId = await getOwnChannelId(await getAccessToken()).catch((err) => {
    log('⚠️ não consegui obter o próprio channelId, contexto de chat não vai filtrar as próprias mensagens:', err.message);
    return null;
  });
  for (;;) {
    try {
      state = await tick(state, ownChannelId);
      saveState(state);
    } catch (err) {
      log('❌ erro no ciclo:', err.message);
    }
    // já tem um candidato conhecido esperando virar "ao vivo de verdade" →
    // poll rápido; senão, só varrendo o canal por uma nova live, sem pressa.
    const waitingOnCandidate = !state.videoId && Boolean(state.preShowVideoId);
    await new Promise((r) => setTimeout(r, waitingOnCandidate ? PRESHOW_POLL_INTERVAL_MS : POLL_INTERVAL_MS));
  }
}

main();
