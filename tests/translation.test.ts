import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../src/core/adapters/codex.js';
import { defaultParseCtx } from '../src/core/adapter.js';
import { buildTranslation } from '../web/src/translation.js';
import type { TraceEvent } from '../src/core/schema.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/codex-basic.jsonl');

describe('natural language translation', () => {
  it('groups model requests and paired tools under the user turn while retaining source ids', () => {
    const adapter = new CodexAdapter();
    const state = adapter.createState();
    const events: TraceEvent[] = [];
    for (const line of readFileSync(fixture, 'utf8').trim().split('\n')) {
      events.push(...adapter.parseLine(JSON.parse(line), { offset: 0, length: line.length }, state, defaultParseCtx(0)));
    }
    const turns = buildTranslation(events);
    expect(turns.find((t) => t.prompt?.startsWith('Add a dark mode'))?.steps.filter((s) => s.kind === 'request')).toHaveLength(2);
    const first = turns.find((t) => t.prompt?.startsWith('Add a dark mode'))!;
    const tool = first.steps.find((s) => s.title === '执行终端命令')!;
    expect(tool.eventIds).toHaveLength(2);
    expect(tool.status).toBe('已完成');
    expect(tool.detail).toBe('npm test --grep settings');
    expect(tool.resultPreview).toContain('3 tests passed');
    expect(first.steps.some((s) => s.title === '助手说')).toBe(true);
    expect(first.steps.some((s) => s.kind === 'error')).toBe(false);
  });

  it('explains new Codex token usage records with numbers when available', () => {
    const adapter = new CodexAdapter();
    const state = adapter.createState();
    const line = { type: 'token_usage_record', payload: { turn_token_usage: {
      input_tokens: 100, output_tokens: 25, total_tokens: 125,
    } } };
    const events = adapter.parseLine(line, { offset: 0, length: 100 }, state, defaultParseCtx(0));
    expect(events[0]).toMatchObject({ kind: 'system', subtype: 'token_usage_record',
      text: 'Token 用量：输入 100，输出 25，合计 125' });
    expect(buildTranslation(events)[0].steps[0]).toMatchObject({ kind: 'usage',
      title: '记录了一次 Token 用量快照' });
    const second = adapter.parseLine(line, { offset: 100, length: 100 }, state, defaultParseCtx(0));
    const grouped = buildTranslation([...events, ...second])[0].steps;
    expect(grouped).toHaveLength(1);
    expect(grouped[0].title).toBe('本轮记录了 2 次 Token 用量快照');
    expect(grouped[0].eventIds).toEqual([second[0].id, events[0].id]);
  });
});
