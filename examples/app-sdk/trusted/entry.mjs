import React, {useEffect, useState} from 'react';
import {loadGreeting} from '../app.mjs';
/** Approved host injects its client; module declares pages, never a second login/router/shell. */
export function createTrustedSample(client) {
 function Home({context}) {
  const [text,setText]=useState('准备读取示例问候');
  useEffect(()=>{let current=true;loadGreeting(client,'AFC').then(value=>{if(current&&!context.signal.aborted)setText(value);},()=>{if(current)setText('调用未完成，请重新打开应用');});return()=>{current=false;};},[context.signal]);
  return React.createElement('section',null,React.createElement('h2',null,'可信应用示例'),React.createElement('p',{role:'status'},text));
 }
 return Object.freeze({pages:Object.freeze({home:Home})});
}
