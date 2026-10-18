// User settings live in chrome.storage.local (never sync: it holds API keys).

export const PROVIDERS = {
  anthropic: { label: 'Anthropic', api: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', keyless: false,
    models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'] },
  openai: { label: 'OpenAI', api: 'openai', baseUrl: 'https://api.openai.com/v1', keyless: false,
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1-mini'] },
  openrouter: { label: 'OpenRouter', api: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyless: false,
    models: ['anthropic/claude-sonnet-5.5', 'google/gemini-2.5-flash', 'inception/mercury-2.5', 'deepseek/deepseek-chat'] },
  gemini: { label: 'Google Gemini', api: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyless: false,
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'] },
  together: { label: 'Together AI', api: 'openai', baseUrl: 'https://api.together.xyz/v1', keyless: false,
    models: ['together/Tev1-4B-experimental', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-7B-Instruct-Turbo'] },
  groq: { label: 'Groq', api: 'openai', baseUrl: 'https://api.groq.com/openai/v1', keyless: false,
    models: ['llama-3.3-70b-versatile', 'moonshotai/kimi-k2-instruct'] },
  deepseek: { label: 'DeepSeek', api: 'openai', baseUrl: 'https://api.deepseek.com/v1', keyless: false,
    models: ['deepseek-chat'] },
  ollama: { label: 'Ollama (local)', api: 'openai', baseUrl: 'http://localhost:11434/v1', keyless: true,
    models: ['qwen3:8b', 'llama3.2', 'gemma3'] },
  lmstudio: { label: 'LM Studio (local)', api: 'openai', baseUrl: 'http://localhost:1234/v1', keyless: true, models: [] },
  custom: { label: 'Custom (OpenAI-compatible)', api: 'openai', baseUrl: '', keyless: true, models: [] },
};

// Ultrafast decision backends. "systemone" speaks the TypeSafe request format
// (operation + per-operation target heads in one call); any compatible decision
// model (Jev or others) can be plugged in by URL + model name.
export const DECISION_BACKENDS = {
  systemone: { label: 'Decision API (TypeSafe Jev or compatible)', url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' },
  choice: { label: 'Letter-choice decision model (Together Tev1)' },
  llm: { label: 'Any LLM (single JSON decision call)' },
};

export const DEFAULTS = {
  mode: 'normal',
  providers: Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, { apiKey: '', baseUrl: '' }])),
  normal: { provider: 'anthropic', model: 'claude-sonnet-5-5', vision: true, maxSteps: 40 },
  ultrafast: {
    backend: 'systemone',
    systemoneUrl: DECISION_BACKENDS.systemone.url,
    systemoneModel: DECISION_BACKENDS.systemone.model,
    systemoneKey: '',
    choiceProvider: 'together',
    choiceModel: 'together/Tev1-4B-experimental',
    decisionProvider: 'groq',
    decisionModel: 'llama-3.3-70b-versatile',
    textProvider: 'anthropic',
    textModel: 'claude-haiku-5-5',
    maxActions: 60,
  },
  tasks: { stepsPerSubtask: 40, maxTotalSteps: 400 },
  bridge: { enabled: true, port: 12306 },
  tools: { allowJavascript: true, showIndicator: true, groupTabs: true },
};

function merge(base, patch) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return merge(DEFAULTS, settings || {});
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
  return settings;
}

/** Resolve a provider id into {api, baseUrl, apiKey}. */
export function providerConfig(settings, id) {
  const preset = PROVIDERS[id];
  if (!preset) throw new Error(`Unknown provider "${id}"`);
  const user = settings.providers?.[id] || {};
  const baseUrl = (user.baseUrl || preset.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error(`Set a base URL for ${preset.label} in Settings.`);
  if (!preset.keyless && !user.apiKey) throw new Error(`Add your ${preset.label} API key in Settings.`);
  return { id, api: preset.api, baseUrl, apiKey: user.apiKey || '' };
}
