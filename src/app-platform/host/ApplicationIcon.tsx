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

export function ApplicationIcon({appId,icon,size=20}:{appId:string;icon?:AppManifest['icon'];size?:number}) {
 const Icon=catalogue.get(applicationIcons.get(appId)??'');
 if(Icon)return <Icon size={size} weight="regular" aria-hidden="true" focusable="false"/>;
 if(icon)return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{icon.paths.map((d,i)=><path key={i} d={d}/>)}</svg>;
 return <PlatformIcon name="cube" size={size}/>;
}
