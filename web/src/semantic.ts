import type { ToolCallEvent, ToolResultEvent, TraceEvent } from './types.js';
import { buildTranslation } from './translation.js';

export type SemanticKind = 'discover' | 'inspect' | 'interpret' | 'produce' | 'verify' | 'web' | 'delegate' | 'other';

export interface SemanticPhase {
  kind: SemanticKind;
  title: string;
  summary: string;
  actions: string[];
  eventIds: string[];
  failures: number;
}

export interface SemanticArtifact {
  path: string;
  changeType: 'add' | 'modify' | 'delete';
  eventId: string;
}

export interface SemanticClaim {
  text: string;
  eventId: string;
}

export interface SemanticTurn {
  id: string;
  number: number;
  prompt: string;
  goal: string;
  promptEventId: string;
  phases: SemanticPhase[];
  artifacts: SemanticArtifact[];
  claims: SemanticClaim[];
  failedAttempts: string[];
  failedEventIds: string[];
  previousArtifactCount: number;
  coveredCalls: number;
  totalCalls: number;
}

interface Operation {
  kind: SemanticKind;
  action: string;
  eventIds: string[];
  failed: boolean;
  seq: number;
}

const short = (text: string, max = 190): string => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
};

function goalExcerpt(prompt: string): string {
  const paragraphs = prompt.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const action = [...paragraphs].reverse().find((part) => /(?:请|为我|查看|生成|获取|修改|修复|整理|创建|能不能|如何|试试)/.test(part));
  return short(action ?? paragraphs.at(-1) ?? prompt, 240);
}

function stringArg(input: unknown, keys: string[]): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of keys) {
    if (typeof obj[key] === 'string') return obj[key] as string;
    if (Array.isArray(obj[key]) && (obj[key] as unknown[]).every((v) => typeof v === 'string')) {
      return (obj[key] as string[]).join(' ');
    }
  }
  return undefined;
}

/** Read quoted command arguments from an exec wrapper without evaluating trace code. */
function embeddedCommands(source: string): string[] {
  const commands: string[] = [];
  const pattern = /\b(?:cmd|command)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
  for (const match of source.matchAll(pattern)) {
    const literal = match[1];
    if (literal[0] === '"') {
      try { commands.push(JSON.parse(literal)); } catch { /* malformed input stays opaque */ }
    } else {
      commands.push(literal.slice(1, -1).replace(/\\n/g, '\n').replace(/\\'/g, "'"));
    }
  }
  return commands;
}

function commandsFor(call: ToolCallEvent): string[] {
  if (call.toolName === 'exec' && typeof call.input === 'string') return embeddedCommands(call.input);
  const command = stringArg(call.input, ['cmd', 'command', 'script']);
  return command ? [command] : [];
}

function failedResult(result?: ToolResultEvent): boolean {
  if (!result) return false;
  if (result.isError || (result.exitCode !== undefined && result.exitCode !== 0)) return true;
  return /^(?:Script failed|Process exited with code [1-9]|error:)/i.test((result.output ?? result.stderr ?? '').trim());
}

function isArtifactCheck(command: string, paths: string[]): boolean {
  if (!/\b(?:ls|wc|stat|test|find|rg)\b/.test(command)) return false;
  return paths.some((path) => {
    const directory = path.slice(0, path.lastIndexOf('/'));
    return command.includes(path) || (directory.length > 3 && command.includes(directory));
  });
}

function classifyCommand(command: string, artifactPaths: string[]): Pick<Operation, 'kind' | 'action'> {
  if (isArtifactCheck(command, artifactPaths)) return { kind: 'verify', action: '核对生成的文件' };
  if (/\b(?:npm\s+(?:test|run\s+(?:test|typecheck|build))|pytest|vitest|tsc|cargo\s+test|go\s+test|hdiutil\s+verify|codesign\s+--verify)\b/.test(command)) {
    return { kind: 'verify', action: '运行构建或测试检查' };
  }
  if (/\b(?:soffice|libreoffice|pdftotext|pandoc)\b/.test(command) && /--convert-to|pdftotext|pandoc/.test(command)) {
    return { kind: 'inspect', action: '转换资料以提取内容' };
  }
  if (/\b(?:rg\s+--files|find\s+\S+|ls\s|ls$|glob\b)/.test(command)) {
    return { kind: 'discover', action: '查找或列出文件' };
  }
  if (/\b(?:cat|sed|head|tail|wc|file|stat)\b/.test(command)) {
    return { kind: 'inspect', action: '阅读或检查资料' };
  }
  if (/\bpython(?:3)?\b/.test(command)) {
    if (/\.write_text\(|open\([^\n]+,[^\n]*['"]w['"]|to_csv\(|save\(/.test(command)) {
      return { kind: 'produce', action: '运行脚本生成文件' };
    }
    return { kind: 'inspect', action: '运行脚本分析资料' };
  }
  if (/\b(?:mkdir|cp|mv|touch)\b|\bcat\s*>/.test(command)) return { kind: 'produce', action: '准备或写入文件' };
  return { kind: 'other', action: '执行尚未归类的命令' };
}

function classifyCall(call: ToolCallEvent, artifactPaths: string[]): Pick<Operation, 'kind' | 'action'> {
  if (call.toolName === 'exec' && typeof call.input === 'string') {
    if (/tools\.apply_patch\s*\(/.test(call.input)) return { kind: 'produce', action: '应用文件补丁' };
    const commands = commandsFor(call);
    if (commands.length) {
      const classified = commands.map((cmd) => classifyCommand(cmd, artifactPaths));
      const known = classified.filter((item) => item.kind !== 'other');
      if (known.length === 0) return { kind: 'other', action: '批量执行尚未归类的命令' };
      const kinds = [...new Set(known.map((item) => item.kind))];
      return kinds.length === 1
        ? { kind: kinds[0], action: commands.length === 1 ? known[0].action : `批量${known[0].action}` }
        : { kind: 'inspect', action: '批量查找并检查资料' };
    }
    if (/tools\.(?:web__run|web_search|WebFetch)\s*\(/.test(call.input)) return { kind: 'web', action: '查询网页资料' };
    if (/tools\.(?:create_goal|update_goal|get_goal)\s*\(/.test(call.input)) {
      return { kind: 'other', action: '维护任务目标记录' };
    }
  }
  if (call.toolName === 'js') {
    const code = stringArg(call.input, ['code']);
    if (code && /\b(?:cua\.(?:getBrowser|createBrowserTab|getTab)|(?:tab|chrome)\.(?:getAXState|getScreenshot|click|type|scroll|goto))\b/.test(code)) {
      return { kind: 'web', action: '在浏览器中查看或操作页面' };
    }
  }
  switch (call.toolCategory) {
    case 'bash': return classifyCommand(commandsFor(call)[0] ?? call.summary, artifactPaths);
    case 'read': return { kind: 'inspect', action: '读取文件' };
    case 'grep': case 'glob': return { kind: 'discover', action: '查找文件或内容' };
    case 'write': case 'edit': return { kind: 'produce', action: '写入或修改文件' };
    case 'web': return { kind: 'web', action: '查询网页资料' };
    case 'task': return { kind: 'delegate', action: '委派子任务' };
    default: return { kind: 'other', action: `调用 ${call.toolName}` };
  }
}

const titles: Record<SemanticKind, string> = {
  discover: '定位输入材料', inspect: '阅读与分析材料', interpret: 'Agent 的判断汇总', produce: '生成或修改产物',
  verify: '检查结果', web: '获取网页信息', delegate: '委派工作', other: '尚未解释的操作',
};

function phaseFor(kind: SemanticKind, operations: Operation[], artifacts: SemanticArtifact[]): SemanticPhase {
  const count = operations.length;
  const failures = operations.filter((op) => op.failed).length;
  const summaryByKind: Record<SemanticKind, string> = {
    discover: `通过 ${count} 次工具调用查找输入文件或内容。`,
    inspect: `通过 ${count} 次工具调用读取、转换或分析材料。`,
    interpret: '',
    produce: operations.some((op) => op.action === 'trace 记录文件变更')
      ? `trace 记录了 ${artifacts.length} 个文件变更；具体写入调用尚未识别。`
      : `发起 ${count} 次写入相关操作；trace 记录了 ${artifacts.length} 个文件变更。`,
    verify: `运行 ${count} 次检查。${failures ? `其中 ${failures} 次报告失败。` : '这些检查没有报告失败。'}`,
    web: `通过 ${count} 次工具调用获取网页信息。`,
    delegate: `发起 ${count} 次子任务委派。`,
    other: `有 ${count} 次工具调用尚未匹配到明确的过程规则。`,
  };
  return {
    kind, title: titles[kind], summary: summaryByKind[kind],
    actions: [...new Set(operations.map((op) => op.action))].slice(0, 4),
    eventIds: [...new Set(operations.flatMap((op) => op.eventIds))], failures,
  };
}

function claimText(text: string): string | undefined {
  const cleaned = text.trim();
  if (!cleaned || /^(?:我会|我将|接下来|现在我会)/.test(cleaned)) return undefined;
  const first = cleaned.replace(/\*\*/g, '').split(/\n\s*\n|[。！？]\s*/)
    .map((part) => part.trim()).find((part) => part.length >= 12);
  if (!first) return undefined;
  return short(first, 210);
}

/** Deterministic, local semantic projection. Every statement keeps source event ids. */
export function decompileTrace(events: TraceEvent[]): SemanticTurn[] {
  const byId = new Map(events.map((event) => [event.id, event]));
  const results = new Map<string, ToolResultEvent>();
  for (const event of events) if (event.kind === 'tool_result') results.set(event.callId, event);
  let previousArtifactCount = 0;
  return buildTranslation(events).filter((turn) => turn.promptEventId).map((turn) => {
    const source = turn.eventIds.map((id) => byId.get(id)).filter((event): event is TraceEvent => !!event)
      .sort((a, b) => a.seq - b.seq);
    const artifacts = source.filter((event): event is Extract<TraceEvent, { kind: 'file_change' }> => event.kind === 'file_change')
      .map((event) => ({ path: event.path, changeType: event.changeType, eventId: event.id }));
    const artifactPaths = artifacts.map((artifact) => artifact.path);
    const calls = source.filter((event): event is ToolCallEvent => event.kind === 'tool_call');
    const operations: Operation[] = calls.map((call) => {
      const result = results.get(call.callId);
      let action = classifyCall(call, artifactPaths);
      const changedDuringCall = artifacts.some((artifact) => {
        const change = byId.get(artifact.eventId);
        return change && change.seq > call.seq && (result ? change.seq < result.seq : false);
      });
      if (changedDuringCall && (call.toolName === 'exec' || call.toolCategory === 'edit' || call.toolCategory === 'write')) {
        action = { kind: 'produce', action: '生成或修改文件（由文件变更记录关联）' };
      }
      return { ...action, seq: call.seq, failed: failedResult(result),
        eventIds: result ? [call.id, result.id] : [call.id] };
    });
    const groups = new Map<SemanticKind, Operation[]>();
    for (const op of operations) groups.set(op.kind, [...(groups.get(op.kind) ?? []), op]);
    if (artifacts.length && !groups.has('produce')) {
      groups.set('produce', [{ kind: 'produce', action: 'trace 记录文件变更',
        eventIds: artifacts.map((artifact) => artifact.eventId), failed: false,
        seq: Math.min(...source.filter((event) => event.kind === 'file_change').map((event) => event.seq)) }]);
    }
    const phases = [...groups.entries()].sort((a, b) => {
      if (a[0] === 'other') return 1;
      if (b[0] === 'other') return -1;
      return a[1][0].seq - b[1][0].seq;
    })
      .map(([kind, ops]) => phaseFor(kind, ops, artifacts));
    const claims = source.filter((event): event is Extract<TraceEvent, { kind: 'assistant_message' }> => event.kind === 'assistant_message')
      .map((event) => ({ eventId: event.id, text: claimText(event.text) }))
      .filter((claim): claim is SemanticClaim => !!claim.text).slice(0, 3);
    if (claims.length) phases.push({ kind: 'interpret', title: titles.interpret,
      summary: `Agent 给出 ${claims.length} 条关于任务的判断；本程序没有独立验证其内容。`,
      actions: claims.map((claim) => claim.text), eventIds: claims.map((claim) => claim.eventId), failures: 0 });
    phases.sort((a, b) => {
      if (a.kind === 'other') return 1;
      if (b.kind === 'other') return -1;
      const aSeq = byId.get(a.eventIds[0])?.seq ?? Infinity;
      const bSeq = byId.get(b.eventIds[0])?.seq ?? Infinity;
      return aSeq - bSeq;
    });
    const outputPhase = phases.find((phase) => phase.kind === 'produce');
    if (outputPhase) outputPhase.eventIds = [...new Set([...outputPhase.eventIds, ...artifacts.map((artifact) => artifact.eventId)])];
    const failed = operations.filter((op) => op.failed);
    const semantic: SemanticTurn = {
      id: turn.id, number: turn.number, prompt: turn.prompt ?? '', goal: goalExcerpt(turn.prompt ?? ''),
      promptEventId: turn.promptEventId!,
      phases, artifacts, claims,
      failedAttempts: failed.map((op) => op.action), failedEventIds: failed.flatMap((op) => op.eventIds),
      previousArtifactCount, coveredCalls: operations.filter((op) => op.kind !== 'other').length,
      totalCalls: operations.length,
    };
    previousArtifactCount += artifacts.length;
    return semantic;
  });
}
