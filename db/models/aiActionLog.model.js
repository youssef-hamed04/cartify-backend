import { Schema, model } from 'mongoose';

// Audit log of every tool call and confirmed action made by the AI agents (kept 90 days).
const aiActionLogSchema = new Schema(
  {
    agent:          { type: String, enum: ['shopping', 'inventory'], required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'assistantConversation' },
    userId:         { type: Schema.Types.ObjectId, ref: 'user', default: null },
    sessionId:      { type: String, default: null },
    tool:           { type: String, required: true },
    kind:           { type: String, enum: ['tool_call', 'confirmed_action', 'cancelled_action', 'llm_error'], default: 'tool_call' },
    input:          { type: Schema.Types.Mixed },
    ok:             { type: Boolean, required: true },
    error:          { type: String },
    durationMs:     { type: Number },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

aiActionLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86_400 });
aiActionLogSchema.index({ conversationId: 1, createdAt: 1 });

export default model('aiActionLog', aiActionLogSchema);
