import { v4 as uuidv4 } from 'uuid';

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mobile clients send the guest session in the X-Session-Id header instead of a cookie
export const getRequestSessionId = (req) => {
  const fromHeader = req.headers['x-session-id'];
  if (fromHeader && UUID_RE.test(fromHeader)) return fromHeader;
  return req.cookies?.sessionId;
};

export const attachSession = (req, res, next) => {

  if (req.user) {
    req.sessionId = null;
    return next();
  } else {

    const existingSession = getRequestSessionId(req);
    if (!existingSession && !req.cookies?.token) {
      const newSession = uuidv4();
      res.cookie('sessionId', newSession, {
        httpOnly: true,
        maxAge: SEVEN_DAYS,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        path: '/',
      });
      res.setHeader('X-Session-Id', newSession);
      console.log("🟢 Created new sessionId:", newSession);
      req.sessionId = newSession;
    }
    else {
      console.log("✅ Existing sessionId:", existingSession);
      req.sessionId = existingSession;
    }
  }
  next();
};

export const clearSessionCookie = (res) => {
  res.clearCookie('sessionId', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/',
  });
};
