import mongoose from 'mongoose';
import assistantConversationModel from '../../../db/models/assistantConversation.model.js';
import aiActionLogModel from '../../../db/models/aiActionLog.model.js';
import connectToDB from '../../../db/connectionDB.js';
import { AppError, asyncHandler } from '../../utils/error.js';
import { sendSuccess } from '../../utils/response.js';
import { runAgent } from './agentRunner.js';
import { apiContextFromRequest, callApi } from './internalApi.js';
import { isLlmConfigured } from './llmClient.js';
import { INVENTORY_SYSTEM_PROMPT, SHOPPING_SYSTEM_PROMPT } from './prompts.js';
import { shoppingTools } from './shopping.tools.js';
import { inventoryTools } from './inventory.tools.js';

const AGENTS = {
  shopping: { system: SHOPPING_SYSTEM_PROMPT, tools: shoppingTools },
  inventory: { system: INVENTORY_SYSTEM_PROMPT, tools: inventoryTools },
};
const MAX_MESSAGE_CHARS = 2000;

// The owner of a conversation is the signed-in user, or the guest session that started it.
const ownerFilter = (req) => (req.user ? { userId: req.user._id } : { sessionId: req.sessionId, userId: null });

async function findConversation(req, agent, id) {
  if (!mongoose.isValidObjectId(id)) throw new AppError('Conversation not found', 404);
  const conv = await assistantConversationModel.findOne({ _id: id, agent, ...ownerFilter(req) });
  if (!conv) throw new AppError('Conversation not found', 404);
  return conv;
}

const turnContext = (req) => {
  const today = new Date().toISOString().slice(0, 10);
  const who = req.user ? `signed in${req.user.firstName ? ` as ${req.user.firstName}` : ''}${req.user.role === 'admin' ? ' (administrator)' : ''}` : 'guest (not signed in)';
  return `<turn_context>date: ${today}; ${who}</turn_context>`;
};

// What the UI shows for a turn: model text (AI-generated) and blocks (verified data from tools).
const publicActions = (conv) => conv.pendingActions.filter((a) => a.status === 'pending' && a.expiresAt > new Date()).map((a) => ({ actionId: a.actionId, type: a.type, summary: a.summary, expiresAt: a.expiresAt }));

const chat = (agent) => asyncHandler(async (req, res) => {
  await connectToDB();
  const message = String(req.body.message || '').trim();
  if (!message) throw new AppError('message is required', 400);
  if (message.length > MAX_MESSAGE_CHARS) throw new AppError(`message must be at most ${MAX_MESSAGE_CHARS} characters`, 400);
  if (!isLlmConfigured()) throw new AppError('The AI assistant is not available right now.', 503);

  const conv = req.body.conversationId
    ? await findConversation(req, agent, req.body.conversationId)
    : await assistantConversationModel.create({ agent, ...ownerFilter(req) });
  // Text that imitates the server's context block is neutralised
  const safe = message.replace(/<\/?\s*turn_context[^>]*>/gi, '');
  const { system, tools } = AGENTS[agent];
  const runCtx = { api: apiContextFromRequest(req), conversation: conv, cache: {} };

  let result;
  try {
    result = await runAgent({ agent, system, tools, conversation: conv, userContent: [{ type: 'text', text: turnContext(req) }, { type: 'text', text: safe }], runCtx });
  } catch (err) {
    aiActionLogModel.create({ agent, conversationId: conv._id, userId: req.user?._id || null, sessionId: req.sessionId || null, tool: 'llm', kind: 'llm_error', ok: false, error: err.message }).catch(() => {});
    if (!conv.messages.length) await conv.deleteOne().catch(() => {});
    throw err;
  }
  const now = new Date();
  conv.transcript.push({ role: 'user', text: message, at: now }, { role: 'assistant', text: result.text, blocks: result.blocks, at: now });
  conv.markModified('transcript');
  await conv.save();
  sendSuccess(res, 200, 'success', {
    conversationId: String(conv._id),
    reply: { text: result.text, blocks: result.blocks, aiGenerated: true },
    pendingActions: publicActions(conv),
    toolCalls: result.toolCalls.map((t) => t.tool),
  });
});

export const shoppingChat = chat('shopping');
export const inventoryChat = chat('inventory');

const getConversation = (agent) => asyncHandler(async (req, res) => {
  await connectToDB();
  const conv = await findConversation(req, agent, req.params.id);
  sendSuccess(res, 200, 'success', { conversationId: String(conv._id), transcript: conv.transcript, pendingActions: publicActions(conv) });
});
export const getShoppingConversation = getConversation('shopping');
export const getInventoryConversation = getConversation('inventory');

const deleteConversation = (agent) => asyncHandler(async (req, res) => {
  await connectToDB();
  const conv = await findConversation(req, agent, req.params.id);
  await conv.deleteOne();
  sendSuccess(res, 200, 'success', { message: 'Conversation deleted' });
});
export const deleteShoppingConversation = deleteConversation('shopping');
export const deleteInventoryConversation = deleteConversation('inventory');

// Executes a pending action after the person pressed Confirm — through the normal REST API with
// their own credentials (cart limits, stock checks and admin checks all apply as usual).
async function executeAction(req, action) {
  const api = apiContextFromRequest(req);
  if (action.type === 'add_to_cart') {
    const { productId, productName, color, quantity } = action.payload;
    const r = await callApi(api, 'POST', '/cart', { body: { productId, color, quantity } });
    if (r.stockLimitReached) throw new AppError(`Only ${r.available} left in stock — nothing was added.`, 409);
    return { message: `Added ${quantity} × ${productName || 'item'} (${color}) to your cart.`, cart: { totalQuantity: r.totalQuantity, subtotal: r.subtotal } };
  }
  if (action.type === 'create_stock_transfer_request') {
    if (req.user?.role !== 'admin') throw new AppError('Admin access required.', 403);
    const r = await callApi(api, 'POST', '/inventory/movements', { body: { type: 'transfer', ...action.payload }, headers: { 'X-Requested-Via': 'inventory_agent' } });
    return { message: `Transfer request #${r.movement.movementNumber} created. Approve and complete it on the Branch & Inventory page.`, movement: { id: r.movement._id, number: r.movement.movementNumber, status: r.movement.status } };
  }
  throw new AppError('Unknown action', 400);
}

const decide = (agent, decision) => asyncHandler(async (req, res) => {
  await connectToDB();
  const conv = await findConversation(req, agent, req.body.conversationId);
  const action = conv.pendingActions.find((a) => a.actionId === req.params.actionId);
  if (!action) throw new AppError('Action not found', 404);
  if (action.status !== 'pending') throw new AppError(`This action was already ${action.status}`, 409);
  if (action.expiresAt < new Date()) { action.status = 'expired'; await conv.save(); throw new AppError('This confirmation expired. Ask the assistant again.', 410); }

  // Mark it decided first so a double click cannot run it twice
  const claimed = await assistantConversationModel.updateOne(
    { _id: conv._id, pendingActions: { $elemMatch: { actionId: action.actionId, status: 'pending' } } },
    { $set: { 'pendingActions.$.status': decision === 'confirm' ? 'confirmed' : 'cancelled', 'pendingActions.$.decidedAt': new Date() } },
  );
  if (!claimed.modifiedCount) throw new AppError('This action was already handled', 409);

  let outcome, ok = true, note;
  if (decision === 'confirm') {
    try {
      outcome = await executeAction(req, action);
      note = `Confirmed by the ${agent === 'shopping' ? 'customer' : 'admin'}: ${action.summary}. Result: ${outcome.message}`;
    } catch (err) {
      ok = false;
      outcome = { message: err.message };
      note = `The ${agent === 'shopping' ? 'customer' : 'admin'} confirmed "${action.summary}" but it failed: ${err.message}`;
      await assistantConversationModel.updateOne({ _id: conv._id, 'pendingActions.actionId': action.actionId }, { $set: { 'pendingActions.$.status': 'failed', 'pendingActions.$.result': outcome } });
    }
  } else {
    outcome = { message: 'Cancelled — nothing was changed.' };
    note = `The ${agent === 'shopping' ? 'customer' : 'admin'} cancelled: ${action.summary}`;
  }
  if (ok) await assistantConversationModel.updateOne({ _id: conv._id, 'pendingActions.actionId': action.actionId }, { $set: { 'pendingActions.$.result': outcome } });
  // Tell the model what happened on the next turn (appended, never rewritten)
  await assistantConversationModel.updateOne({ _id: conv._id }, {
    $push: {
      messages: { role: 'user', content: [{ type: 'text', text: `<turn_context>${note}</turn_context>` }] },
      transcript: { role: 'system', text: outcome.message, ok, at: new Date() },
    },
  });
  aiActionLogModel.create({ agent, conversationId: conv._id, userId: req.user?._id || null, sessionId: req.sessionId || null, tool: action.type, kind: decision === 'confirm' ? 'confirmed_action' : 'cancelled_action', input: action.payload, ok, error: ok ? undefined : outcome.message }).catch(() => {});
  console.log(`[ai:${agent}] action ${action.type} ${decision}${ok ? '' : ' (failed)'} by ${req.user?.email || `guest ${req.sessionId}`}`);
  if (!ok) throw new AppError(outcome.message, 409);
  sendSuccess(res, 200, 'success', { actionId: action.actionId, status: decision === 'confirm' ? 'confirmed' : 'cancelled', result: outcome });
});

export const confirmShoppingAction = decide('shopping', 'confirm');
export const cancelShoppingAction = decide('shopping', 'cancel');
export const confirmInventoryAction = decide('inventory', 'confirm');
export const cancelInventoryAction = decide('inventory', 'cancel');

export const status = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'success', { enabled: isLlmConfigured(), agents: { shopping: true, inventory: req.user?.role === 'admin' } });
});
