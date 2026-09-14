import {createAppSandboxClient} from '@metro/platform-sdk/app-sandbox';
import {loadGreeting} from '../app.mjs';
/** Platform resource builder must supply the approved platform origin, never a wildcard. */
export function mountSandboxSample(root,platformOrigin) {
 const client=createAppSandboxClient({appId:'sdk-sandbox-sample',platformOrigin,port:{parent:window.parent,
  send:(message,origin)=>window.parent.postMessage(message,origin),
  listen:listener=>{window.addEventListener('message',listener);return()=>window.removeEventListener('message',listener);},
 }});
 const title=document.createElement('h2');title.textContent='沙箱应用示例';
 const button=document.createElement('button');button.textContent='读取示例问候';
 const output=document.createElement('p');output.setAttribute('role','status');output.textContent='等待宿主建立 Bridge 后可读取';
 let active=true;
 button.onclick=async()=>{button.disabled=true;try{const text=await loadGreeting(client,'AFC');if(active)output.textContent=text;}catch{if(active)output.textContent='调用未完成或尚未连接';}finally{if(active)button.disabled=false;}};
 root.replaceChildren(title,button,output);
 return()=>{active=false;client.close();button.onclick=null;root.replaceChildren();};
}
