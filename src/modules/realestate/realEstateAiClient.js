import { AppError } from '../../utils/error.js';
async function call(path, body) {
  const url = (process.env.AI_SERVICE_URL || 'http://127.0.0.1:8001').replace(/\/$/, '');
  let response;
  try {
    response = await fetch(`${url}/realestate/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-AI-Service-Key': process.env.AI_SERVICE_KEY || '' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(path === 'train' ? 300000 : 15000),
    });
  } catch {
    const error = new AppError('The price estimation service is unreachable or timed out', 503);
    error.unreachable = true;
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AppError(`The price estimation service returned an error: ${typeof data.detail === 'string' ? data.detail : response.status}`, response.status === 409 ? 409 : 502);
  }
  return data;
}
export const trainModel = payload => call('train', payload);
export const estimatePrice = payload => call('estimate', payload);
export const modelStatus = () => call('status');
