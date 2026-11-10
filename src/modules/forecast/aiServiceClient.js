// HTTP client for the Python AI service (ai-service/). The service only computes; it has no DB access.
import { AppError } from '../../utils/error.js';

const baseUrl = () => (process.env.AI_SERVICE_URL || 'http://127.0.0.1:8001').replace(/\/$/, '');
const timeoutMs = () => parseInt(process.env.AI_SERVICE_TIMEOUT_MS, 10) || 120_000;

async function call(path, { method = 'GET', body, timeout = timeoutMs() } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (process.env.AI_SERVICE_KEY) headers['X-AI-Service-Key'] = process.env.AI_SERVICE_KEY;
  let res;
  try {
    res = await fetch(baseUrl() + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    const why = err.name === 'TimeoutError' ? 'timed out' : 'is not reachable';
    throw new AppError(`The demand forecasting service ${why} (${baseUrl()}). Start it with the instructions in ai-service/README.md.`, 503);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : Array.isArray(data.detail) ? data.detail.map((d) => d.msg).slice(0, 3).join('; ') : '';
    console.error(`[ai-service] ${method} ${path} → ${res.status} ${detail}`);
    throw new AppError(`The demand forecasting service returned an error${detail ? `: ${detail}` : ''}`, res.status === 401 ? 503 : 502);
  }
  return data;
}

export const aiServiceHealth = async () => {
  try { return { reachable: true, url: baseUrl(), ...(await call('/health', { timeout: 3000 })) }; }
  catch (err) { return { reachable: false, url: baseUrl(), error: err.message }; }
};

export const requestForecast = (payload) => call('/forecast', { method: 'POST', body: payload });
