import { env, payments } from '../env';
import { notConfigured, HttpError } from './errors';

export type Quote = {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  currency: string;
  updatedAt: string;
  stale: boolean;
};

export const TRACKED_SYMBOLS = ['XAU/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'BTC/USD'] as const;

const TTL_MS = 60_000;
const cache = new Map<string, { quote: Quote; at: number }>();

async function fetchOne(symbol: string): Promise<Quote> {
  const url = new URL('https://api.twelvedata.com/quote');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('apikey', env.TWELVE_DATA_API_KEY);

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const body = (await res.json()) as Record<string, unknown>;

  if (!res.ok || body.status === 'error' || body.code) {
    throw new HttpError(502, 'market_data_error', `Quote unavailable for ${symbol}`, body);
  }

  const price = Number(body.close ?? body.price);
  const change = Number(body.change ?? 0);
  const changePercent = Number(body.percent_change ?? 0);

  if (!Number.isFinite(price)) {
    throw new HttpError(502, 'market_data_error', `Malformed quote for ${symbol}`);
  }

  return {
    symbol,
    price,
    change: Number.isFinite(change) ? change : 0,
    changePercent: Number.isFinite(changePercent) ? changePercent : 0,
    currency: String(body.currency ?? 'USD'),
    updatedAt: new Date().toISOString(),
    stale: false,
  };
}

/** Returns the last known quote even while the provider is failing. */
export async function getQuote(symbol: string): Promise<Quote> {
  if (!payments.marketDataEnabled) {
    throw notConfigured('Market data provider is not configured (TWELVE_DATA_API_KEY)');
  }

  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.quote;

  try {
    const quote = await fetchOne(symbol);
    cache.set(symbol, { quote, at: Date.now() });
    return quote;
  } catch (error) {
    if (cached) return { ...cached.quote, stale: true };
    throw error;
  }
}

export async function getQuotes(symbols: readonly string[] = TRACKED_SYMBOLS): Promise<{
  quotes: Quote[];
  errors: { symbol: string; message: string }[];
}> {
  const results = await Promise.allSettled(symbols.map((s) => getQuote(s)));
  const quotes: Quote[] = [];
  const errors: { symbol: string; message: string }[] = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') quotes.push(result.value);
    else
      errors.push({
        symbol: symbols[index] ?? 'unknown',
        message: result.reason instanceof Error ? result.reason.message : 'Quote failed',
      });
  });

  return { quotes, errors };
}

export function marketDataStatus() {
  return {
    provider: 'twelvedata',
    configured: payments.marketDataEnabled,
    symbols: TRACKED_SYMBOLS,
    cached: cache.size,
  };
}
