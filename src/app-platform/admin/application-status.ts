import type {Installation} from './AdminApp';

const actions:Record<string,string>={install:'安装',enable:'启动',disable:'停用',upgrade:'更新',rollback:'回退',uninstall:'卸载'};
export function applicationStatus(app:Installation,serving:boolean,pending=false):string{
 if(pending)return '调用结果待核对';
 if(app.lifecycle&&!['completed','cancelled'].includes(app.lifecycle.status))return `${actions[app.lifecycle.action]??'应用操作'}结果待核对`;
 if(serving)return '正在运行';
 return app.enabled?'运行中断，待核对':'已停用';
}
