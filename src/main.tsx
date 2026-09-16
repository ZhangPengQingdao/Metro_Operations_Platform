import '../index.css';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {HashRouter,Routes,Route,Navigate} from 'react-router-dom';
import AdminApp from './app-platform/admin/AdminApp';
import EmployeeApp from './app-platform/employee/EmployeeApp';
import {ToastProvider} from './components/ui';

createRoot(document.getElementById('root')!).render(<React.StrictMode><ToastProvider><HashRouter><Routes><Route path="/admin/*" element={<AdminApp/>}/><Route path="/employee/*" element={<EmployeeApp/>}/><Route path="*" element={<Navigate to="/employee" replace/>}/></Routes></HashRouter></ToastProvider></React.StrictMode>);
