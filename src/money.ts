import { AppError } from './errors.js';

const MONEY_PATTERN = /^\d+\.\d{2}$/;
const RATE_PATTERN = /^\d+\.\d{1,6}$/;

const MICROS = 1_000_000;

export interface ExchangeRateSnapshot {
  baseCurrency: string;
  rates: Record<string, string>;
  timestamp: string;
}

export const parseMoney = (value: string) => {
  if (!MONEY_PATTERN.test(value)) {
    throw new AppError(400, 'INVALID_REQUEST', 'Amount must be a decimal string with 2 fractional digits');
  }

  const [whole, fraction] = value.split('.');
  return Number.parseInt(whole, 10) * 100 + Number.parseInt(fraction, 10);
};

export const formatMoney = (minor: number) => {
  const sign = minor < 0 ? '-' : '';
  const absolute = Math.abs(minor);
  const whole = Math.floor(absolute / 100);
  const fraction = `${absolute % 100}`.padStart(2, '0');
  return `${sign}${whole}.${fraction}`;
};

export const parseRate = (value: string) => {
  if (!RATE_PATTERN.test(value)) {
    throw new AppError(503, 'CENTRAL_BANK_UNAVAILABLE', 'Exchange rate cache contains malformed data');
  }

  const [whole, fraction = ''] = value.split('.');
  const microsFraction = `${fraction}000000`.slice(0, 6);
  return Number.parseInt(whole, 10) * MICROS + Number.parseInt(microsFraction, 10);
};

export const formatRate = (microsValue: number) => {
  const whole = Math.floor(microsValue / MICROS);
  const fraction = `${microsValue % MICROS}`.padStart(6, '0');
  return `${whole}.${fraction}`;
};

const roundDivision = (numerator: number, denominator: number) => Math.floor((numerator + denominator / 2) / denominator);

export const convertMoney = (
  amountMinor: number,
  fromCurrency: string,
  toCurrency: string,
  snapshot: ExchangeRateSnapshot
) => {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();

  if (from === to) {
    return {
      convertedMinor: amountMinor,
      exchangeRate: '1.000000'
    };
  }

  const lookupRate = (currency: string) => {
    if (currency === snapshot.baseCurrency.toUpperCase()) {
      return MICROS;
    }

    const rate = snapshot.rates[currency];
    if (!rate) {
      throw new AppError(400, 'UNSUPPORTED_CURRENCY', `Currency '${currency}' is not supported by this bank`);
    }

    return parseRate(rate);
  };

  const fromRate = lookupRate(from);
  const toRate = lookupRate(to);
  const convertedMinor = roundDivision(amountMinor * toRate, fromRate);
  const crossRateMicros = roundDivision(toRate * MICROS, fromRate);

  return {
    convertedMinor,
    exchangeRate: formatRate(crossRateMicros)
  };
};
