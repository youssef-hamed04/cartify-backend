// Inventory rules that turn a demand forecast into stock decisions. Shared by the forecast module,
// the inventory endpoints and the inventory agent, so every screen and the AI use the same numbers.
const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);
const Z = { 0.9: 1.2816, 0.95: 1.6449, 0.975: 1.96, 0.99: 2.3263 };

export function policySettings() {
  const serviceLevel = num(process.env.FORECAST_SERVICE_LEVEL, 0.95);
  const nearest = Object.keys(Z).map(Number).reduce((a, b) => (Math.abs(b - serviceLevel) < Math.abs(a - serviceLevel) ? b : a));
  return {
    leadTimeDays: Math.max(1, num(process.env.FORECAST_LEAD_TIME_DAYS, 7)),   // days for a delivery/transfer to arrive
    serviceLevel: nearest,
    z: Z[nearest],
    minSafetyDays: Math.max(0, num(process.env.SAFETY_STOCK_MIN_DAYS, 3)),    // safety stock is at least N days of demand
    excessCoverDays: Math.max(7, num(process.env.EXCESS_COVER_DAYS, 60)),     // stock beyond need + N days of demand is excess
    minTransferQty: Math.max(1, num(process.env.MIN_TRANSFER_QTY, 2)),
    lowStockUnits: Math.max(0, num(process.env.LOW_STOCK_UNITS, 5)),          // fallback threshold when there is no forecast
  };
}

const RISK_ORDER = { high: 3, medium: 2, low: 1, none: 0 };
export const worstRisk = (risks) => risks.reduce((a, b) => (RISK_ORDER[b] > RISK_ORDER[a] ? b : a), 'none');

/**
 * @param f  { predicted, low, high, horizonDays } — forecast for one product at one location
 * @param s  { onHand, reserved, inbound, safetyOverride }
 */
export function evaluateStock(f, s, settings = policySettings()) {
  const H = f.horizonDays;
  const rate = Math.max(0, (f.predicted || 0) / H);
  const sigmaH = Math.max(0, ((f.high ?? f.predicted) - (f.low ?? f.predicted)) / 2.5631); // 10–90 % ≈ ±1.2816 σ
  const computedSafety = Math.ceil(Math.max(settings.z * sigmaH * Math.sqrt(settings.leadTimeDays / H), rate * settings.minSafetyDays));
  const safetyStock = Number.isFinite(s.safetyOverride) ? s.safetyOverride : computedSafety;
  const available = Math.max(0, (s.onHand || 0) - (s.reserved || 0));
  const inbound = s.inbound || 0;
  const need = (f.predicted || 0) + safetyStock;
  const position = available + inbound;
  const suggestedReplenishment = Math.max(0, Math.ceil(need - position));
  const surplusUnits = Math.max(0, Math.floor(position - need));                       // spare after its own need: transferable
  const excessUnits = Math.max(0, Math.floor(position - need - rate * settings.excessCoverDays)); // long-term overstock
  const daysOfCover = rate > 0 ? +(available / rate).toFixed(1) : null;
  let shortageRisk = 'none';
  if (rate > 0) {
    if (position < rate * settings.leadTimeDays) shortageRisk = 'high';      // runs out before a delivery could arrive
    else if (position < (f.predicted || 0)) shortageRisk = 'medium';         // will not cover the forecast horizon
    else if (position < need) shortageRisk = 'low';                          // covers demand but not the safety buffer
  }
  return { currentStock: s.onHand || 0, reserved: s.reserved || 0, available, inbound, safetyStock, suggestedReplenishment, surplusUnits, excessUnits, daysOfCover, shortageRisk };
}
