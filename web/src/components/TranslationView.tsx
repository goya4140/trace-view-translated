import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { TraceEvent } from '../types.js';
import { buildTranslation, type TranslationStep, type TranslationTurn } from '../translation.js';
import { SafeMarkdown } from './SafeMarkdown.js';

export function TranslationView({ events, selectedEventId, onSelect, autoScrollSeq }: {
  events: TraceEvent[];
  selectedEventId: string | null;
  onSelect: (eventId: string) => void;
  autoScrollSeq: number;
}): JSX.Element {
  const turns = useMemo(() => buildTranslation(events), [events]);
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => 100 + turns[index].steps.length * 65,
    getItemKey: (index) => turns[index].id,
    overscan: 3,
    initialRect: { width: 1000, height: 600 },
  });
  const turnByEvent = useMemo(() => {
    const map = new Map<string, number>();
    turns.forEach((turn, index) => turn.eventIds.forEach((id) => map.set(id, index)));
    return map;
  }, [turns]);

  useEffect(() => {
    if (!selectedEventId) return;
    const index = turnByEvent.get(selectedEventId);
    if (index === undefined) return;
    virtualizer.scrollToIndex(index, { align: 'center' });
    const frame = requestAnimationFrame(() => {
      const target = [...(parentRef.current?.querySelectorAll<HTMLElement>('[data-event-id]') ?? [])]
        .find((node) => node.dataset.eventId?.split(' ').includes(selectedEventId));
      target?.scrollIntoView?.({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedEventId, autoScrollSeq, turnByEvent, virtualizer]);

  return (
    <div className="translation-view" ref={parentRef}>
      <div className="translation-intro">
        <strong>自然语言阅读</strong>
        <span>“一轮”从你的提问开始；其间可能有多次模型请求和工具调用。下方文字由本地规则生成，点任一步可核对原始记录。</span>
      </div>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div key={item.key} data-index={item.index} ref={virtualizer.measureElement}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}>
            <TurnCard turn={turns[item.index]} selectedEventId={selectedEventId} onSelect={onSelect} />
          </div>
        ))}
      </div>
      {turns.length === 0 && <div className="trajectory-empty">当前筛选下没有可翻译的事件。</div>}
    </div>
  );
}

function TurnCard({ turn, selectedEventId, onSelect }: {
  turn: TranslationTurn;
  selectedEventId: string | null;
  onSelect: (eventId: string) => void;
}): JSX.Element {
  const [promptExpanded, setPromptExpanded] = useState(false);
  const longPrompt = (turn.prompt?.length ?? 0) > 360;
  const visiblePrompt = longPrompt && !promptExpanded ? `${turn.prompt!.slice(0, 360).trimEnd()}…` : turn.prompt;
  return (
    <section className="translation-turn">
      <div className="translation-turn-heading">{turn.number ? `第 ${turn.number} 轮 · 你的提问` : '会话开始前的记录'}</div>
      {turn.prompt && <div className={`translation-prompt ${selectedEventId === turn.promptEventId ? 'selected' : ''}`}
        role="button" tabIndex={0} data-event-id={turn.promptEventId}
        onClick={() => turn.promptEventId && onSelect(turn.promptEventId)}
        onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ') && turn.promptEventId) onSelect(turn.promptEventId); }}>
        <SafeMarkdown text={visiblePrompt ?? ''} />
        {longPrompt && <button className="translation-expand" onClick={(event) => {
          event.stopPropagation();
          setPromptExpanded((expanded) => !expanded);
        }}>{promptExpanded ? '收起提问' : '展开完整提问'}</button>}
      </div>}
      <div className="translation-steps">
        {turn.steps.map((step) => <Step key={step.id} step={step} selectedEventId={selectedEventId} onSelect={onSelect} />)}
        {turn.steps.length === 0 && <div className="translation-empty">这一轮尚无后续记录。</div>}
      </div>
    </section>
  );
}

function Step({ step, selectedEventId, onSelect }: {
  step: TranslationStep;
  selectedEventId: string | null;
  onSelect: (eventId: string) => void;
}): JSX.Element {
  const selected = selectedEventId !== null && step.eventIds.includes(selectedEventId);
  return (
    <div className={`translation-step translation-${step.kind} ${selected ? 'selected' : ''}`}
      role="button" tabIndex={0} data-event-id={step.eventIds.join(' ')}
      onClick={() => onSelect(step.eventIds[0])}
      onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) onSelect(step.eventIds[0]); }}>
      <span className="translation-marker" aria-hidden="true">{step.kind === 'tool' ? '↗' : step.kind === 'message' ? '◆' : step.kind === 'error' ? '!' : '·'}</span>
      <span className="translation-step-content">
        <span className="translation-step-title">{step.title}{step.status && <span className="translation-status">{step.status}</span>}</span>
        {step.detail && <span className="translation-detail">{step.kind === 'message' ? <SafeMarkdown text={step.detail} /> : step.detail}</span>}
        {step.resultPreview && <span className="translation-result">返回内容：{step.resultPreview}</span>}
        {step.kind === 'tool' && step.eventIds.length > 1 && <button className="translation-source-link"
          onClick={(event) => { event.stopPropagation(); onSelect(step.eventIds[1]); }}>查看工具返回的原始记录</button>}
      </span>
    </div>
  );
}
