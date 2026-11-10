import { Schema, model } from 'mongoose';

// A conversation with one of the Cartify AI agents. `messages` is the exact history sent to the
// model (kept server-side so a client cannot forge earlier turns or tool results); `transcript` is
// the display version for the chat UI. Pending actions are proposals the model made that only run
// when the person presses Confirm.
const pendingActionSchema = new Schema(
  {
    actionId:  { type: String, required: true },
    type:      { type: String, enum: ['add_to_cart', 'create_stock_transfer_request'], required: true },
    payload:   { type: Schema.Types.Mixed, required: true },
    summary:   { type: String, required: true },
    status:    { type: String, enum: ['pending', 'confirmed', 'cancelled', 'failed', 'expired'], default: 'pending' },
    result:    { type: Schema.Types.Mixed, default: null },
    expiresAt: { type: Date, required: true },
    decidedAt: { type: Date, default: null },
  },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } }
);

const assistantConversationSchema = new Schema(
  {
    agent:          { type: String, enum: ['shopping', 'inventory'], required: true, index: true },
    userId:         { type: Schema.Types.ObjectId, ref: 'user', default: null, index: true },
    sessionId:      { type: String, default: null, index: true },
    messages:       { type: [Schema.Types.Mixed], default: [] },
    transcript:     { type: [Schema.Types.Mixed], default: [] },
    pendingActions: { type: [pendingActionSchema], default: [] },
    usage:          { inputTokens: { type: Number, default: 0 }, outputTokens: { type: Number, default: 0 }, cacheReadTokens: { type: Number, default: 0 }, turns: { type: Number, default: 0 } },
    lastActivityAt: { type: Date, default: Date.now },
    expiresAt:      { type: Date, default: () => new Date(Date.now() + 30 * 86_400_000) },
  },
  { timestamps: true, minimize: false }
);

assistantConversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default model('assistantConversation', assistantConversationSchema);
