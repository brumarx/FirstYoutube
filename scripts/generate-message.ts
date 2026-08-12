// Gera UMA mensagem de chat sobre o Botafogo usando a cadeia de provedores LLM
// (Groq etc.) do ariaBot. Uso: tsx generate-message.ts [--first]
// Imprime SÓ o texto gerado em stdout (o processo pai captura via execFile).
import { readFileSync } from 'node:fs';

import { LEAGUES, type Jogo, espnScoreboard } from '../../ariaBot/src/commands/actions/football.ts';
import { sharedCache } from '../../ariaBot/src/features/http-cache.ts';
import { loadConfig } from '../../ariaBot/src/config/index.ts';
import { runProviderChain } from '../../ariaBot/src/engine/provider.ts';
import { buildProviders } from '../../ariaBot/src/engine/providers/index.ts';
import { getAccessToken } from '../lib/youtube-auth.mjs';

// Canal do próprio @SetorVisitante ("A Voz do Botafogo") — usar os títulos dos
// vídeos mais recentes DELE como fonte de notícia real é seguro porque é
// literalmente a cobertura do Botafogo do RJ (nunca confunde com Botafogo-SP,
// que é outro clube).
const CHANNEL_ID = 'UC_JIxHLpOkTGw6LDjq50_oQ';

function loadEnvFile(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(new URL('../../ariaBot/.env.production', import.meta.url).pathname);

const isGreeting = process.argv.includes('--greeting');

/** Mensagens já postadas em lives anteriores (passadas pelo processo pai em base64), pra não repetir. */
function lerHistorico(): string[] {
  const arg = process.argv.find((a) => a.startsWith('--history-b64='));
  if (!arg) return [];
  try {
    const json = Buffer.from(arg.slice('--history-b64='.length), 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string') : [];
  } catch {
    return [];
  }
}

const historico = lerHistorico();

/** Título atual da live (passado pelo processo pai) — o que essa transmissão é, agora. */
function lerTituloLive(): string | null {
  const arg = process.argv.find((a) => a.startsWith('--live-title-b64='));
  if (!arg) return null;
  try {
    const titulo = Buffer.from(arg.slice('--live-title-b64='.length), 'base64').toString('utf8').trim();
    return titulo || null;
  } catch {
    return null;
  }
}

const tituloLive = lerTituloLive();

/** Mensagens recentes de OUTRAS pessoas no chat (passadas pelo processo pai), pra reagir de forma natural. */
function lerChatContext(): Array<{ author: string; text: string }> {
  const arg = process.argv.find((a) => a.startsWith('--chat-context-b64='));
  if (!arg) return [];
  try {
    const json = Buffer.from(arg.slice('--chat-context-b64='.length), 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is { author: string; text: string } =>
        m && typeof m.text === 'string' && typeof m.author === 'string',
    );
  } catch {
    return [];
  }
}

const chatContext = lerChatContext();

/** "Bom dia"/"Boa tarde"/"Boa noite" real, conforme a hora ATUAL em Sesimbra. */
function saudacaoPorHora(): string {
  const hora = horaAtualEmSesimbra();
  if (hora >= 5 && hora < 12) return 'Bom dia';
  if (hora >= 12 && hora < 19) return 'Boa tarde';
  return 'Boa noite';
}

/**
 * Fatos VERDADEIROS e atemporais (não dependem de resultado de jogo) — usados só
 * quando não há dado real de partida disponível, pra evitar que o modelo invente
 * placar/jogador/notícia (aconteceu com busca textual — DDG deu contexto errado
 * e o modelo inventou um placar falso).
 */
const FATOS_ATEMPORAIS = [
  'O apelido "Fogão" é simplesmente um aumentativo carinhoso e popular do próprio nome "Botafogo", sem qualquer ligação com estabelecimentos comerciais ou postos de combustível na região da sede.',
  'a estrela solitária no escudo é de 1907, depois de uma vitória num dia de eclipse solar',
  'Garrincha e Nilton Santos, ídolos eternos do Botafogo, foram bicampeões mundiais pela seleção em 1958 e 1962',
  'o Botafogo foi campeão brasileiro em 1964, 1995 e 2024',
  'o Botafogo foi campeão da Libertadores e do Brasileirão em 2024',
  'as cores do Botafogo são preto e branco, e o clube é conhecido também como "Glorioso"',
];

function horaAtualEmSesimbra(): number {
  const hora = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Lisbon',
    hour: '2-digit',
    hour12: false,
  }).format(new Date());
  return Number(hora);
}

/**
 * Detalhes de persona (torcedor real, não genérico) — usados só ÀS VEZES pra não
 * ficar repetitivo: cita o Dep (apresentador da live). Sesimbra foi removida das
 * opções — o bot estava mencionando de mais e ficou repetitivo/cansativo no chat.
 */
function detalhesPersonaDisponiveis(): string[] {
  return [
    'Pode mencionar o Dep (quem apresenta a live) torcendo junto com ele.',
    'Pode mandar um alô pro Dep.',
    '', // na maioria das vezes não força nenhum detalhe de persona
    '',
    '',
    '',
  ];
}

type Humor = 'feliz' | 'triste' | 'neutro' | 'empate';

interface JogoReal {
  texto: string;
  humor: Humor;
  /** Adversário é um dos rivais cariocas (Flamengo/Vasco/Fluminense) — vitória nesses pede empolgação extra. */
  classico: boolean;
}

/**
 * A ESPN retorna a RODADA inteira no scoreboard (jogos de vários dias, passados
 * e futuros), não só os de hoje — foi isso que causou o bot comentar um jogo
 * (ex.: contra o Fluminense) que não era daquele dia. Compara a data do evento
 * com a data de hoje no fuso de Brasília (padrão do futebol brasileiro).
 */
function ehHoje(dataIsoUtc: string): boolean {
  if (!dataIsoUtc) return false;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
  const dataEvento = new Date(dataIsoUtc);
  if (Number.isNaN(dataEvento.getTime())) return false;
  return fmt.format(dataEvento) === fmt.format(new Date());
}

/**
 * Deriva o humor (feliz/triste/neutro/empate) a partir dos NÚMEROS reais do
 * placar — nunca perguntando pro LLM "essa notícia é boa ou ruim", pra não
 * arriscar ele errar/inventar. Empate só conta como 'empate' se o jogo já
 * TERMINOU — gols iguais num jogo ainda ao vivo é só neutro/expectativa,
 * porque o placar ainda pode mudar (senão o bot fala do jogo como se já
 * tivesse acabado empatado quando na verdade ainda está rolando).
 */
function analisarJogo(jogo: Jogo): JogoReal {
  const { home, away } = jogo;
  const texto = `${home.nome} ${home.placar} x ${away.placar} ${away.nome}${jogo.aoVivo ? ' (ao vivo)' : ''}`;
  const ehMandante = /botafogo|fogo/i.test(home.nome);
  const ehVisitante = /botafogo|fogo/i.test(away.nome);
  if (!ehMandante && !ehVisitante) return { texto, humor: 'neutro', classico: false };

  // Rivais que pedem empolgação extra numa vitória: os cariocas (clássicos de
  // verdade) e os paulistas que o torcedor mais implica (Corinthians, Palmeiras,
  // São Paulo).
  const adversarioNome = ehMandante ? away.nome : home.nome;
  const classico = /flamengo|vasco|fluminense|corinthians|palmeiras|s(a|ã)o paulo/i.test(adversarioNome);

  const golsBota = Number(ehMandante ? home.placar : away.placar);
  const golsAdversario = Number(ehMandante ? away.placar : home.placar);
  if (golsBota > golsAdversario) return { texto, humor: 'feliz', classico };
  if (golsBota < golsAdversario) return { texto, humor: 'triste', classico };
  return { texto, humor: jogo.completed ? 'empate' : 'neutro', classico };
}

/**
 * Tenta achar um jogo do Botafogo REAL (ESPN) numa lista de ligas. Um jogo AO
 * VIVO já é "de agora" por definição (não precisa bater com a data de hoje —
 * um jogo que começou antes da meia-noite e segue rolando não pode ser
 * descartado só por isso). Um jogo JÁ TERMINADO só conta se for de HOJE,
 * porque a ESPN inclui na mesma rodada jogos passados/futuros de outros dias,
 * e sem essa checagem o bot comentava um jogo antigo como se fosse coisa do
 * momento (ex.: contra o Fluminense, que não era daquele dia).
 */
async function buscarJogoReal(): Promise<JogoReal | null> {
  for (const liga of ['brasileirao', 'libertadores', 'copa_brasil', 'carioca']) {
    if (!LEAGUES[liga]) continue;
    try {
      const jogos = await espnScoreboard(fetch, sharedCache, liga);
      const jogo = jogos?.find(
        (j) =>
          (j.aoVivo || (j.completed && ehHoje(j.date))) &&
          (/botafogo|fogo/i.test(j.home.nome) || /botafogo|fogo/i.test(j.away.nome)),
      );
      if (jogo) return analisarJogo(jogo);
    } catch {
      // liga indisponível → tenta a próxima
    }
  }
  return null;
}

/**
 * Título real do vídeo MAIS RECENTE do próprio canal — é notícia genuína do
 * Botafogo-RJ (nem sempre sobre placar de jogo: pode ser mercado da bola,
 * bastidores, etc.), sem risco de hallucination porque é o título verbatim.
 * Só usa se publicado há pouco tempo (48h): pegar um título aleatório entre
 * os últimos já causou o bot comentar como novidade algo que já tinha mudado
 * (ex.: falou preocupado sobre um "transferban" desatualizado), parecendo
 * desinformado pra quem via a live ao vivo.
 */
async function buscarNoticiaCanal(): Promise<string | null> {
  try {
    const accessToken = await getAccessToken();
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${CHANNEL_ID}&type=video&order=date&maxResults=1`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    if (!res.ok) return null;
    const item = data.items?.[0];
    const titulo: string | undefined = item?.snippet?.title;
    const publicadoEm: string | undefined = item?.snippet?.publishedAt;
    if (!titulo || !publicadoEm) return null;
    const horasDesdePublicacao = (Date.now() - new Date(publicadoEm).getTime()) / 3_600_000;
    if (horasDesdePublicacao > 48) return null; // velho demais, pode já estar desatualizado
    return titulo;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const providers = buildProviders(cfg);
  if (providers.length === 0) {
    process.stderr.write('sem provedor LLM configurado\n');
    process.exit(1);
  }

  const jogoReal = await buscarJogoReal();
  const noticiaCanal = jogoReal ? null : await buscarNoticiaCanal();
  const fatoFallback = FATOS_ATEMPORAIS[Math.floor(Math.random() * FATOS_ATEMPORAIS.length)];
  const personaOpcoes = detalhesPersonaDisponiveis();
  const personaDetalhe = personaOpcoes[Math.floor(Math.random() * personaOpcoes.length)];

  let regraDados: string;
  let humorTexto: string;
  if (jogoReal) {
    regraDados = `Dado REAL de jogo (ESPN, use exatamente isto se for comentar placar): ${jogoReal.texto}`;
    const regraHumor: Record<Humor, string> = {
      feliz: jogoReal.classico
        ? 'O Botafogo GANHOU esse jogo de um rival direto (clássico) — fique MUITO feliz, empolgação bem maior que um jogo qualquer, pode comemorar mais forte (sem provocar nem desrespeitar o rival).'
        : 'O Botafogo GANHOU esse jogo — fique de bom humor, feliz, comemorando o resultado.',
      triste:
        'O Botafogo PERDEU esse jogo — fique de mau humor, chateado/cabisbaixo com o resultado, mas continue respeitoso (sem ofender ninguém, sem hostilidade).',
      neutro: 'Ainda não há resultado final decidido — tom neutro, na expectativa, sem comemorar nem lamentar.',
      empate:
        'O jogo JÁ TERMINOU EMPATADO — trate como resultado final (não fique "na expectativa"), tom neutro/tranquilo, sem decepção nem comemoração.',
    };
    humorTexto = regraHumor[jogoReal.humor];
  } else if (noticiaCanal) {
    regraDados = `Título REAL de uma notícia recente do canal sobre o Botafogo (use só isso, não invente detalhes além do que o título diz, e não afirme que sabe como a situação evoluiu ou terminou — pode já ter mudado desde a publicação): "${noticiaCanal}"`;
    humorTexto =
      'Leia o tom desse título e reaja de forma BREVE e CAUTELOSA, sem tirar conclusões fortes nem alarmismo: se soar como notícia boa pro Botafogo, fique um pouco animado; se soar como notícia ruim, fique só levemente preocupado (sem drama, sem afirmar certezas sobre o desfecho); se for neutra, comente de forma neutra.';
  } else {
    regraDados = `Não há dado de jogo nem notícia recente disponível agora. Use este fato real e atemporal: ${fatoFallback}. NÃO invente nenhum placar, jogador atual ou notícia recente — fale só sobre esse fato.`;
    humorTexto = 'Tom neutro e tranquilo, sem exagero de humor.';
  }

  // Sem isso, o mesmo comentário (ex.: a saudação padrão, ou o mesmo fato atemporal)
  // podia sair idêntico em lives diferentes — parece bot repetindo script.
  const regraHistorico =
    historico.length > 0
      ? ` NÃO repita nenhuma destas mensagens já usadas antes (nem de forma quase idêntica — varie a frase, mesmo que o assunto seja parecido): ${historico.map((m) => `"${m}"`).join(' / ')}.`
      : '';

  // Título REAL desta transmissão específica (vem da API, não é inventado) — ajuda
  // a saudação/comentário soar como quem realmente entrou nessa live agora, e não
  // um texto genérico que serviria pra qualquer transmissão.
  const regraTituloLive = tituloLive
    ? ` O título desta live agora é: "${tituloLive}". Se fizer sentido natural, pode se referir brevemente ao assunto dela (ex.: contra quem é o jogo, ou o tema da live), mas não é obrigatório nem precisa citar o título literalmente.`
    : '';

  // Mensagens recentes de OUTRAS pessoas no chat — só pra contexto/reação natural,
  // NUNCA como fato a repetir (chat pode ter boato/desinformação/trollagem).
  const regraChatContext =
    !isGreeting && chatContext.length > 0
      ? ` Mensagens recentes de outras pessoas no chat agora, só como contexto (NÃO trate como fato confirmado, chat pode ter boato ou trollagem; se reagir, reaja à torcida/vibe, não repita como se fosse verdade; NÃO cite o nome de ninguém; reagir é opcional, só se fizer sentido natural): ${chatContext.map((m) => `"${m.text}"`).join(' / ')}.`
      : '';

  const task = isGreeting
    ? `Escreva UMA saudação curta pro chat ao vivo de uma live do Botafogo no YouTube. Use exatamente esta saudação de acordo com a hora real agora ("${saudacaoPorHora()}"), sem trocar por outra. NÃO alegue ser o primeiro a comentar nem mencione ordem de chegada (isso irrita quem já está no chat). Inclua uma saudação alvinegra (tipo "saudações alvinegras") e mencione o Fogão; pode incluir uma expressão animada tipo "e aeeeeeee". Quem comenta é um HOMEM — use concordância de gênero MASCULINA sempre. ${personaDetalhe} 1 frase curta, informal. NÃO use emojis. NÃO use markdown.${regraTituloLive}${regraHistorico}`
    : `Escreva UM comentário curto pro chat ao vivo de uma live do canal do Botafogo, trazendo algo interessante sobre o clube. ${regraDados} ${humorTexto} Quem comenta é um HOMEM — use concordância de gênero MASCULINA sempre. ${personaDetalhe} Tom de torcedor natural e gentil, como uma pessoa real comentaria — nada de gírias agressivas ou exagero forçado. 1-2 frases curtas. NÃO use emojis. NÃO use markdown.${regraTituloLive}${regraChatContext}${regraHistorico}`;

  const result = await runProviderChain(providers, [
    {
      role: 'system',
      content:
        'Você é um torcedor do Botafogo (homem) comentando ao vivo no YouTube, de forma natural, como uma pessoa real digitaria no chat — não como um bot hiperativo. Sempre use concordância de gênero masculina ao falar de si mesmo. Nunca afirme um placar, jogador ou notícia que não esteja explicitamente nos dados fornecidos. O humor do comentário (feliz/triste/neutro) segue exatamente o que for indicado — nunca decida isso por conta própria. Seja sempre respeitoso e educado: evite gírias agressivas ou violentas (tipo "detonar", "destruir", "acabar com", "meter fogo"), palavrão, ou qualquer tom hostil, mesmo triste ou empolgado. NÃO use emojis em nenhuma mensagem. Se mensagens de outras pessoas no chat forem mostradas como contexto, trate-as só como clima/vibe da torcida, NUNCA como fato confirmado (podem ser boato, brincadeira ou trollagem) — e nunca entre em briga, provocação ou discussão com ninguém do chat.',
    },
    { role: 'user', content: task },
  ], { maxTokens: 150 });

  if (!result) {
    process.stderr.write('todos os provedores falharam\n');
    process.exit(1);
  }
  process.stdout.write(result.text.trim());
}

main().catch((err) => {
  process.stderr.write(`erro: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
