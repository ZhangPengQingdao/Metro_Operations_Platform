import React, {useEffect, useRef, useState} from 'react';
import type {CallToolResult} from '@modelcontextprotocol/client';
import {mountMcpView} from './frame';

export interface McpViewProps {
  /** Change identity on installation revision, connection or tool invocation change. */
  instanceKey: string;
  result: CallToolResult;
  resource?: Omit<Parameters<typeof mountMcpView>[1], 'result'>;
}
/** Completed text remains visible even when Apps are unsupported or revoked. */
export function McpView({instanceKey, result, resource}: McpViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'text'>('text');
  useEffect(() => {
    let live = true;
    if (!resource || !container.current) {setState('text'); return;}
    setState('loading');
    let view: ReturnType<typeof mountMcpView> | undefined;
    try {
      view = mountMcpView(container.current, {...resource, result});
      void view.ready.then(status => {if (live) setState(status === 'delivered' ? 'ready' : 'text');});
      void view.whenClosed.then(() => {if (live) setState('text');});
    } catch {setState('text');}
    return () => {live = false; void view?.close();};
  }, [instanceKey, result, resource]);
  return <section aria-label="工具结果">
    {result.content.filter(item => item.type === 'text').map((item, index) => <p key={index} style={{whiteSpace: 'pre-wrap'}}>{item.text}</p>)}
    {result.structuredContent !== undefined && <details><summary>结构化结果</summary><pre>{JSON.stringify(result.structuredContent, null, 2)}</pre></details>}
    {resource && <p role="status">{state === 'loading' ? '正在加载卡片…' : state === 'ready' ? '卡片已连接' : '卡片不可用，工具结果已保留'}</p>}
    <div ref={container} style={{height: state === 'text' ? 0 : 360, overflow: 'hidden'}} />
  </section>;
}
