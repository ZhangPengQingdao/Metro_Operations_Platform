import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from 'react-router-dom';
import {NotificationList} from '../../src/app-platform/host/NotificationList.tsx';

test('a notification links its whole content and keeps read actions outside the link',()=>{
 const html=renderToStaticMarkup(<MemoryRouter><NotificationList items={[{
  id:'task',title:'待签字：测试任务',body:'请本人签署',href:'/employee/app/signatures/sign/task',unread:true,
  actions:<button type="button">标为已读</button>
 }]}/></MemoryRouter>);
 const linkStart=html.indexOf('<a '),linkEnd=html.indexOf('</a>');
 assert.match(html.slice(linkStart,linkEnd),/href="\/employee\/app\/signatures\/sign\/task"/);
 assert.match(html.slice(linkStart,linkEnd),/待签字：测试任务/);
 assert.match(html.slice(linkStart,linkEnd),/请本人签署/);
 assert.ok(html.indexOf('<button')>linkEnd);
 assert.doesNotMatch(html,/去签字|>查看</);
});

test('informational notifications remain readable without an artificial navigation target',()=>{
 const html=renderToStaticMarkup(<NotificationList items={[{id:'info',title:'系统提示',body:'通知内容'}]}/>);
 assert.match(html,/系统提示/);
 assert.doesNotMatch(html,/<a /);
});
