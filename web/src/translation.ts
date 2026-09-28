import type { ToolCallEvent, ToolResultEvent, TraceEvent } from './types.js';

export interface TranslationStep {
  id: string;
  eventIds: string[];
  kind: 'message' | 'tool' | 'request' | 'context' | 'error' | 'usage';
  title: string;
  detail?: string;
  status?: string;
  resultPreview?: string;
}

export interface TranslationTurn {
  id: string;
  number: number;
  prompt?: string;
  promptEventId?: string;
  steps: TranslationStep[];
  eventIds: string[];
}

const preview = (value: string, limit = 240): string => {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
};

function argument(input: unknown, keys: string[]): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of keys) {
    if (typeof obj[key] === 'string' && obj[key]) return preview(obj[key] as string, 180);
  }
  return undefined;
}

function embeddedArgument(source: string, key: string): string | undefined {
  const match = new RegExp(`(?:["']?${key}["']?)\\s*:\\s*(["'])(.*?)\\1`, 's').exec(source);
  return match?.[2] ? preview(match[2].replace(/\\n/g, ' '), 180) : undefined;
}

function toolAction(call: ToolCallEvent): { title: string; detail?: string } {
  const input = call.input;
  if (call.toolName === 'exec' && typeof input === 'string') {
    const names = [...new Set([...input.matchAll(/tools\.([a-zA-Z][\w]*)\s*\(/g)].map((m) => m[1]))];
    if (names.length) {
      const labels: Record<string, string> = {
        exec_command: '执行终端命令', create_goal: '创建工作目标', update_goal: '更新目标状态',
        web__run: '查询网页', apply_patch: '修改代码',
      };
      const singleDetail = names.length === 1
        ? names[0] === 'exec_command' ? embeddedArgument(input, 'cmd')
          : names[0] === 'create_goal' ? embeddedArgument(input, 'objective')
            : names[0] === 'web__run' ? embeddedArgument(input, 'q') : undefined
        : undefined;
      return { title: names.length === 1 ? (labels[names[0]] ?? `调用 ${names[0]}`) : '连续调用多个工具',
        detail: names.length === 1 ? singleDetail ?? '点开可查看调用参数。' : names.map((name) => labels[name] ?? name).join('、') };
    }
  }
  const path = argument(input, ['file_path', 'filePath', 'path', 'filename']);
  const command = argument(input, ['cmd', 'command', 'script']) ?? preview(call.summary, 180);
  switch (call.toolCategory) {
    case 'bash': return { title: '运行命令', detail: command };
    case 'read': return { title: '读取文件', detail: path ?? preview(call.summary) };
    case 'write': return { title: '创建或写入文件', detail: path ?? preview(call.summary) };
    case 'edit': return { title: '修改文件', detail: path ?? preview(call.summary) };
    case 'grep': case 'glob': return { title: '查找内容或文件', detail: argument(input, ['pattern', 'query']) ?? preview(call.summary) };
    case 'web': return { title: '查询网页', detail: argument(input, ['url', 'query']) ?? preview(call.summary) };
    case 'task': return { title: '交给子任务处理', detail: argument(input, ['description', 'prompt']) ?? preview(call.summary) };
    case 'mcp': return { title: `调用外部工具：${call.toolName}`, detail: preview(call.summary) };
    default: return { title: `调用工具：${call.toolName}`, detail: preview(call.summary) };
  }
}

function toolStep(call: ToolCallEvent, result?: ToolResultEvent): TranslationStep {
  const action = toolAction(call);
  let status = '等待结果';
  if (result) {
    if (result.isError || (result.exitCode !== undefined && result.exitCode !== 0)) status = '失败';
    else status = '已完成';
    if (result.exitCode !== undefined) status += ` · 退出码 ${result.exitCode}`;
    if (result.additions !== undefined || result.deletions !== undefined) {
      status += ` · 增加 ${result.additions ?? 0} 行，删除 ${result.deletions ?? 0} 行`;
    }
  }
  const output = result?.stderr || result?.stdout || result?.output;
  return { id: call.id, eventIds: result ? [call.id, result.id] : [call.id], kind: 'tool', ...action, status,
    resultPreview: output ? preview(output, 320) : undefined };
}

/** Translate normalized events locally; source events remain the authority and are never discarded. */
export function buildTranslation(events: TraceEvent[]): TranslationTurn[] {
  const results = new Map<string, ToolResultEvent>();
  const calls = new Set<string>();
  for (const event of events) {
    if (event.kind === 'tool_call') calls.add(event.callId);
    if (event.kind === 'tool_result') results.set(event.callId, event);
  }

  const turns: TranslationTurn[] = [];
  let turn: TranslationTurn | undefined;
  let userTurnNumber = 0;
  let pendingBoundary: Extract<TraceEvent, { kind: 'turn_boundary' }> | undefined;
  const ensureTurn = () => {
    if (!turn) {
      turn = { id: 'opening', number: 0, steps: [], eventIds: [] };
      turns.push(turn);
    }
    return turn;
  };
  const add = (step: TranslationStep) => {
    const current = ensureTurn();
    current.steps.push(step);
    current.eventIds.push(...step.eventIds);
  };

  for (const event of events) {
    if (pendingBoundary && event.kind !== 'user_message') {
      add({ id: pendingBoundary.id, eventIds: [pendingBoundary.id], kind: 'request',
        title: `开始第 ${pendingBoundary.requestIndex + 1} 次模型请求`,
        detail: pendingBoundary.model ? `模型：${pendingBoundary.model}` : undefined });
      pendingBoundary = undefined;
    }
    if (event.kind === 'turn_boundary') {
      pendingBoundary = event;
      continue;
    }
    if (event.kind === 'user_message') {
      turn = { id: event.id, number: ++userTurnNumber,
        prompt: event.text, promptEventId: event.id, steps: [], eventIds: [event.id] };
      turns.push(turn);
      if (pendingBoundary) {
        add({ id: pendingBoundary.id, eventIds: [pendingBoundary.id], kind: 'request',
          title: `开始第 ${pendingBoundary.requestIndex + 1} 次模型请求`,
          detail: pendingBoundary.model ? `模型：${pendingBoundary.model}` : undefined });
        pendingBoundary = undefined;
      }
      continue;
    }
    if (event.kind === 'tool_result' && calls.has(event.callId)) continue;
    switch (event.kind) {
      case 'assistant_message':
        add({ id: event.id, eventIds: [event.id], kind: 'message', title: '助手说', detail: event.text });
        break;
      case 'reasoning':
        add({ id: event.id, eventIds: [event.id], kind: 'context', title: '模型的思考摘要', detail: preview(event.text) });
        break;
      case 'tool_call':
        add(toolStep(event, results.get(event.callId)));
        break;
      case 'tool_result':
        add({ id: event.id, eventIds: [event.id], kind: 'tool', title: '收到工具返回',
          detail: event.toolName ? `工具：${event.toolName}` : undefined,
          status: event.isError ? '失败' : '已完成' });
        break;
      case 'synthetic_message':
        add({ id: event.id, eventIds: [event.id], kind: 'context', title: '系统补充了上下文',
          detail: preview(event.text) });
        break;
      case 'compaction':
        add({ id: event.id, eventIds: [event.id], kind: 'context', title: '压缩了较早的对话上下文', detail: event.text });
        break;
      case 'file_change':
        add({ id: event.id, eventIds: [event.id], kind: 'tool', title: '文件发生变更', detail: event.path,
          status: `增加 ${event.additions ?? 0} 行，删除 ${event.deletions ?? 0} 行` });
        break;
      case 'error':
        add({ id: event.id, eventIds: [event.id], kind: 'error', title: '运行出现错误', detail: preview(event.message) });
        break;
      case 'system':
        if (event.subtype === 'token_usage_record') {
          add({ id: event.id, eventIds: [event.id], kind: 'usage', title: '记录了一次 Token 用量快照',
            detail: event.text && event.text.startsWith('Token 用量：') ? event.text : '这是统计记录，不是助手的新回复。点开可查看原始用量数据。' });
        } else {
          const systemTitles: Record<string, string> = {
            task_started: '任务开始', task_complete: '任务完成', turn_aborted: '本轮执行被中断',
            thread_settings_applied: '会话设置已更新', world_state: '记录了环境状态',
          };
          add({ id: event.id, eventIds: [event.id], kind: 'context',
            title: systemTitles[event.subtype ?? ''] ?? '系统状态更新',
            detail: event.text ? preview(event.text) : event.subtype });
        }
        break;
      case 'unknown':
        if (event.rawType === 'token_usage_record') {
          add({ id: event.id, eventIds: [event.id], kind: 'usage', title: '记录了一次 Token 用量快照',
            detail: '这是统计记录，不是助手的新回复。点开可查看原始用量数据。' });
        } else {
          add({ id: event.id, eventIds: [event.id], kind: 'context', title: '尚未识别的记录',
            detail: `${event.rawType ?? event.source.rawType ?? '未知类型'}：点开查看原始数据。` });
        }
        break;
    }
  }
  if (pendingBoundary) add({ id: pendingBoundary.id, eventIds: [pendingBoundary.id], kind: 'request',
    title: `开始第 ${pendingBoundary.requestIndex + 1} 次模型请求`,
    detail: pendingBoundary.model ? `模型：${pendingBoundary.model}` : undefined });
  for (const item of turns) {
    const usage = item.steps.filter((step) => step.kind === 'usage');
    if (usage.length <= 1) continue;
    const last = usage[usage.length - 1];
    item.steps = item.steps.filter((step) => step.kind !== 'usage');
    item.steps.push({ id: `usage-${item.id}`, kind: 'usage',
      title: `本轮记录了 ${usage.length} 次 Token 用量快照`,
      detail: last.detail ? `最近一次：${last.detail}` : undefined,
      eventIds: usage.flatMap((step) => step.eventIds).reverse() });
  }
  return turns;
}
