import {Registration} from './Registration';
import {readThemePreference} from './theme';
import React,{useEffect,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {AdminLogin} from '../admin/AdminLogin';
import '../admin/admin.css';
export default function Login(){
 const [register,setRegister]=useState(false);
 const navigate=useNavigate(),[loading,setLoading]=useState(true);
 useEffect(()=>{let active=true;Promise.all(['/api/admin/auth/me','/api/employee/auth/me'].map(async path=>{try{return (await fetch(path,{credentials:'same-origin'})).ok;}catch{return false;}})).then(([admin,employee])=>{if(!active)return;if(admin!==employee&&(admin||employee))navigate(admin?'/admin':'/employee',{replace:true});else setLoading(false);});return()=>{active=false;};},[navigate]);
 if(loading)return <main className="afc-admin afc-theme-neutral afc-admin-login" data-theme={readThemePreference()} role="status">正在检查登录状态…</main>;
 if(register)return <Registration onBack={()=>setRegister(false)}/>;
 return <AdminLogin onRegister={()=>setRegister(true)} title="登录" onLogin={async(username,password)=>{
  const response=await fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  const value=await response.json();
  if(!response.ok)throw Error(value.error==='LOGIN_RATE_LIMIT'?'尝试次数过多，请稍后再试。':value.error==='LOGIN_ACCOUNT_CONFLICT'?'账号存在重名，请联系管理员调整账号名称。':response.status===401?'用户名或密码不正确。':'登录暂不可用，请稍后再试。');
  navigate(value.kind==='admin'?'/admin':'/employee',{replace:true});
 }}/>;
}
