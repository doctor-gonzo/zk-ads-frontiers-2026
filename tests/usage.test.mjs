import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const SCRIPT = new URL('../app/usage-stats.mjs', import.meta.url).pathname;

test('usage-stats counts Claude Code and Codex tokens once each and prints only numbers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zkads-usage-'));
  try {
    const recent = new Date(Date.now() - 2 * 86_400_000);
    recent.setHours(2, 0, 0, 0);
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const claude = join(dir, 'claude', 'project-a');
    const codex = join(dir, 'codex', '2026', '10', '08');
    mkdirSync(claude, { recursive: true });
    mkdirSync(codex, { recursive: true });
    const message = (id, at, usage) => JSON.stringify({ type: 'assistant', sessionId: 's1', timestamp: at, message: { id, usage, content: [{ type: 'text', text: 'private words' }] } });
    writeFileSync(
      join(claude, 's1.jsonl'),
      [
        message('m1', recent.toISOString(), { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 }),
        message('m1', recent.toISOString(), { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 }),
        message('m2', recent.toISOString(), { input_tokens: 10, output_tokens: 5 }),
        message('m0', old, { input_tokens: 999999, output_tokens: 1 }),
        JSON.stringify({ type: 'user', timestamp: recent.toISOString(), message: { content: 'secret question' } }),
        '{not json',
      ].join('\n'),
    );
    const count = (total) => JSON.stringify({ timestamp: recent.toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total } } } });
    writeFileSync(join(codex, 'rollout-1.jsonl'), [count(500), count(2000), count(1500)].join('\n'));
    const stale = join(claude, 'stale.jsonl');
    writeFileSync(stale, message('m9', old, { input_tokens: 5, output_tokens: 5 }));
    utimesSync(stale, new Date(old), new Date(old));

    const output = execFileSync(process.execPath, [SCRIPT, '--days', '30', '--claude-dir', join(dir, 'claude'), '--codex-dir', join(dir, 'codex')], { encoding: 'utf8' });
    const stats = JSON.parse(output);
    assert.equal(stats.claude_code_tokens, 1150 + 15);
    assert.equal(stats.codex_tokens, 2000);
    assert.equal(stats.tokens, 3165);
    assert.equal(stats.sessions, 2);
    assert.equal(stats.active_days, 1);
    assert.equal(stats.night_share, 1);
    assert.equal(stats.busiest_hour, 2);
    assert.equal(stats.main_tool, 'codex');
    assert.ok(!/private|secret/.test(output), 'no log content is printed');
    assert.ok(Object.values(stats).every((value) => typeof value === 'number' || typeof value === 'string'), 'flat values only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
