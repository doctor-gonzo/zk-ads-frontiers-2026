// AI-usage badges for cards: a tile on the card's "you" page showing how
// much the person uses AI, either proved with zkTLS (Codex tokens, through
// Reclaim's Popcorn browser) or read from their own logs by usage-stats.mjs.
import { plainText } from './concept.mjs';

// 1234 → "1.2K", 290081935 → "290M".
export function formatCount(n) {
  const value = Math.max(0, Math.round(Number(n) || 0));
  for (const [size, unit] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${unit}`;
    }
  }
  return String(value);
}

// The script's output: short keys with plain numbers or short strings.
export function cleanStats(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw)
    .filter(([key, value]) => /^[a-z_]{1,32}$/.test(key) && ((typeof value === 'number' && Number.isFinite(value) && value >= 0) || (typeof value === 'string' && value.length <= 40)))
    .slice(0, 16);
  return entries.length ? Object.fromEntries(entries) : null;
}

const TOOLS = { claude_code: 'Claude Code', codex: 'Codex' };

// Plausible numbers only: a year at most, and no more tokens than a very
// busy person could use in it.
export function badgeFromStats(stats) {
  const days = Number.isInteger(stats.period_days) && stats.period_days >= 1 && stats.period_days <= 365 ? stats.period_days : 30;
  if (!(stats.tokens > 0 && stats.tokens <= 1e12)) return null;
  const tool = TOOLS[stats.main_tool];
  return cleanBadge({ value: formatCount(stats.tokens), label: `AI tokens in ${days} days${tool ? `, mostly ${tool}` : ''}`, source: 'logs' });
}

// source: 'zktls' (a proof the enclave verified), 'fixture' (the test
// stand-in for one) or 'logs' (the person's own numbers).
export function cleanBadge(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const badge = { value: plainText(raw.value, 12), label: plainText(raw.label, 60), source: ['zktls', 'fixture'].includes(raw.source) ? raw.source : 'logs' };
  return badge.value && badge.label ? badge : null;
}
