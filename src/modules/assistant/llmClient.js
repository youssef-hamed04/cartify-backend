// Claude (Anthropic Messages API) client for the Cartify agents. The API key stays on the server:
// set ANTHROPIC_API_KEY in .env. Nothing here is ever sent to the browser or the mobile app.
import Anthropic from '@anthropic-ai/sdk';
import { AppError } from '../../utils/error.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Models that accept the server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = ['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];

export const llmSettings = () => {
  const model = process.env.AI_MODEL || 'claude-opus-5-5';
  return {
    model,
    effort: EFFORTS.includes(process.env.AI_EFFORT) ? process.env.AI_EFFORT : 'medium',
    maxTokens: Math.min(Math.max(parseInt(process.env.AI_MAX_TOKENS, 10) || 16000, 1024), 64000),
    fallbacks: process.env.AI_FALLBACKS !== 'off' && FALLBACK_MODELS.includes(model),
  };
};

export const isLlmConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

let client = null;
const getClient = () => (client ??= new Anthropic({ maxRetries: 2, timeout: 120_000 }));

/** One Messages API call. Returns the SDK message object. Throws AppError with a safe message. */
export async function createMessage({ system, tools, messages }) {
  if (!isLlmConfigured()) throw new AppError('The AI assistant is not available: the server has no AI provider key configured.', 503);
  const s = llmSettings();
  const params = {
    model: s.model,
    max_tokens: s.maxTokens,
    system,
    tools,
    messages,
    output_config: { effort: s.effort },
    cache_control: { type: 'ephemeral' }, // system prompt + tools + history are a stable prefix
  };
  if (s.fallbacks) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  try {
    return await getClient().beta.messages.create(params);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      console.error('[ai] provider rejected the API key:', err.message);
      throw new AppError('The AI assistant is not available right now (provider authentication failed).', 503);
    }
    if (err instanceof Anthropic.RateLimitError) throw new AppError('The assistant is busy right now. Please try again in a moment.', 429);
    if (err instanceof Anthropic.BadRequestError) {
      console.error('[ai] bad request:', err.message);
      throw new AppError('The assistant could not process this request.', 502);
    }
    if (err instanceof Anthropic.APIConnectionError) {
      console.error('[ai] connection error:', err.message);
      throw new AppError('The AI provider could not be reached. Please try again.', 503);
    }
    if (err instanceof Anthropic.APIError) {
      console.error(`[ai] provider error ${err.status}:`, err.message);
      throw new AppError('The AI provider is temporarily unavailable. Please try again.', 503);
    }
    throw err;
  }
}
