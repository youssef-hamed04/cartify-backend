// Tool-use loop shared by the shopping assistant and the inventory agent.
// The model decides which tools to call; every call is validated against its schema, executed with
// the caller's own credentials (see internalApi.js) and logged. Tools that would change data never
// act directly: they return a pending action that the person must confirm in the UI.
import { createMessage } from './llmClient.js';
import { validateToolInput } from './toolSchema.js';
import aiActionLogModel from '../../../db/models/aiActionLog.model.js';

const MAX_MODEL_CALLS = 8;           // per user message
const MAX_TOOL_RESULT_CHARS = 14000;  // keeps one tool result from flooding the context
const MAX_STORED_MESSAGES = 60;       // older turns are dropped beyond this
const KEEP_ON_TRIM = 40;

const textOf = (content) => (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
const truncateJson = (obj) => {
  const s = JSON.stringify(obj ?? null);
  return s.length <= MAX_TOOL_RESULT_CHARS ? s : `${s.slice(0, MAX_TOOL_RESULT_CHARS)}… [truncated: ask for fewer results]`;
};
const sanitize = (input) => JSON.parse(JSON.stringify(input ?? {}, (k, v) => (typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v)));

/**
 * Trim stored history without breaking it: cut at a plain user turn and drop every thinking block
 * that remains (thinking blocks are only valid with their full original prefix).
 */
export function trimHistory(messages) {
  if (messages.length <= MAX_STORED_MESSAGES) return messages;
  let start = messages.length - KEEP_ON_TRIM;
  while (start < messages.length && !(messages[start].role === 'user' && Array.isArray(messages[start].content) && messages[start].content.every((b) => b.type === 'text'))) start++;
  if (start >= messages.length) return messages;
  return messages.slice(start).map((m) => (m.role === 'assistant' && Array.isArray(m.content)
    ? { ...m, content: m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking') }
    : m));
}

/**
 * @param agent         'shopping' | 'inventory'
 * @param system        stable system prompt (cached)
 * @param tools         [{ name, description, input_schema, handler(input, runCtx) → { data, block? } }]
 * @param conversation  assistantConversation document (messages are appended in place)
 * @param userContent   content blocks for the new user turn
 * @param runCtx        { api, conversation, blocks, ... } passed to every handler
 */
export async function runAgent({ agent, system, tools, conversation, userContent, runCtx }) {
  const registry = new Map(tools.map((t) => [t.name, t]));
  const toolDefs = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  const messages = [...conversation.messages, { role: 'user', content: userContent }];
  const blocks = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const toolCalls = [];
  let finalText = '';
  let refused = false;

  const execute = async (use) => {
    const t0 = Date.now();
    const tool = registry.get(use.name);
    const log = (ok, error) => {
      toolCalls.push({ tool: use.name, ok, ms: Date.now() - t0 });
      console.log(`[ai:${agent}] tool ${use.name} ${ok ? 'ok' : `failed: ${error}`} (${Date.now() - t0} ms)`);
      aiActionLogModel.create({ agent, conversationId: conversation._id, userId: runCtx.api.user?.id || null, sessionId: runCtx.api.sessionId, tool: use.name, input: sanitize(use.input), ok, error, durationMs: Date.now() - t0 }).catch(() => {});
    };
    if (!tool) { log(false, 'unknown tool'); return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Unknown tool "${use.name}"` }; }
    const v = validateToolInput(tool.input_schema, use.input);
    if (!v.ok) { log(false, v.errors.join('; ')); return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Invalid arguments: ${v.errors.join('; ')}` }; }
    try {
      const out = await tool.handler(v.value, { ...runCtx, blocks });
      if (out?.block) blocks.push(out.block);
      log(true);
      return { type: 'tool_result', tool_use_id: use.id, content: truncateJson(out?.data) };
    } catch (err) {
      const msg = err.isToolError ? err.message : 'The tool failed unexpectedly';
      if (!err.isToolError) console.error(`[ai:${agent}] ${use.name} crashed:`, err);
      log(false, msg);
      return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: JSON.stringify({ error: msg, status: err.status || 500 }) };
    }
  };

  for (let call = 1; call <= MAX_MODEL_CALLS; call++) {
    const response = await createMessage({ system, tools: toolDefs, messages });
    usage.inputTokens += (response.usage?.input_tokens || 0) + (response.usage?.cache_creation_input_tokens || 0);
    usage.cacheReadTokens += response.usage?.cache_read_input_tokens || 0;
    usage.outputTokens += response.usage?.output_tokens || 0;
    messages.push({ role: 'assistant', content: response.content });

    const uses = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason === 'refusal') {
      refused = true;
      finalText = "Sorry, I can't help with that request.";
      if (uses.length) messages.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Not run.' })) });
      break;
    }
    if (!uses.length || response.stop_reason === 'end_turn') {
      finalText = textOf(response.content);
      if (uses.length) messages.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Not run.' })) });
      break;
    }
    if (response.stop_reason === 'max_tokens') {
      // A tool call cut off mid-input must not run; close the turn so the history stays valid.
      messages.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Not run: the response was cut off.' })) });
      finalText = textOf(response.content) || 'Sorry, that answer got too long. Could you narrow the question down?';
      break;
    }
    const results = await Promise.all(uses.map(execute)); // parallel calls → one user message
    if (call === MAX_MODEL_CALLS - 1) results.push({ type: 'text', text: 'Tool budget for this message is almost used up: answer now with the information you have.' });
    messages.push({ role: 'user', content: results });
    if (call === MAX_MODEL_CALLS) finalText = 'Sorry, I could not finish that. Could you ask in a simpler way?';
  }

  conversation.messages = trimHistory(messages);
  conversation.usage = {
    inputTokens: (conversation.usage?.inputTokens || 0) + usage.inputTokens,
    outputTokens: (conversation.usage?.outputTokens || 0) + usage.outputTokens,
    cacheReadTokens: (conversation.usage?.cacheReadTokens || 0) + usage.cacheReadTokens,
    turns: (conversation.usage?.turns || 0) + 1,
  };
  conversation.lastActivityAt = new Date();
  conversation.markModified('messages');
  console.log(`[ai:${agent}] turn done: ${toolCalls.length} tool call(s), ${usage.inputTokens}+${usage.cacheReadTokens} cached in / ${usage.outputTokens} out tokens`);
  return { text: finalText, blocks, toolCalls, usage, refused };
}
