export const sendSuccess = (res, statusCode = 200, msg = 'success', data = {}) => {
  res.status(statusCode).json({ msg, ...data });
};
