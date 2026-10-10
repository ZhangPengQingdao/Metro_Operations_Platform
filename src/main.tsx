import Login from './app-platform/identity/Login';
import '../index.css';
import React,{lazy,Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import {HashRouter,Routes,Route,Navigate} from 'react-router-dom';
const AdminApp=lazy(()=>import('./app-platform/admin/AdminApp'));
const EmployeeApp=lazy(()=>import('./app-platform/employee/EmployeeApp'));
import {ToastProvider} from './components/ui';

createRoot(document.getElementById('root')!).render(<React.StrictMode><ToastProvider><HashRouter><Suspense fallback={<p role="status">正在加载工作区…</p>}><Routes><Route path="/login" element={<Login/>}/><Route path="/admin/login" element={<Navigate to="/login" replace/>}/><Route path="/employee/login" element={<Navigate to="/login" replace/>}/><Route path="/admin/*" element={<AdminApp/>}/><Route path="/employee/*" element={<EmployeeApp/>}/><Route path="*" element={<Navigate to="/login" replace/>}/></Routes></Suspense></HashRouter></ToastProvider></React.StrictMode>);
