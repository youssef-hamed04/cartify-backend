// Local LLM client for the Cartify agents: Ollama (https://ollama.com), free and self-hosted.
// The model runs on your own machine or server: no API key, no per-request fee, no data sent to a
// third party. Start Ollama and pull the model once (see docs/AI_FEATURES.md):
//   ollama pull qwen3:4b-instruct     # or the model set in OLLAMA_MODEL
import { AppError } from '../../utils/error.js';

const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);

export const llmSettings = () => ({
  url: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
  model: process.env.OLLAMA_MODEL || 'qwen3:4b-instruct',
  // Qwen3 can "think" before answering; off by default because it is much slower on a CPU.
  think: process.env.OLLAMA_THINK === 'on',
  numCtx: Math.min(Math.max(parseInt(process.env.OLLAMA_NUM_CTX, 10) || 8192, 2048), 131072),
  temperature: num(process.env.OLLAMA_TEMPERATURE, 0.4),
  keepAlive: process.env.OLLAMA_KEEP_ALIVE || '30m', // keep the model loaded between chats
  timeoutMs: Math.max(parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 240_000, 10_000),
  maxConcurrent: Math.max(parseInt(process.env.OLLAMA_MAX_CONCURRENT, 10) || 1, 1),
  maxQueue: Math.max(parseInt(process.env.OLLAMA_MAX_QUEUE, 10) || 8, 0),
});

// ── Availability (cached for 20 s) ────────────────────────────────────────────────────────────
let statusCache = { at: 0, value: null };
export async function llmStatus({ fresh = false } = {}) {
  if (!fresh && statusCache.value && Date.now() - statusCache.at < 20_000) return statusCache.value;
  const s = llmSettings();
  let value;
  // Free/local-only policy: Ollama "cloud" models run on Ollama's servers (paid plans), so they are refused.
  if (/(^|[:-])cloud$/i.test(s.model)) {
    value = { available: false, model: s.model, reason: `"${s.model}" is an Ollama cloud model; Cartify only uses free local models. Set OLLAMA_MODEL to a local model, e.g. qwen3:4b-instruct` };
    statusCache = { at: Date.now(), value };
    return value;
  }
  try {
    const res = await fetch(`${s.url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    const names = (data.models || []).map((m) => m.name);
    const installed = names.some((n) => n === s.model || n === `${s.model}:latest`);
    value = installed
      ? { available: true, model: s.model }
      : { available: false, model: s.model, reason: `Model "${s.model}" is not downloaded. Run: ollama pull ${s.model}`, installedModels: names };
  } catch {
    value = { available: false, model: s.model, reason: `Ollama is not running at ${s.url}. Start it with: ollama serve` };
  }
  statusCache = { at: Date.now(), value };
  return value;
}

// ── Concurrency: a CPU runs one generation at a time well; extra chats wait in a short queue ──
let active = 0;
const waiting = [];
async function acquire() {
  const { maxConcurrent, maxQueue } = llmSettings();
  if (active < maxConcurrent) { active += 1; return; }
  if (waiting.length >= maxQueue) throw new AppError('The assistant is busy with other customers. Please try again in a minute.', 503);
  await new Promise((resolve) => waiting.push(resolve));
  active += 1;
}
function release() {
  active -= 1;
  waiting.shift()?.();
}

/**
 * One chat completion with tool calling (Ollama POST /api/chat, non-streaming).
 * @param system   system prompt (string)
 * @param tools    [{ type: 'function', function: { name, description, parameters } }]
 * @param messages history: { role: 'user'|'assistant'|'tool', content, tool_calls?, tool_name? }
 * @returns { message: { role, content, tool_calls? }, doneReason, promptTokens, outputTokens, ms }
 */
export async function createChat({ system, tools, messages, maxTokens }) {
  const s = llmSettings();
  if (/(^|[:-])cloud$/i.test(s.model)) throw new AppError('The AI assistant is not available right now.', 503);
  await acquire();
  const t0 = Date.now();
  try {
    let res;
    try {
      res = await fetch(`${s.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: s.model,
          messages: [{ role: 'system', content: system }, ...messages],
          tools,
          stream: false,
          think: s.think,
          keep_alive: s.keepAlive,
          options: { num_ctx: s.numCtx, temperature: s.temperature, top_p: 0.8, top_k: 20, ...(maxTokens ? { num_predict: maxTokens } : {}) },
        }),
        signal: AbortSignal.timeout(s.timeoutMs),
      });
    } catch (err) {
      statusCache.at = 0;
      if (err.name === 'TimeoutError') {
        console.error(`[ai] Ollama did not answer within ${s.timeoutMs} ms`);
        throw new AppError('The assistant took too long to answer. Please try a shorter question.', 504);
      }
      console.error('[ai] Ollama is not reachable:', err.message);
      throw new AppError('The AI assistant is not available right now.', 503);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      statusCache.at = 0;
      console.error(`[ai] Ollama error ${res.status}:`, data.error || '');
      if (res.status === 404) throw new AppError('The AI assistant is not available right now (model not downloaded).', 503);
      throw new AppError('The AI assistant could not process this request.', 502);
    }
    return {
      message: data.message || { role: 'assistant', content: '' },
      doneReason: data.done_reason,
      promptTokens: data.prompt_eval_count || 0,
      outputTokens: data.eval_count || 0,
      ms: Date.now() - t0,
    };
  } finally {
    release();
  }
}
