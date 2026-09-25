// Keep the game decision loop independent of each provider's wire format.
const MODES = {
  chat: 'chat', 'chat-completions': 'chat',
  response: 'responses', responses: 'responses', 'openai-responses': 'responses',
  anthropic: 'anthropic', messages: 'anthropic', 'anthropic-messages': 'anthropic',
};

export function aiApiMode(value) {
  const key = String(value || 'chat').toLowerCase();
  return Object.hasOwn(MODES, key) ? MODES[key] : null;
}

export function aiApiEndpoint(baseUrl, mode) {
  const path = mode === 'chat' ? '/chat/completions' : mode === 'responses' ? '/responses' : '/messages';
  const base = String(baseUrl).replace(/\/+$/, '');
  return base.endsWith(path) ? base : base + path;
}

export function aiApiRequest(mode, { model, messages, apiKey, temperature, agentLoop, jsonMode, signal }) {
  const headers = { 'Content-Type': 'application/json' };
  let body;
  if (mode === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    const system = messages.filter(m => m.role === 'system' || m.role === 'developer')
      .map(m => m.content).join('\n');
    body = { model, max_tokens: agentLoop ? 3072 : 2048,
      ...(system ? { system } : {}),
      messages: messages.filter(m => m.role === 'user' || m.role === 'assistant') };
  } else if (mode === 'responses') {
    headers.Authorization = `Bearer ${apiKey}`;
    body = { model, input: messages, store: false,
      max_output_tokens: agentLoop ? 4096 : 2048,
      ...(jsonMode ? { text: { format: { type: 'json_object' } } } : {}) };
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
    body = { model, temperature: temperature ?? 0.7, top_p: 0.8,
      max_tokens: agentLoop ? 640 : 512,
      enable_thinking: false, chat_template_kwargs: { enable_thinking: false },
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}), messages };
  }
  return { method: 'POST', signal, headers, body: JSON.stringify(body) };
}

export function aiApiContent(mode, data) {
  if (mode === 'chat') return data?.choices?.[0]?.message?.content;
  if (mode === 'anthropic') return Array.isArray(data?.content)
    ? data.content.filter(block => block?.type === 'text') : null;
  // The HTTP Responses API returns output items; output_text is an SDK convenience.
  const text = (Array.isArray(data?.output) ? data.output : [])
    .filter(item => item?.type === 'message' && item.role === 'assistant')
    .flatMap(item => item.content || []).filter(part => part?.type === 'output_text')
    .map(part => part.text).filter(part => typeof part === 'string').join('');
  return text || (typeof data?.output_text === 'string' ? data.output_text : null);
}
