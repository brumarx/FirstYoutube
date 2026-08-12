const API = 'https://www.googleapis.com/youtube/v3';

/** Detecta se o canal está ao vivo AGORA via página pública (sem gastar cota de API). */
export async function checkChannelLive(handle) {
  const res = await fetch(`https://www.youtube.com/${handle}/live`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    redirect: 'follow',
  });
  const html = await res.text();
  const canonicalMatch = html.match(/<link rel="canonical" href="([^"]*)"/);
  const canonical = canonicalMatch?.[1] ?? '';
  const watchMatch = canonical.match(/[?&]v=([\w-]{11})/) ?? canonical.match(/\/watch\?v=([\w-]{11})/);
  if (!watchMatch) return null; // canonical aponta pro canal → offline
  const isLive = /"isLive":true/.test(html);
  if (!isLive) return null;
  return watchMatch[1];
}

/**
 * liveStreamingDetails do vídeo: activeLiveChatId (se ainda ao vivo) + fim (se já encerrou).
 * `isReallyLive` distingue a transmissão de verdade da "sala de espera": o chat costuma
 * abrir bem antes (video ainda "upcoming"), e postar nesse meio-tempo falha às vezes
 * (erro INVALID_REQUEST_METADATA) — só é garantidamente aceito depois que `actualStartTime`
 * existe de verdade.
 */
export async function getLiveStreamingDetails(videoId, accessToken) {
  const url = `${API}/videos?part=liveStreamingDetails,snippet&id=${videoId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(`videos.list falhou: ${JSON.stringify(data.error ?? data)}`);
  const item = data.items?.[0];
  if (!item) return null;
  return {
    title: item.snippet?.title ?? '',
    activeLiveChatId: item.liveStreamingDetails?.activeLiveChatId ?? null,
    actualStartTime: item.liveStreamingDetails?.actualStartTime ?? null,
    actualEndTime: item.liveStreamingDetails?.actualEndTime ?? null,
    isReallyLive: Boolean(item.liveStreamingDetails?.actualStartTime),
  };
}

/**
 * Mensagens de texto novas do chat (autor + texto), desde o `pageToken` anterior —
 * pra o bot poder "ler" o que a torcida está falando e reagir de forma mais humana,
 * em vez de só comentar no vácuo. Usa `pageToken` (delta) em vez de sempre listar
 * tudo, então cada chamada só traz o que chegou desde a última.
 */
export async function fetchLiveChatMessages(liveChatId, accessToken, pageToken) {
  const url = new URL(`${API}/liveChat/messages`);
  url.searchParams.set('part', 'snippet,authorDetails');
  url.searchParams.set('liveChatId', liveChatId);
  url.searchParams.set('maxResults', '200');
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(`liveChatMessages.list falhou: ${JSON.stringify(data.error ?? data)}`);
  const items = (data.items ?? [])
    .filter((i) => i.snippet?.type === 'textMessageEvent')
    .map((i) => ({
      channelId: i.authorDetails?.channelId ?? '',
      author: i.authorDetails?.displayName ?? '',
      text: i.snippet?.textMessageDetails?.messageText ?? '',
    }))
    .filter((m) => m.text);
  return { items, nextPageToken: data.nextPageToken ?? pageToken ?? null };
}

/** channelId do próprio canal autenticado — pra filtrar as próprias mensagens fora do contexto de chat. */
export async function getOwnChannelId(accessToken) {
  const res = await fetch(`${API}/channels?part=id&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`channels.list falhou: ${JSON.stringify(data.error ?? data)}`);
  return data.items?.[0]?.id ?? null;
}

/** Posta uma mensagem no chat ao vivo. */
export async function postLiveChatMessage(liveChatId, text, accessToken) {
  const res = await fetch(`${API}/liveChat/messages?part=snippet`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      snippet: {
        liveChatId,
        type: 'textMessageEvent',
        textMessageDetails: { messageText: text },
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`liveChatMessages.insert falhou: ${JSON.stringify(data.error ?? data)}`);
  return data;
}
