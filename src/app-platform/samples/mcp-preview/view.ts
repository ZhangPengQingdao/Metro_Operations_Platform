import {App} from '@modelcontextprotocol/ext-apps';
const app = new App({name:'AFC conformance view',version:'1'}, {}, {autoResize:false});
const output = document.getElementById('output')!;
const probes: Record<string, unknown> = {};
const report = () => {document.getElementById('probes')!.textContent = JSON.stringify(probes);};
document.addEventListener('securitypolicyviolation', event => {
  probes[event.effectiveDirective] = 'blocked'; report();
});
try {probes.cookie = document.cookie || 'empty';} catch {probes.cookie = 'blocked';}
try {probes.parent = window.parent.document.title;} catch {probes.parent = 'blocked';}
app.ontoolinput = () => {document.getElementById('input')!.textContent = 'input received';};
app.ontoolresult = result => {output.textContent = JSON.stringify(result);};
document.getElementById('call')!.onclick = async () => {
  try {output.textContent = JSON.stringify(await app.callServerTool({name:'fixtureecho',arguments:{}}));}
  catch {output.textContent = 'call denied';}
};
document.getElementById('foreign')!.onclick = async () => {
  try {await app.callServerTool({name:'otherapp',arguments:{}}); output.textContent='unexpected success';}
  catch {output.textContent='foreign denied';}
};
document.getElementById('probe')!.onclick = async () => {
  try {await fetch('https://127.0.0.1:8447/blocked');probes.network='unexpected';} catch {probes.network='blocked';}
  const image = document.createElement('img');image.src='https://127.0.0.1:8447/blocked-image';document.body.append(image);
  const frame = document.createElement('iframe');frame.src='https://127.0.0.1:8447/blocked-frame';document.body.append(frame);
  const base = document.createElement('base');base.href='https://127.0.0.1:8447/';document.head.append(base);
  try {probes.camera=(await navigator.permissions.query({name:'camera' as PermissionName})).state;} catch {probes.camera='unavailable';}
  report();
};
report();
void app.connect();
