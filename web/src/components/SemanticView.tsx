import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { TraceEvent } from '../types.js';
import { decompileTrace, type SemanticPhase, type SemanticTurn } from '../semantic.js';

export function SemanticView({ events, selectedEventId, onSelect, autoScrollSeq }: {
  events: TraceEvent[];
  selectedEventId: string | null;
  onSelect: (id: string) => void;
  autoScrollSeq: number;
}): JSX.Element {
  const turns = useMemo(() => decompileTrace(events), [events]);
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => 180 + turns[index].phases.length * 115 + turns[index].artifacts.length * 26,
    getItemKey: (index) => turns[index].id,
    overscan: 2,
    initialRect: { width: 1000, height: 600 },
  });
  const turnByEvent = useMemo(() => {
    const map = new Map<string, number>();
    turns.forEach((turn, index) => {
      map.set(turn.promptEventId, index);
      for (const phase of turn.phases) phase.eventIds.forEach((id) => map.set(id, index));
      turn.artifacts.forEach((artifact) => map.set(artifact.eventId, index));
      turn.claims.forEach((claim) => map.set(claim.eventId, index));
    });
    return map;
  }, [turns]);

  useEffect(() => {
    if (!selectedEventId) return;
    const index = turnByEvent.get(selectedEventId);
    if (index === undefined) return;
    virtualizer.scrollToIndex(index, { align: 'center' });
    const frame = requestAnimationFrame(() => {
      const target = [...(parentRef.current?.querySelectorAll<HTMLElement>('[data-evidence]') ?? [])]
        .find((node) => node.dataset.evidence?.split(' ').includes(selectedEventId));
      target?.scrollIntoView?.({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedEventId, autoScrollSeq, turnByEvent, virtualizer]);

  return (
    <div className="semantic-view" ref={parentRef}>
      <div className="semantic-intro">
        <strong>语义反编译 · 实验版</strong>
        <span>本地规则合并同类调用。工具记录、Agent 的说法和未识别操作分别标注；精确顺序与原始内容可点击证据核对。</span>
      </div>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div key={item.key} data-index={item.index} ref={virtualizer.measureElement}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}>
            <SemanticTurnCard turn={turns[item.index]} selectedEventId={selectedEventId} onSelect={onSelect} />
          </div>
        ))}
      </div>
      {turns.length === 0 && <div className="trajectory-empty">当前会话没有可识别的用户轮次；请切换到原始轨迹查看。</div>}
    </div>
  );
}

function SemanticTurnCard({ turn, selectedEventId, onSelect }: {
  turn: SemanticTurn;
  selectedEventId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="semantic-turn">
      <div className="semantic-turn-head">
        <span className="semantic-round">第 {turn.number} 轮</span>
        <span className="semantic-coverage">已识别 {turn.coveredCalls}/{turn.totalCalls} 次工具调用</span>
      </div>
      <div className="semantic-prompt">
        <div className="semantic-eyebrow">用户目标 · 从提问中提取</div>
        <p>{turn.goal}</p>
        {expanded && <div className="semantic-full-prompt">{turn.prompt}</div>}
        {turn.goal !== turn.prompt && <button onClick={() => setExpanded((value) => !value)}>{expanded ? '收起完整提问' : '查看完整提问'}</button>}
        <Evidence ids={[turn.promptEventId]} selectedEventId={selectedEventId} onSelect={onSelect} label="提问来源" />
      </div>
      {turn.previousArtifactCount > 0 && <div className="semantic-context">此前轮次已记录 {turn.previousArtifactCount} 个文件变更；本轮在同一会话中继续。</div>}
      <div className="semantic-flow">
        {turn.phases.map((phase, index) => <PhaseCard key={phase.kind} phase={phase} index={index}
          selectedEventId={selectedEventId} onSelect={onSelect} />)}
        {turn.phases.length === 0 && <div className="semantic-muted">本轮没有工具操作；可在自然语言翻译中阅读对话。</div>}
      </div>
      {turn.artifacts.length > 0 && <div className="semantic-section">
        <div className="semantic-section-title">trace 记录的文件产物</div>
        {turn.artifacts.map((artifact) => <div className="semantic-artifact" key={artifact.eventId}>
          <span>{artifact.changeType === 'add' ? '新建' : artifact.changeType === 'delete' ? '删除' : '修改'}</span>
          <span className="semantic-file" title={artifact.path}>{artifact.path.split('/').pop()}</span>
          <Evidence ids={[artifact.eventId]} selectedEventId={selectedEventId} onSelect={onSelect} label="文件事件" />
        </div>)}
      </div>}
      {turn.failedEventIds.length > 0 && <div className="semantic-section semantic-warning">
        <div className="semantic-section-title">执行中的失败尝试</div>
        <p>{turn.failedAttempts.join('、')}曾报告失败；后续步骤仍需分别判断结果。</p>
        <Evidence ids={turn.failedEventIds} selectedEventId={selectedEventId} onSelect={onSelect} label="失败证据" />
      </div>}
    </section>
  );
}

function PhaseCard({ phase, index, selectedEventId, onSelect }: {
  phase: SemanticPhase;
  index: number;
  selectedEventId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  return <div className={`semantic-phase semantic-${phase.kind}`} data-evidence={phase.eventIds.join(' ')}>
    <span className="semantic-phase-index">{index + 1}</span>
    <div className="semantic-phase-body">
      <div className="semantic-phase-title">{phase.title}<span className={`semantic-tag ${phase.kind === 'interpret' ? 'semantic-tag-claim' : ''}`}>{phase.kind === 'interpret' ? 'Agent 的说法' : '工具记录'}</span></div>
      <p>{phase.summary}</p>
      <div className="semantic-actions">{phase.actions.join(' · ')}</div>
      <Evidence ids={phase.eventIds} selectedEventId={selectedEventId} onSelect={onSelect} label="查看证据" />
    </div>
  </div>;
}

function Evidence({ ids, selectedEventId, onSelect, label }: {
  ids: string[];
  selectedEventId: string | null;
  onSelect: (id: string) => void;
  label: string;
}): JSX.Element {
  return <details className="semantic-evidence" data-evidence={ids.join(' ')}>
    <summary>{label} · {ids.length} 条</summary>
    <div className="semantic-evidence-list">
      {ids.map((id) => <button key={id} className={id === selectedEventId ? 'selected' : ''} onClick={() => onSelect(id)}>{id}</button>)}
    </div>
  </details>;
}
