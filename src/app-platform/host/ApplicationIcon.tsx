import React from 'react';
import {PlatformIcon} from '../../components/ui';

/** Icon of an installed app: its own icon file (white line art) on the app's colour tile. */
export function appIconProps(app:{appId:string;v2:{color:string|null}}):{iconUrl:string;color:string|null}{
 return {iconUrl:`/api/employee/apps/${app.appId}/icon`,color:app.v2.color};
}
export function ApplicationIcon({iconUrl,color,size=20}:{appId:string;iconUrl?:string;color?:string|null;size?:number}) {
 if(iconUrl)return <span className="app-icon-tile" style={{width:size,height:size,background:color??'#2563EB'}} aria-hidden="true"><img src={iconUrl} alt="" width={Math.round(size*0.7)} height={Math.round(size*0.7)}/></span>;
 return <PlatformIcon name="cube" size={size}/>;
}
