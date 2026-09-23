import {readThemePreference} from '../../identity/theme';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  /** Hidden warm frames must not leave the surrounding platform shell inert. */
  visible?: boolean;
  title: string;
  /** Optional signed-app client routing; host verifies the new route before changing this prop. */
  route?: string;
  initialRoute?: string;
  onRouteReady?: (route:string)=>void;
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

export function themedSandboxHtml(html:string,theme:'light'|'dark'):string {
  const background=theme==='dark'?'#121212':'#fafafa',color=theme==='dark'?'#fafafa':'#171717';
  return html.replace('<html>',`<html class="afc-theme-neutral" data-theme="${theme}">`).replace(/(<style nonce="[A-Za-z0-9+/=]+">)/,`$1html,body{background:${background};color:${color};color-scheme:${theme}}`);
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
function MountedFrame({ appId, resource, operations, title, route, initialRoute, onRouteReady, visible=true }: SandboxFrameProps) {
  const frame=useRef<HTMLIFrameElement>(null);
  const broker=useRef<SandboxBridgeBroker | null>(null);
  const loaded=useRef(false);
  const active=useRef(false);
  const config=useRef({resource,operations});
  const lastSentRoute=useRef(initialRoute);
  const routeRef=useRef(route),routeReadyRef=useRef(onRouteReady);
  routeRef.current=route;routeReadyRef.current=onRouteReady;
  const [session]=useState(createSandboxSession);
  const [initialTheme]=useState<'dark'|'light'>(()=>{
    const preference=(typeof document!=='undefined'?document.querySelector('.afc-admin')?.getAttribute('data-theme'):undefined)??readThemePreference();
    return preference==='dark'||preference==='system'&&typeof window!=='undefined'&&window.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light';
  });
  const [initialHtml]=useState(()=>resource.mode==='local-demo'?themedSandboxHtml(resource.html,initialTheme):undefined);
  const [failed,setFailed]=useState(false);
  const [modalOpen,setModalOpen]=useState(false);
  useEffect(()=>{
    if(!modalOpen||failed||!visible)return;
    const shell=frame.current?.closest('.afc-admin');
    if(!shell)return;
    const siblings=Array.from(shell.querySelectorAll<HTMLElement>('.afc-sidebar-island,.afc-page-header'));
    const previous=siblings.map(element=>element.inert);
    shell.classList.add('afc-sandbox-modal-shell');siblings.forEach(element=>{element.inert=true;});
    return()=>{shell.classList.remove('afc-sandbox-modal-shell');siblings.forEach((element,index)=>{element.inert=previous[index]!;});};
  },[modalOpen,failed,visible]);
  // Resource/operations replacement revokes channel even if the caller forgot its revision key.
  useLayoutEffect(()=>{
    if(config.current.resource!==resource || config.current.operations!==operations){setFailed(true);return;}
    active.current=true;
    const onMessage=(event:MessageEvent)=>{
      if(event.source===frame.current?.contentWindow&&event.origin==='null'){
       const value=event.data;
       if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')==='appId,path,session,type,version'
        &&value.version==='1.0'&&value.type==='route-ready'&&value.appId===appId&&value.session===session
        &&typeof value.path==='string'&&value.path===routeRef.current)routeReadyRef.current?.(value.path);
      }
      void broker.current?.receive(event);
    };
    window.addEventListener('message',onMessage);
    return ()=>{ active.current=false;window.removeEventListener('message',onMessage); broker.current?.close();broker.current=null; };
  },[resource,operations]);
  useEffect(()=>{
    if(route&&route!==lastSentRoute.current&&broker.current){frame.current?.contentWindow?.postMessage({version:'1.0',type:'route',appId,session,path:route},'*');lastSentRoute.current=route;}
  },[route,initialRoute,appId,session]);
  const onLoad=()=>{
    if(!active.current)return;
    if(loaded.current){broker.current?.close();broker.current=null;setFailed(true);return;}
    loaded.current=true;
    const target=frame.current?.contentWindow;
    if(!target){setFailed(true);return;}
    const frameOperations=new Map(operations);
    frameOperations.set('platform.ui.theme',{
      validate:params=>!!params&&typeof params==='object'&&!Array.isArray(params)&&Object.keys(params).length===0,
      authorize:async()=>true,
      execute:async()=>{const preference=frame.current?.closest('.afc-admin')?.getAttribute('data-theme');return {theme:preference==='dark'||preference==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'};},
    });
    frameOperations.set('platform.ui.modal',{
      validate:params=>!!params&&typeof params==='object'&&!Array.isArray(params)&&Object.keys(params).length===1&&typeof (params as {open?:unknown}).open==='boolean',
      authorize:async()=>true,
      execute:async params=>{setModalOpen((params as {open:boolean}).open);return {ok:true};},
    });
    broker.current=new SandboxBridgeBroker({appId,session,source:target,operations:frameOperations,
      send:response=>target.postMessage(response,'*')});
    // Opaque target cannot be named by origin. Bootstrap carries no platform identity or bearer secret.
    target.postMessage({version:'1.0',type:'init',appId,session},'*');
    if(routeRef.current&&routeRef.current!==lastSentRoute.current){target.postMessage({version:'1.0',type:'route',appId,session,path:routeRef.current},'*');lastSentRoute.current=routeRef.current;}
  };
  if(failed)return <div role="alert">沙箱页面重新导航或加载异常，通道已关闭，请重新打开。</div>;
  const isDark=initialTheme==='dark';
  return <iframe ref={frame} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer"
    allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; fullscreen 'none'"
    src={resource.mode==='isolated-origin'?`${resource.url}#mop-theme=${isDark?'dark':'light'}`:undefined}
    srcDoc={initialHtml}
    onLoad={onLoad} onError={()=>{broker.current?.close();setFailed(true);}}
    style={{width:'100%',height:'calc(100dvh - 150px)',minHeight:360,border:0,background:'transparent',colorScheme:isDark?'dark':'light'}} />;
}
