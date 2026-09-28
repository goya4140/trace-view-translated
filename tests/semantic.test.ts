import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../src/core/schema.js';
import { decompileTrace } from '../web/src/semantic.js';

const base = { agentId: 'main', source: { provider: 'codex' as const } };
const event = (seq: number, data: Record<string, unknown>): TraceEvent =>
  ({ ...base, id: `e${seq}`, seq, ...data } as TraceEvent);

describe('model-free semantic decompiler', () => {
  it('links discovery, inspection, file production and verification across events', () => {
    const events = [
      event(0, { kind: 'user_message', text: 'Generate Markdown notes from the course files.' }),
      event(1, { kind: 'tool_call', callId: 'scan', toolName: 'exec', toolCategory: 'bash',
        input: 'await tools.exec_command({cmd:"rg --files /course"})', summary: 'rg --files /course' }),
      event(2, { kind: 'tool_result', callId: 'scan', resultKind: 'bash', output: '/course/lecture.md', exitCode: 0 }),
      event(3, { kind: 'tool_call', callId: 'read', toolName: 'Read', toolCategory: 'read',
        input: { file_path: '/course/lecture.md' }, summary: '/course/lecture.md' }),
      event(4, { kind: 'tool_result', callId: 'read', resultKind: 'file-read', output: 'Lecture text' }),
      event(5, { kind: 'tool_call', callId: 'write', toolName: 'exec', toolCategory: 'bash',
        input: 'const patch = "long generated text"; text(await tools.apply_patch(patch));', summary: 'patch' }),
      event(6, { kind: 'file_change', path: '/course/notes/lecture.md', changeType: 'add' }),
      event(7, { kind: 'tool_result', callId: 'write', resultKind: 'text', output: 'Done' }),
      event(8, { kind: 'tool_call', callId: 'check', toolName: 'exec', toolCategory: 'bash',
        input: 'await tools.exec_command({cmd:"ls /course/notes && wc -l /course/notes/lecture.md"})', summary: 'ls notes' }),
      event(9, { kind: 'tool_result', callId: 'check', resultKind: 'bash', output: 'lecture.md 42', exitCode: 0 }),
      event(10, { kind: 'assistant_message', text: 'The lecture and slides match.' }),
      event(11, { kind: 'user_message', text: 'Can you also fetch the next lecture online?' }),
    ];
    const turns = decompileTrace(events);
    expect(turns).toHaveLength(2);
    expect(turns[0].phases.map((phase) => phase.kind)).toEqual(['discover', 'inspect', 'produce', 'verify', 'interpret']);
    expect(turns[0].artifacts).toEqual([{ path: '/course/notes/lecture.md', changeType: 'add', eventId: 'e6' }]);
    expect(turns[0].phases.find((phase) => phase.kind === 'produce')?.eventIds).toContain('e6');
    expect(turns[0].claims).toEqual([{ text: 'The lecture and slides match.', eventId: 'e10' }]);
    expect(turns[1].previousArtifactCount).toBe(1);
  });

  it('keeps failures and unknown calls visible without treating them as completed work', () => {
    const turns = decompileTrace([
      event(0, { kind: 'user_message', text: 'Try the task.' }),
      event(1, { kind: 'tool_call', callId: 'x', toolName: 'mystery_tool', toolCategory: 'other', summary: 'opaque' }),
      event(2, { kind: 'tool_result', callId: 'x', resultKind: 'error', output: 'Script failed', isError: true }),
    ]);
    expect(turns[0].phases[0].kind).toBe('other');
    expect(turns[0].failedEventIds).toEqual(['e1', 'e2']);
    expect(turns[0].artifacts).toHaveLength(0);
    expect(turns[0].coveredCalls).toBe(0);
  });
});
