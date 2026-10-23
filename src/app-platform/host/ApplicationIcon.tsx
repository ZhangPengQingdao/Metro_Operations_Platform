import React from 'react';
import type {AppManifest} from '@metro/platform-sdk/app-manifest';
import {PlatformIcon,TRANSIT_ICON_LIST} from '../../components/ui';

// First-party applications share the L2 business icon catalogue. Other signed
// applications keep their own manifest icon and the generic fallback.
const applicationIcons = new Map([
 ['faults','warning'],
 ['hazards','warning-diamond'],
 ['maintenance','calendar-dots'],
 ['materials','package'],
 ['shifts','sun-horizon'],
 ['signatures','signature'],
 ['todos','check-square'],
]);
const catalogue = new Map(TRANSIT_ICON_LIST.map(item=>[item.id,item.component]));

/** v2 packages ship their own icon file: white line art shown on the app's colour tile. */
export function v2IconProps(app:{appId:string;model?:'v2';v2?:{color:string|null}}):{iconUrl?:string;color?:string|null}{
 return app.model==='v2'?{iconUrl:`/api/employee/apps/${app.appId}/icon`,color:app.v2?.color??null}:{};
}
export function ApplicationIcon({appId,icon,iconUrl,color,size=20}:{appId:string;icon?:AppManifest['icon'];iconUrl?:string;color?:string|null;size?:number}) {
 if(iconUrl)return <span className="app-icon-tile" style={{width:size,height:size,background:color??'#2563EB'}} aria-hidden="true"><img src={iconUrl} alt="" width={Math.round(size*0.7)} height={Math.round(size*0.7)}/></span>;
 const Icon=catalogue.get(applicationIcons.get(appId)??'');
 if(Icon)return <Icon size={size} weight="regular" aria-hidden="true" focusable="false"/>;
 if(icon)return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{icon.paths.map((d,i)=><path key={i} d={d}/>)}</svg>;
 return <PlatformIcon name="cube" size={size}/>;
}
