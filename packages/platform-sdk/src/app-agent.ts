/** Application orchestration receives only this task's conversation, plus the host's Shanghai date. */
export interface AppAgentInput {
  message: string;
  history: {role:'user'|'assistant';content:string}[];
  today: string;
}
export interface AppAgentReply { kind:'reply'|'clarify'|'draft'; text:string }

/** Application API boundary: share this check between independently authored agent handlers. */
export function readAppAgentInput(value: unknown): AppAgentInput {
  const input=value as AppAgentInput;
  if (!input || typeof input!=='object' || Object.keys(input).sort().join(',')!=='history,message,today'
    || typeof input.message!=='string' || !input.message.trim() || input.message.length>1500
    || typeof input.today!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.today)
    || !Array.isArray(input.history) || input.history.length>12
    || input.history.some(item=>!item||Object.keys(item).sort().join(',')!=='content,role'||!['user','assistant'].includes(item.role)||typeof item.content!=='string'||item.content.length>6000))
    throw Error('INVALID_INPUT');
  return input;
}
