import {useEffect,useRef,useState} from 'react';
import {Link,useLocation,useNavigate} from 'react-router-dom';
import {ArrowUp,ArrowUpRight,ChatsCircle,Sparkle,Stop} from '@phosphor-icons/react';
import {Button,Dialog,PlatformIcon,Textarea} from '../../components/ui';
import {employeeRequest,EmployeeRequestError} from './client';
import './chat.css';

type Capability={key:string;name:string;appId:string;appName:string;examples:string[]};
type Session={id:string;title:string;updatedAt:string};
type Turn={id:string;message:string;status:string;stage:string;reply:{kind:string;text:string;href?:string;appName?:string}|null;error:string|null};
type Conversation={id:string;title:string;turns:Turn[]};
const failures:Record<string,string>={CHAT_ACCESS_CHANGED:'应用权限已变化，本次处理已停止，请重新发起。',CHAT_TIMEOUT:'处理超时，请稍后重新发起。',CHAT_INTERRUPTED:'服务重启，本次处理已中断。',CHAT_INVALID_ROUTE:'暂时无法确定合适的应用，请换一种说法。',CHAT_EXECUTION_FAILED:'处理失败，请稍后重试；如持续失败，请联系管理员检查模型配置或应用状态。'};

export function ChatPage({name}:{name:string}){
 const {pathname}=useLocation(),navigate=useNavigate(),sessionId=pathname.slice('/employee/chat/'.length);
 const [capabilities,setCapabilities]=useState<Capability[]>([]),[sessions,setSessions]=useState<Session[]>([]),[conversation,setConversation]=useState<Conversation|null>(null);
 const [draft,setDraft]=useState(''),[category,setCategory]=useState('all'),[historyOpen,setHistoryOpen]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[sending,setSending]=useState(false),[stopping,setStopping]=useState(false),[refresh,setRefresh]=useState(0);
 const [unconfirmed,setUnconfirmed]=useState<{sessionId:string;requestId:string;message:string}|null>(null);
 const textarea=useRef<HTMLTextAreaElement>(null),bottom=useRef<HTMLDivElement>(null),lifetime=useRef<AbortController|null>(null);
 const active=conversation?.turns.find(turn=>turn.status==='running'),welcome=!sessionId;
 useEffect(()=>{const c=new AbortController();lifetime.current=c;return()=>c.abort();},[]);
 useEffect(()=>{
  const c=new AbortController();let timer:ReturnType<typeof setTimeout>;setLoading(true);setError('');
  async function read(){
   try{const value=await employeeRequest<Conversation>(`/chats/${sessionId}`,{signal:c.signal});setConversation(value);setLoading(false);if(value.turns.some(turn=>turn.status==='running'))timer=setTimeout(()=>void read(),1000);}
   catch(e){if(!c.signal.aborted){setError(e instanceof Error?e.message:'读取对话失败');setLoading(false);}}
  }
  Promise.all([employeeRequest<{capabilities:Capability[]}>('/chat/capabilities',{signal:c.signal}),employeeRequest<{sessions:Session[]}>('/chats',{signal:c.signal})]).then(([catalog,history])=>{setCapabilities(catalog.capabilities);setSessions(history.sessions);if(welcome)setLoading(false);}).catch(e=>{if(!c.signal.aborted){setError(e.message);setLoading(false);}});
  if(!welcome)void read();
  return()=>{c.abort();clearTimeout(timer);};
 },[sessionId,refresh,welcome]);
 useEffect(()=>{if(conversation)bottom.current?.scrollIntoView({block:'end'});},[conversation?.turns.length,active?.status]);
 async function send(){
  if(sending||active||!draft.trim())return;
  const input=unconfirmed??{sessionId:sessionId||crypto.randomUUID(),requestId:crypto.randomUUID(),message:draft.trim()};
  setSending(true);setError('');
  try{await employeeRequest('/chats/messages',{method:'POST',body:input,signal:lifetime.current!.signal});if(lifetime.current!.signal.aborted)return;setDraft('');setUnconfirmed(null);if(welcome)navigate(`/employee/chat/${input.sessionId}`,{replace:true});else setRefresh(value=>value+1);}
  catch(e){if(!lifetime.current!.signal.aborted){if(!(e instanceof EmployeeRequestError)||e.status>=500)setUnconfirmed(input);setError(e instanceof EmployeeRequestError&&e.status<500?e.message:'发送结果未确认。点击“重试发送”会核对同一次请求，也可从历史对话查看结果。');}}
  finally{if(!lifetime.current!.signal.aborted)setSending(false);}
 }
 async function cancel(){
  setStopping(true);setError('');
  try{await employeeRequest(`/chats/${sessionId}/runs/${active!.id}/cancel`,{method:'POST',signal:lifetime.current!.signal});setRefresh(value=>value+1);}
  catch(e){if(!lifetime.current!.signal.aborted)setError(e instanceof Error?e.message:'停止结果未确认');}
  finally{if(!lifetime.current!.signal.aborted)setStopping(false);}
 }
 return <section className={`platform-chat${welcome?' platform-chat--welcome':''}`} aria-label="平台对话">
  <div className="chat-toolbar"><span>{welcome?'平台助手':conversation?.title??'对话'}</span><Button variant="ghost" size="sm" leadingIcon={<PlatformIcon name="clock" size={17}/>} onClick={()=>setHistoryOpen(true)}>历史对话</Button></div>
  {welcome?<div className="chat-welcome"><div className="chat-mark"><Sparkle size={30} weight="duotone"/></div><div><p className="chat-eyebrow">运管开放平台</p><h1>{name}，今天有什么需要帮忙？</h1><p>说出你的需求，让应用能力在这里为你服务。</p></div></div>:<div className="chat-messages" role="log" aria-label="对话消息">
   {conversation?.turns.map(turn=><div className="chat-turn" key={turn.id}><div className="chat-user"><span className="chat-speaker">你</span><p>{turn.message}</p></div><div className="chat-assistant"><span className="chat-speaker"><Sparkle size={17}/>{turn.reply?.appName??'平台助手'}</span>{turn.status==='running'?<p className="chat-processing" role="status">{turn.stage}…</p>:turn.reply?<><p>{turn.reply.text}</p>{turn.reply.href&&<Link className="chat-app-link" to={turn.reply.href}>打开{turn.reply.appName}<ArrowUpRight size={15}/></Link>}</>:<p className="afc-muted">{turn.status==='cancelled'?'已停止本次处理。':failures[turn.error??'']??'本次处理未完成，请重新发起。'}</p>}</div></div>)}
   <div ref={bottom}/>
  </div>}
  {error&&<div className="chat-error" role="alert"><p>{error}</p>{!unconfirmed&&<Button size="sm" variant="ghost" onClick={()=>setRefresh(value=>value+1)}>重新读取</Button>}</div>}
  {loading&&<p className="afc-muted" role="status">正在读取…</p>}
  <form className="chat-composer" onSubmit={event=>{event.preventDefault();void send();}}>
   <Textarea ref={textarea} aria-label="聊天内容" placeholder={welcome?'输入你的需求，例如：帮我整理一条下月计划…':'继续补充信息，或发起新的需求…'} value={draft} maxLength={1500} disabled={sending||!!unconfirmed} rows={welcome?4:2} onChange={event=>setDraft(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();if(!loading)void send();}}}/>
   <div className="chat-composer-footer"><span><Sparkle size={15}/>自动匹配应用<span className="chat-key-hint"> · Shift + Enter 换行</span></span>{active?<Button type="button" variant="secondary" size="sm" disabled={stopping} leadingIcon={<Stop size={15} weight="fill"/>} onClick={()=>void cancel()}>停止</Button>:<Button className="chat-send" type="submit" disabled={loading||sending||!draft.trim()} aria-label={unconfirmed?'重试发送':'发送消息'} title={unconfirmed?'重试发送':'发送消息'}>{unconfirmed?'重试发送':<ArrowUp size={22} weight="bold"/>}</Button>}</div>
  </form>
  {welcome&&!loading&&<div className="chat-suggestions"><div className="chat-categories" aria-label="提示分类">{[{key:'all',name:'推荐'},...Array.from(new Map(capabilities.map(item=>[item.appId,{key:item.appId,name:item.appName}])).values())].map(item=><button type="button" key={item.key} aria-pressed={category===item.key} onClick={()=>setCategory(item.key)}>{item.name}</button>)}</div>
   <div className="chat-card-grid">{capabilities.filter(item=>category==='all'||item.appId===category).flatMap(item=>item.examples.map((prompt,index)=><button className="chat-prompt-card" type="button" key={`${item.key}:${index}`} disabled={sending||!!unconfirmed} onClick={()=>{setDraft(prompt);textarea.current?.focus();}}><span className="chat-card-heading"><ChatsCircle size={21}/>{index===0?item.name:item.appName}</span><span className="chat-card-prompt">{prompt}</span><span className="chat-card-bottom">{item.appName}<ArrowUpRight size={17}/></span></button>))}</div>
   {!capabilities.length&&<p className="chat-empty">还没有可用的应用智能能力。接入应用并获得使用权限后，提示卡片会出现在这里。</p>}
  </div>}
  <p className="chat-footnote">回答与草稿供你核对，业务提交请在对应应用中完成。</p>
  <Dialog open={historyOpen} onClose={()=>setHistoryOpen(false)} title="历史对话"><div className="chat-history">{sessions.length?sessions.map(item=><Link key={item.id} to={`/employee/chat/${item.id}`} onClick={()=>setHistoryOpen(false)}><span>{item.title}</span><time>{new Date(item.updatedAt).toLocaleDateString('zh-CN')}</time></Link>):<p className="afc-muted">暂无历史对话。</p>}</div></Dialog>
 </section>;
}
