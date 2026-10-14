#!/usr/bin/env node
// ZKAds usage stats: reads this computer's Claude Code and Codex logs and
// prints only numbers (tokens, sessions, active days, the night-owl share)
// as JSON. It sends nothing; show the person the output, and post it to ZKAds
// only if they agree. Needs Node 18 or later.
//
//   node usage-stats.mjs [--days 30] [--claude-dir <dir>] [--codex-dir <dir>]
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const days = Math.max(1, Math.min(365, Number(option('--days') ?? 30) || 30));
const since = Date.now() - days * 86_400_000;
const claudeDir = option('--claude-dir') ?? join(homedir(), '.claude', 'projects');
const codexDir = option('--codex-dir') ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');

const tools = { claude_code: { tokens: 0, sessions: new Set() }, codex: { tokens: 0, sessions: new Set() } };
const activeDays = new Set();
const hours = new Array(24).fill(0);

for (const file of logFiles(claudeDir)) await readClaudeCode(file);
for (const file of logFiles(codexDir)) await readCodex(file);

const tokens = tools.claude_code.tokens + tools.codex.tokens;
const touches = hours.reduce((a, b) => a + b, 0);
console.log(
  JSON.stringify(
    {
      period_days: days,
      tokens,
      sessions: tools.claude_code.sessions.size + tools.codex.sessions.size,
      active_days: activeDays.size,
      night_share: touches ? Math.round((hours.slice(0, 6).reduce((a, b) => a + b, 0) / touches) * 100) / 100 : 0,
      busiest_hour: touches ? hours.indexOf(Math.max(...hours)) : null,
      claude_code_tokens: tools.claude_code.tokens,
      codex_tokens: tools.codex.tokens,
      main_tool: tokens === 0 ? 'none' : tools.claude_code.tokens >= tools.codex.tokens ? 'claude_code' : 'codex',
    },
    null,
    2,
  ),
);

// Claude Code: one line per assistant message, with that message's token
// usage. A message can be logged more than once, so each counts once.
async function readClaudeCode(file) {
  const seen = new Map();
  for await (const entry of lines(file)) {
    const usage = entry?.type === 'assistant' ? entry.message?.usage : null;
    const at = Date.parse(entry?.timestamp ?? '');
    if (!usage || !(at >= since)) continue;
    const total = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((sum, key) => sum + (Number(usage[key]) || 0), 0);
    seen.set(entry.message.id ?? `${at}`, total);
    touch(at);
    tools.claude_code.sessions.add(entry.sessionId ?? file);
  }
  for (const total of seen.values()) tools.claude_code.tokens += total;
}

// Codex: token_count events carry the session's running total, so the
// largest one is the session's usage.
async function readCodex(file) {
  let total = 0;
  for await (const entry of lines(file)) {
    const at = Date.parse(entry?.timestamp ?? '');
    const event = entry?.type === 'event_msg' ? entry.payload : entry;
    if (event?.type !== 'token_count' || !(at >= since)) continue;
    const usage = event.info?.total_token_usage ?? event.total_token_usage;
    total = Math.max(total, Number(usage?.total_tokens) || (Number(usage?.input_tokens) || 0) + (Number(usage?.output_tokens) || 0));
    touch(at);
  }
  if (total) {
    tools.codex.tokens += total;
    tools.codex.sessions.add(file);
  }
}

function touch(at) {
  const date = new Date(at);
  activeDays.add(`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`);
  hours[date.getHours()]++;
}

// .jsonl files under `dir` changed within the period.
function logFiles(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      const info = statSync(full, { throwIfNoEntry: false });
      if (info?.isDirectory()) walk(full);
      else if (info && name.endsWith('.jsonl') && info.mtimeMs >= since) found.push(full);
    }
  };
  walk(dir);
  return found;
}

async function* lines(file) {
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!line.startsWith('{')) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // A partly written line; skip it.
    }
  }
}

function option(name) {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
}
