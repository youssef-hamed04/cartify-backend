export class AppError extends Error {
  constructor(message, statusCode = 500, errors = []) {
    super(message);
    this.statusCode  = statusCode;
    this.errors      = errors;
    this.isOperational = true;
  }
}

export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export const globalErrorHandler = (err, req, res, next) => {
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return res.status(409).json({ msg: 'error', err: `${field} already exists` });
  }
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({ msg: 'error', err: messages.join(', ') });
  }
  if (err.name === 'JsonWebTokenError')  return res.status(401).json({ msg: 'error', err: 'Invalid token' });
  if (err.name === 'TokenExpiredError')  return res.status(401).json({ msg: 'error', err: 'Token expired' });
  if (err.name === 'CastError')          return res.status(400).json({ msg: 'error', err: `Invalid ${err.path}: ${err.value}` });

  const statusCode = err.statusCode || 500;
  const message    = err.isOperational ? err.message : 'Internal server error';

  return res.status(statusCode).json({
    msg: 'error',
    err: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    ...(err.errors?.length && { errors: err.errors }),
  });
};
