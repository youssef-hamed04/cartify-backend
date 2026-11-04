import { v4 as uuidv4 } from 'uuid';

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

export const attachSession = (req, res, next) => {

  if (req.user) {
    req.sessionId = null;
    return next();
  } else {

    const existingSession = req.cookies?.sessionId;
    if (!existingSession && !req.cookies?.token) {
      const newSession = uuidv4();
      res.cookie('sessionId', newSession, {
        httpOnly: true,
        maxAge: SEVEN_DAYS,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
        path: '/',
      });
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
