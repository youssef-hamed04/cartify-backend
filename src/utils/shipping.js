const SHIPPING_RATES = {
  Cairo: 50, Giza: 60, Alexandria: 70, Qalyubia: 70,
  Dakahlia: 80, Sharqia: 80, Gharbia: 80,
  Ismailia: 90, Suez: 90, 'Port Said': 90,
  Luxor: 120, Aswan: 130,
};
const DEFAULT_RATE = 100;

export const calculateShipping = (governorate = '') =>
  SHIPPING_RATES[governorate] ?? DEFAULT_RATE;

export const getShippingRates = () => ({ ...SHIPPING_RATES, default: DEFAULT_RATE });
