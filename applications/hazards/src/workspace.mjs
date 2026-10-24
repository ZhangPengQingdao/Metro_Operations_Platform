export const hazardPages = Object.freeze([
 {id:'report',path:'/report',label:'隐患提报',permission:'app.hazards.create'},
 {id:'records',path:'/',label:'隐患记录',permission:'app.hazards.read'},
 {id:'cases',path:'/cases',label:'闭环案例库',permission:'app.hazards.cases'},
]);
export const visiblePages = session => hazardPages.filter(page=>session?.permissions?.includes(page.permission));
export const pageForRoute = (path,session) => visiblePages(session).find(page=>page.path===path);
