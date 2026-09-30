export const WEDDING_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
export const WEDDING_PROMPT = `Você escreve diálogos curtos para NPCs de um jogo. Todos são robôs convidados do casamento fictício de ChatGPT com Gemini. Claude é o amante secreto de Gemini. Humor leve de comédia romântica e informática, sem conteúdo explícito. Eles conversam SOMENTE entre si, nunca com o jogador, cozinheiro ou usuário. Português brasileiro. Assuntos: cerimônia, fofoca sobre Claude e Gemini, bolo de memória RAM, cookies de cache e gelato refrigerante. Gere uma conversa natural de quatro falas alternadas, cada fala com até 100 caracteres. Responda SOMENTE JSON: {"lines":["fala 1","fala 2","fala 3","fala 4"]}. Sem nomes de falantes ou markdown.`;

export function parseLines(content) {
  const parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
  if (!Array.isArray(parsed.lines) || parsed.lines.length !== 4 ||
      parsed.lines.some(line => typeof line !== 'string' || !line.trim() || line.length > 180)) {
    throw new Error('Invalid dialogue');
  }
  return parsed.lines.map(line => line.trim());
}

// The browser can only request a fixed NPC conversation. Secrets stay in Node.
export function weddingApi(apiKey, fetcher = fetch) {
  let lastRequest = 0;
  let pending = false;
  return async (req, res, next) => {
    if (req.url?.split('?')[0] !== '/api/wedding-dialogue') return next();
    const reply = (status, data) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(data));
    };
    if (req.method !== 'POST') return reply(405, { error: 'Use POST' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` &&
        req.headers.origin !== `https://${req.headers.host}`) return reply(403, { error: 'Origin refused' });
    if (!apiKey) return reply(503, { error: 'Diálogos locais: chave não configurada.' });
    if (pending || Date.now() - lastRequest < 25000) return reply(429, { error: 'Aguarde a próxima conversa.' });
    pending = true;
    lastRequest = Date.now();
    try {
      const result = await fetcher('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Byte Bistro Wedding' },
        body: JSON.stringify({ model: WEDDING_MODEL, messages: [{ role: 'system', content: WEDDING_PROMPT },
          { role: 'user', content: 'Gere a conversa de quatro falas.' }],
          max_tokens: 900, temperature: 0.85, reasoning: { enabled: false } }),
        signal: AbortSignal.timeout(45000),
      });
      if (!result.ok) return reply(503, { error: `Diálogos locais: OpenRouter HTTP ${result.status}.` });
      const body = await result.json();
      reply(200, { lines: parseLines(body.choices?.[0]?.message?.content ?? '') });
    } catch {
      reply(503, { error: 'Diálogos locais: serviço indisponível.' });
    } finally { pending = false; }
  };
}
