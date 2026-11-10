// Agent tools call Cartify's own REST API with the *caller's* credentials (their JWT, or their guest
// session id). Every tool call therefore passes through the same middleware as the website and the
// mobile app — protectRoute, adminOnly, validation, ownership checks — so the model can never reach
// data the person could not reach themselves, and no business logic is duplicated for the AI.

const baseUrl = () => (process.env.INTERNAL_API_URL || `http://127.0.0.1:${process.env.PORT || 3001}`).replace(/\/$/, '');

export class ToolError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; this.isToolError = true; }
}

/** Credentials of the person talking to the agent, taken from the authenticated request. */
export function apiContextFromRequest(req) {
  const token = req.user ? (req.headers.authorization?.split(' ')[1] || req.cookies?.token || null) : null;
  return {
    token,
    sessionId: req.user ? null : req.sessionId || null,
    user: req.user ? { id: String(req.user._id), role: req.user.role, email: req.user.email, firstName: req.user.firstName } : null,
  };
}

export async function callApi(ctx, method, path, { query, body, headers = {} } = {}) {
  const qs = query ? Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : '';
  const h = { Accept: 'application/json', 'X-Internal-Caller': 'cartify-ai-agent', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (ctx.token) h.Authorization = `Bearer ${ctx.token}`;
  else if (ctx.sessionId) h['X-Session-Id'] = ctx.sessionId;
  let res;
  try {
    res = await fetch(`${baseUrl()}${path}${qs ? `?${qs}` : ''}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new ToolError('The Cartify API could not be reached', 503);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ToolError(data.err || `Request failed (${res.status})`, res.status);
  return data;
}
