// Model adapters. Internal message format:
//   {role:'user', content:[{type:'text',text} | {type:'image',data,mimeType}]}
//   {role:'assistant', text, toolCalls:[{id,name,args}]}
//   {role:'tool', results:[{id,name,content:[...same parts], isError}]}
// Two wire formats cover every provider: Anthropic Messages and OpenAI chat completions.

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const RETRIES = 3;

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); }, { once: true });
});

/** POST JSON with retries for rate limits, overloads, 5xx and dropped connections (honours Retry-After, max 20 s). */
export async function postJson(url, headers, body, signal) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (attempt < RETRIES) { await wait(800 * 2 ** attempt, signal); continue; }
      throw new Error(`Could not reach ${new URL(url).host}: ${e.message}`);
    }
    if (RETRY_STATUS.has(res.status) && attempt < RETRIES) {
      const after = Number(res.headers?.get?.('retry-after'));
      await wait(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 20000) : 700 * 2 ** attempt, signal);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${new URL(url).host} returned HTTP ${res.status}: ${text.slice(0, 400)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${new URL(url).host} returned non-JSON output`);
    }
  }
}

function anthropicHeaders(cfg) {
  return {
    'x-api-key': cfg.apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

function openaiHeaders(cfg) {
  return cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};
}

// ---------- Anthropic ----------

function toAnthropicPart(p) {
  if (p.type === 'image') return { type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.data } };
  return { type: 'text', text: p.text };
}

export function toAnthropicMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.content.map(toAnthropicPart) };
    if (m.role === 'assistant') {
      const content = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls || []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} });
      return { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '…' }] };
    }
    return {
      role: 'user',
      content: m.results.map((r) => ({
        type: 'tool_result', tool_use_id: r.id, is_error: !!r.isError, content: r.content.map(toAnthropicPart),
      })),
    };
  });
}

async function anthropicChat({ cfg, model, system, messages, tools, maxTokens, signal }) {
  const body = {
    model,
    max_tokens: maxTokens || 4096,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: toAnthropicMessages(messages),
  };
  if (tools?.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const data = await postJson(`${cfg.baseUrl}/messages`, anthropicHeaders(cfg), body, signal);
  const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const toolCalls = data.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
  return { text, toolCalls, usage: data.usage, stop: data.stop_reason };
}

// ---------- OpenAI-compatible ----------

export function toOpenAIMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({
        role: 'user',
        content: m.content.map((p) => (p.type === 'image'
          ? { type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.data}` } }
          : { type: 'text', text: p.text })),
      });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.text || '' };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
      }
      out.push(msg);
    } else {
      // Tool messages are text-only in this format; images follow as a user message.
      const images = [];
      for (const r of m.results) {
        const text = r.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
        const imgs = r.content.filter((p) => p.type === 'image');
        images.push(...imgs);
        out.push({ role: 'tool', tool_call_id: r.id, content: (r.isError ? 'ERROR: ' : '') + (text || (imgs.length ? '[screenshot attached below]' : 'ok')) });
      }
      if (images.length) {
        out.push({ role: 'user', content: [{ type: 'text', text: 'Screenshot from the tool call above:' },
          ...images.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.data}` } }))] });
      }
    }
  }
  return out;
}

async function openaiChat({ cfg, model, system, messages, tools, maxTokens, signal }) {
  const body = { model, messages: toOpenAIMessages(system, messages), max_tokens: maxTokens || 4096 };
  if (tools?.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  }
  const data = await postJson(`${cfg.baseUrl}/chat/completions`, openaiHeaders(cfg), body, signal);
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('Model returned no message');
  const toolCalls = (msg.tool_calls || []).map((c, i) => {
    let args = {};
    try { args = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch { args = { __invalid: c.function.arguments }; }
    return { id: c.id || `call_${Date.now()}_${i}`, name: c.function.name, args };
  });
  return { text: msg.content || '', toolCalls, usage: data.usage, stop: data.choices[0].finish_reason };
}

/** One model turn with tools. Returns {text, toolCalls, usage}. */
export function chat(opts) {
  return opts.cfg.api === 'anthropic' ? anthropicChat(opts) : openaiChat(opts);
}

/** Single-shot completion that must return a JSON object. */
export async function completeJson({ cfg, model, system, user, maxTokens = 512, signal }) {
  let text;
  if (cfg.api === 'anthropic') {
    const data = await postJson(`${cfg.baseUrl}/messages`, anthropicHeaders(cfg), {
      model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }],
    }, signal);
    text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  } else {
    const body = {
      model, max_tokens: maxTokens, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    };
    if (cfg.id === 'deepseek') body.thinking = { type: 'disabled' };
    const data = await postJson(`${cfg.baseUrl}/chat/completions`, openaiHeaders(cfg), body, signal);
    text = data.choices?.[0]?.message?.content || '';
  }
  return parseJsonObject(text);
}

export function parseJsonObject(text) {
  const cleaned = String(text).replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('Model did not return a JSON object');
  }
}
