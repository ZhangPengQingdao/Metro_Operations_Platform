import React, { useLayoutEffect, useRef, useState } from 'react';
import { SandboxBridgeBroker, createSandboxSession, type SandboxBridgeOperation } from './bridge.js';

export type SandboxFrameResource = { mode: 'isolated-origin'; url: string; platformOrigin: string }
  | { mode: 'local-demo'; html: string; platformOrigin: string };
export interface SandboxFrameProps {
  appId: string;
  /** Change on every account/installation/grant/policy revision, never app-supplied. */
  instanceKey: string;
  resource: SandboxFrameResource;
  operations: ReadonlyMap<string, SandboxBridgeOperation>;
  enabled: boolean;
  title: string;
}

export function validateSandboxResource(resource: SandboxFrameResource): boolean {
  try {
    const parent = new URL(resource.platformOrigin);
    if (parent.origin !== resource.platformOrigin || parent.username || parent.password) return false;
    if (resource.mode === 'local-demo') return parent.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(parent.hostname)
      && typeof resource.html === 'string' && resource.html.length <= 2*1024*1024;
    const target = new URL(resource.url);
    return parent.protocol === 'https:' && target.protocol === 'https:' && target.hostname !== parent.hostname
      && !target.username && !target.password && !target.hash && !target.search && resource.url === target.href;
  } catch { return false; }
}

/** Render only AFTER platform installation/session admission. Resource server must enforce response CSP. */
export function SandboxFrame(props: SandboxFrameProps) {
  if (!props.enabled) return <div role="status">沙箱应用已停用。</div>;
  if (props.appId.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(props.appId) || !props.instanceKey || !validateSandboxResource(props.resource)
    || (typeof window !== 'undefined' && window.location.origin !== props.resource.platformOrigin)) {
    return <div role="alert">沙箱资源配置不安全，已拒绝加载。</div>;
  }
  return <MountedFrame key={`${props.appId}:${props.instanceKey}`} {...props} />;
}
function MountedFrame({ appId, resource, operations, title }: SandboxFrameProps) {
  const frame=useRef<HTMLIFrameElement>(null);
  const broker=useRef<SandboxBridgeBroker | null>(null);
  const loaded=useRef(false);
  const active=useRef(false);
  const config=useRef({resource,operations});
  const [session]=useState(createSandboxSession);
  const [failed,setFailed]=useState(false);
  // Resource/operations replacement revokes channel even if the caller forgot its revision key.
  useLayoutEffect(()=>{
    if(config.current.resource!==resource || config.current.operations!==operations){setFailed(true);return;}
    active.current=true;
    const onMessage=(event:MessageEvent)=>{ void broker.current?.receive(event); };
    window.addEventListener('message',onMessage);
    return ()=>{ active.current=false;window.removeEventListener('message',onMessage); broker.current?.close();broker.current=null; };
  },[resource,operations]);
  const onLoad=()=>{
    if(!active.current)return;
    if(loaded.current){broker.current?.close();broker.current=null;setFailed(true);return;}
    loaded.current=true;
    const target=frame.current?.contentWindow;
    if(!target){setFailed(true);return;}
    broker.current=new SandboxBridgeBroker({appId,session,source:target,operations,
      send:response=>target.postMessage(response,'*')});
    // Opaque target cannot be named by origin. Bootstrap carries no platform identity or bearer secret.
    target.postMessage({version:'1.0',type:'init',appId,session},'*');
  };
  if(failed)return <div role="alert">沙箱页面重新导航或加载异常，通道已关闭，请重新打开。</div>;
  return <iframe ref={frame} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer"
    allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; fullscreen 'none'"
    src={resource.mode==='isolated-origin'?resource.url:undefined}
    srcDoc={resource.mode==='local-demo'?resource.html:undefined}
    onLoad={onLoad} onError={()=>{broker.current?.close();setFailed(true);}}
    style={{width:'100%',height:'calc(100dvh - 180px)',minHeight:600,border:0}} />;
}
