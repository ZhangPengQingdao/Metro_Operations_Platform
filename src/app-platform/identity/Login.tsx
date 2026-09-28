import {Registration} from './Registration';
import {readThemePreference} from './theme';
import React,{useEffect,useState} from 'react';
import {useLocation,useNavigate} from 'react-router-dom';
import {AdminLogin} from '../admin/AdminLogin';
import '../admin/admin.css';
export default function Login(){
 const [register,setRegister]=useState(false);
 const navigate=useNavigate(),location=useLocation(),[loading,setLoading]=useState(true);
 const requested=location.state?.returnTo;
 const employeeDestination=typeof requested==='string'&&/^\/employee\/app\/signatures\/sign\?task=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requested)?requested:'/employee';
 useEffect(()=>{let active=true;Promise.all(['/api/admin/auth/me','/api/employee/auth/me'].map(async path=>{try{return (await fetch(path,{credentials:'same-origin'})).ok;}catch{return false;}})).then(([admin,employee])=>{if(!active)return;if(admin!==employee&&(admin||employee))navigate(admin?'/admin':employeeDestination,{replace:true});else setLoading(false);});return()=>{active=false;};},[navigate,employeeDestination]);
 if(loading)return <main className="afc-admin afc-theme-neutral afc-admin-login" data-theme={readThemePreference()} role="status">正在检查登录状态…</main>;
 if(register)return <Registration onBack={()=>setRegister(false)}/>;
 return <AdminLogin onRegister={()=>setRegister(true)} title="登录" onLogin={async(username,password)=>{
  const response=await fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  const value=await response.json();
  if(!response.ok)throw Error(value.error==='LOGIN_RATE_LIMIT'?'尝试次数过多，请稍后再试。':value.error==='LOGIN_ACCOUNT_CONFLICT'?'账号存在重名，请联系管理员调整账号名称。':response.status===401?'用户名或密码不正确。':'登录暂不可用，请稍后再试。');
  navigate(value.kind==='admin'?'/admin':employeeDestination,{replace:true});
 }}/>;
}
