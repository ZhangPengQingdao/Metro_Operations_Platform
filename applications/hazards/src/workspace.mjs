export const hazardPages = Object.freeze([
 {id:'report',path:'/report',label:'提报隐患',permission:'app.hazards.create',nav:false},
 {id:'records',path:'/',label:'隐患记录',permission:'app.hazards.read'},
 {id:'cases',path:'/cases',label:'闭环案例库',permission:'app.hazards.cases'},
]);
const authorizedPages = session => hazardPages.filter(page=>session?.permissions?.includes(page.permission));
export const visiblePages = session => authorizedPages(session).filter(page=>page.nav!==false);
export const pageForRoute = (path,session) => authorizedPages(session).find(page=>page.path===path);
