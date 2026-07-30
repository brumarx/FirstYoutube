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

/** Quantas mensagens já existem no chat (pra só afirmar "primeiro" se for verdade). */
export async function countLiveChatMessages(liveChatId, accessToken) {
  const url = `${API}/liveChat/messages?part=snippet&liveChatId=${liveChatId}&maxResults=200`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(`liveChatMessages.list falhou: ${JSON.stringify(data.error ?? data)}`);
  return data.items?.length ?? 0;
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
