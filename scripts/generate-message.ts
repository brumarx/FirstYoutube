// Gera UMA mensagem de chat sobre o Botafogo usando a cadeia de provedores LLM
// (Groq etc.) do ariaBot. Uso: tsx generate-message.ts [--first]
// Imprime SÓ o texto gerado em stdout (o processo pai captura via execFile).
import { readFileSync } from 'node:fs';

import { LEAGUES, fetchPlacar } from '../../ariaBot/src/commands/actions/football.ts';
import { loadConfig } from '../../ariaBot/src/config/index.ts';
import { runProviderChain } from '../../ariaBot/src/engine/provider.ts';
import { buildProviders } from '../../ariaBot/src/engine/providers/index.ts';

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

const isFirst = process.argv.includes('--first');

/**
 * Fatos VERDADEIROS e atemporais (não dependem de resultado de jogo) — usados só
 * quando não há dado real de partida disponível, pra evitar que o modelo invente
 * placar/jogador/notícia (aconteceu com busca textual — DDG deu contexto errado
 * e o modelo inventou um placar falso).
 */
const FATOS_ATEMPORAIS = [
  'o apelido "Fogão" vem de um antigo posto de gasolina perto da sede do clube',
  'a estrela solitária no escudo é de 1907, depois de uma vitória num dia de eclipse solar',
  'Garrincha e Nilton Santos, ídolos eternos do Botafogo, foram bicampeões mundiais pela seleção em 1958 e 1962',
  'o Botafogo foi campeão brasileiro em 1995',
  'o Botafogo foi campeão da Libertadores e do Brasileirão em 2024',
  'as cores do Botafogo são preto e branco, e o clube é conhecido também como "Glorioso"',
];

/**
 * Detalhes de persona (torcedor real, não genérico) — usados só ÀS VEZES pra não
 * ficar repetitivo: cita o Dep (apresentador da live) e/ou o fato de estar
 * assistindo de Sesimbra, Portugal. A diferença de horário pro Brasil varia (~3-5h,
 * depende do horário de verão de cada lado), então calculamos a hora ATUAL em
 * Sesimbra e só afirmamos "madrugada"/"tarde da noite" se for realmente verdade
 * naquele momento — nunca assumido fixo.
 */
function horaAtualEmSesimbra(): number {
  const hora = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Lisbon',
    hour: '2-digit',
    hour12: false,
  }).format(new Date());
  return Number(hora);
}

function detalhesPersonaDisponiveis(): string[] {
  const hora = horaAtualEmSesimbra();
  const ehMadrugada = hora >= 23 || hora <= 6;
  const lisboaDetalhe = ehMadrugada
    ? 'Pode comentar que está assistindo direto de Sesimbra, Portugal, e que aí já são altas horas da madrugada.'
    : 'Pode comentar que está assistindo direto de Sesimbra, Portugal (sem afirmar que é madrugada nem tarde — só mencionar que está em Sesimbra).';
  return [
    'Pode mencionar o Dep (quem apresenta a live) torcendo junto com ele.',
    lisboaDetalhe,
    'Pode mandar um alô pro Dep.',
    '', // na maioria das vezes não força nenhum detalhe de persona
    '',
    '',
  ];
}

/** Tenta achar uma linha do Botafogo no placar real (ESPN) de uma lista de ligas. */
async function buscarJogoReal(): Promise<string | null> {
  for (const liga of ['brasileirao', 'libertadores', 'copa_brasil', 'carioca']) {
    if (!LEAGUES[liga]) continue;
    try {
      const placar = await fetchPlacar(fetch, liga);
      const linha = placar.split('\n').find((l) => l.toLowerCase().includes('botafogo') || l.toLowerCase().includes('fogo'));
      if (linha) return linha.replace(/^[✅🔴📅]\s*/, '').trim();
    } catch {
      // liga indisponível → tenta a próxima
    }
  }
  return null;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const providers = buildProviders(cfg);
  if (providers.length === 0) {
    process.stderr.write('sem provedor LLM configurado\n');
    process.exit(1);
  }

  const jogoReal = await buscarJogoReal();
  const fatoFallback = FATOS_ATEMPORAIS[Math.floor(Math.random() * FATOS_ATEMPORAIS.length)];
  const personaOpcoes = detalhesPersonaDisponiveis();
  const personaDetalhe = personaOpcoes[Math.floor(Math.random() * personaOpcoes.length)];

  const regraDados = jogoReal
    ? `Dado REAL de jogo (ESPN, use exatamente isto se for comentar placar): ${jogoReal}`
    : `Não há dado de jogo em andamento agora. Use este fato real e atemporal: ${fatoFallback}. NÃO invente nenhum placar, jogador atual ou notícia recente — fale só sobre esse fato.`;

  const task = isFirst
    ? `Escreva UM comentário curto e empolgado pro chat ao vivo de uma live no YouTube, comemorando ter sido O PRIMEIRO a comentar (algo no estilo "EHHHHHHHH primeiro a entrar dessa vez!"). Quem comenta é um HOMEM — use concordância de gênero MASCULINA sempre ("primeiro", nunca "primeira"). Torcedor apaixonado do Botafogo, pode citar a estrela solitária ou "Fogão". ${personaDetalhe} 1 frase, bem informal, pode repetir letras por ênfase (tipo EHHHH), 1-2 emojis no máximo. NÃO use markdown.`
    : `Escreva UM comentário curto pro chat ao vivo de uma live do canal do Botafogo, trazendo algo interessante sobre o clube. ${regraDados} Quem comenta é um HOMEM — use concordância de gênero MASCULINA sempre. ${personaDetalhe} Tom de torcedor animado, 1-2 frases, no máximo 1-2 emojis, sem markdown.`;

  const result = await runProviderChain(providers, [
    {
      role: 'system',
      content:
        'Você é um torcedor fanático do Botafogo (homem) comentando ao vivo no YouTube. Sempre use concordância de gênero masculina ao falar de si mesmo. Nunca afirme um placar, jogador ou notícia que não esteja explicitamente nos dados fornecidos.',
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
