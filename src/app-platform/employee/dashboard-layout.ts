import type {DashboardLayout} from '@metro/platform-sdk/app-dashboard';
export type LayoutOption={id:string;label:string;detail?:string};
export type LayoutOptions=Record<'cards'|'charts'|'shortcuts',LayoutOption[]>;
export function defaultDashboardLayout(options:LayoutOptions):DashboardLayout{
 const chartOrder=['faults:series','huicetong:completion','maintenance:series','todos:completion'];
 const charts=chartOrder.filter(id=>options.charts.some(option=>option.id===id));
 return {version:1,cards:options.cards.slice(0,4).map(o=>o.id),charts:charts.length?charts:options.charts.slice(0,4).map(o=>o.id),shortcuts:options.shortcuts.slice(0,8).map(o=>o.id)};
}
/** Catalogue intersection preserves explicit empty selections and saved ordering after revocation. */
export function visibleDashboardLayout(layout:DashboardLayout,options:LayoutOptions):DashboardLayout{
 return {version:1,cards:layout.cards.filter(id=>options.cards.some(o=>o.id===id)),charts:layout.charts.filter(id=>options.charts.some(o=>o.id===id)),shortcuts:layout.shortcuts.filter(id=>options.shortcuts.some(o=>o.id===id))};
}
export function moveDashboardItem(ids:string[],id:string,direction:-1|1){
 const index=ids.indexOf(id),target=index+direction;
 if(index<0||target<0||target>=ids.length)return ids;
 const moved=[...ids];[moved[index],moved[target]]=[moved[target],moved[index]];return moved;
}
export function dashboardTone(id:string){
 const known:Record<string,string>={faults:'coral',maintenance:'mint',todos:'blue',huicetong:'violet'};
 return known[id]??['blue','mint','violet','amber'][[...id].reduce((n,c)=>n+c.charCodeAt(0),0)%4];
}
/** Horizontal tangents and monotone control points keep interpolation within adjacent values. */
export function smoothDashboardPath(points:{x:number;y:number}[]){
 if(!points.length)return '';
 return points.slice(1).reduce((path,p,index)=>{const prev=points[index],middle=(prev.x+p.x)/2;return `${path} C${middle},${prev.y} ${middle},${p.y} ${p.x},${p.y}`;},`M${points[0].x},${points[0].y}`);
}
