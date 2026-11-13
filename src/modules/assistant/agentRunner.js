// Tool-use loop shared by the shopping assistant and the inventory agent, running on a local
// open-weight model through Ollama (see llmClient.js).
// The model decides which tools to call; every call is validated against its schema, executed with
// the caller's own credentials (see internalApi.js) and logged. Tools that would change data never
// act directly: they return a pending action that the person must confirm in the UI.
import { createChat } from './llmClient.js';
import { validateToolInput } from './toolSchema.js';
import aiActionLogModel from '../../../db/models/aiActionLog.model.js';

const MAX_MODEL_CALLS = 6;             // per user message
const MAX_TOOL_RESULT_CHARS = 6000;    // local models have small context windows
const OLD_TOOL_RESULT_CHARS = 500;     // tool results of earlier turns are shortened
const HISTORY_CHAR_BUDGET = 14000;     // ~3.5k tokens of history; older turns are dropped

const truncateJson = (obj) => {
  const s = JSON.stringify(obj ?? null);
  return s.length <= MAX_TOOL_RESULT_CHARS ? s : `${s.slice(0, MAX_TOOL_RESULT_CHARS)}… [truncated: ask for fewer results]`;
};
const sanitize = (input) => JSON.parse(JSON.stringify(input ?? {}, (k, v) => (typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v)));
// Some open models still write <think>…</think> or stray tool-call tags into the visible text.
const cleanText = (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?tool_call>/gi, '').trim();
const isUserText = (m) => m.role === 'user' && String(m.content).startsWith('<turn_context>date:'); // a real customer/admin turn

/**
 * Keep the history small enough for a local model: shorten tool results from earlier turns and
 * drop the oldest turns (cutting at a user message) when the history exceeds the budget.
 */
export function compactHistory(messages) {
  const out = messages.map((m) => (m.role === 'tool' && m.content.length > OLD_TOOL_RESULT_CHARS
    ? { ...m, content: `${m.content.slice(0, OLD_TOOL_RESULT_CHARS)}… [earlier result shortened]` }
    : m));
  let size = out.reduce((a, m) => a + JSON.stringify(m).length, 0);
  let start = 0;
  while (size > HISTORY_CHAR_BUDGET && start < out.length - 1) {
    size -= JSON.stringify(out[start]).length;
    start += 1;
    while (start < out.length - 1 && !isUserText(out[start])) { size -= JSON.stringify(out[start]).length; start += 1; }
  }
  return out.slice(start);
}

const toOllamaTools = (tools) => tools.map(({ name, description, input_schema }) => ({ type: 'function', function: { name, description, parameters: input_schema } }));

/**
 * @param agent         'shopping' | 'inventory'
 * @param system        system prompt
 * @param tools         [{ name, description, input_schema, handler(input, runCtx) → { data, block? } }]
 * @param conversation  assistantConversation document (messages are appended in place)
 * @param userText      the new user turn (server context + the person's message)
 * @param runCtx        { api, conversation, cache } passed to every handler
 */
export async function runAgent({ agent, system, tools, conversation, userText, runCtx }) {
  const registry = new Map(tools.map((t) => [t.name, t]));
  const toolDefs = toOllamaTools(tools);
  const messages = [...compactHistory(conversation.messages), { role: 'user', content: userText }];
  const blocks = [];
  const usage = { inputTokens: 0, outputTokens: 0, ms: 0 };
  const toolCalls = [];
  let finalText = '';

  const execute = async (call) => {
    const t0 = Date.now();
    const name = call.function?.name;
    let input = call.function?.arguments ?? {};
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { __unparsable: input }; } }
    const tool = registry.get(name);
    const log = (ok, error) => {
      toolCalls.push({ tool: name, ok, ms: Date.now() - t0 });
      console.log(`[ai:${agent}] tool ${name} ${ok ? 'ok' : `failed: ${error}`} (${Date.now() - t0} ms)`);
      aiActionLogModel.create({ agent, conversationId: conversation._id, userId: runCtx.api.user?.id || null, sessionId: runCtx.api.sessionId, tool: String(name || 'unknown'), input: sanitize(input), ok, error, durationMs: Date.now() - t0 }).catch(() => {});
    };
    const reply = (content) => ({ role: 'tool', tool_name: name, content });
    if (!tool) { log(false, 'unknown tool'); return reply(JSON.stringify({ error: `Unknown tool "${name}". Use one of: ${[...registry.keys()].join(', ')}` })); }
    const v = validateToolInput(tool.input_schema, input);
    if (!v.ok) { log(false, v.errors.join('; ')); return reply(JSON.stringify({ error: `Invalid arguments: ${v.errors.join('; ')}` })); }
    try {
      const out = await tool.handler(v.value, { ...runCtx, blocks });
      if (out?.block) blocks.push(out.block);
      log(true);
      return reply(truncateJson(out?.data));
    } catch (err) {
      const msg = err.isToolError ? err.message : 'The tool failed unexpectedly';
      if (!err.isToolError) console.error(`[ai:${agent}] ${name} crashed:`, err);
      log(false, msg);
      return reply(JSON.stringify({ error: msg, status: err.status || 500 }));
    }
  };

  for (let call = 1; call <= MAX_MODEL_CALLS; call++) {
    const res = await createChat({ system, tools: toolDefs, messages });
    usage.inputTokens += res.promptTokens;
    usage.outputTokens += res.outputTokens;
    usage.ms += res.ms;
    const calls = (res.message.tool_calls || []).filter((c) => c?.function?.name);
    const content = cleanText(res.message.content);
    messages.push({ role: 'assistant', content, ...(calls.length ? { tool_calls: calls.map((c) => ({ function: { name: c.function.name, arguments: c.function.arguments } })) } : {}) });
    if (!calls.length) { finalText = content; break; }
    // Run the requested tools (in parallel) and hand the results back in order
    const results = await Promise.all(calls.map(execute));
    messages.push(...results);
    if (call === MAX_MODEL_CALLS - 1) messages.push({ role: 'user', content: '<turn_context>Tool budget almost used: answer the customer now with the information you have.</turn_context>' });
    if (call === MAX_MODEL_CALLS) finalText = 'Sorry, I could not finish that. Could you ask in a simpler way?';
  }
  if (!finalText) finalText = blocks.length ? '' : 'Sorry, I could not answer that. Could you rephrase it?';

  conversation.messages = messages;
  conversation.usage = {
    inputTokens: (conversation.usage?.inputTokens || 0) + usage.inputTokens,
    outputTokens: (conversation.usage?.outputTokens || 0) + usage.outputTokens,
    cacheReadTokens: 0,
    turns: (conversation.usage?.turns || 0) + 1,
  };
  conversation.lastActivityAt = new Date();
  conversation.markModified('messages');
  console.log(`[ai:${agent}] turn done in ${usage.ms} ms: ${toolCalls.length} tool call(s), ${usage.inputTokens} prompt / ${usage.outputTokens} output tokens`);
  return { text: finalText, blocks, toolCalls, usage, refused: false };
}
