import React from 'react';
import {Table,type TableProps} from './Table';
import {Button} from './Button';

/** Shared list composition. Pages own querying, authorization and row contents. */
export interface DataListProps extends TableProps {
  toolbar?:React.ReactNode;
  notice?:React.ReactNode;
  pagination?:React.ReactNode;
}
export function DataList({toolbar,notice,pagination,children,variant='directory',pinActions=true,...table}:DataListProps){
  return <div className="afc-data-list">
    {toolbar&&<div className="afc-data-list__toolbar">{toolbar}</div>}
    {notice&&<div className="afc-data-list__notice">{notice}</div>}
    <Table {...table} variant={variant} pinActions={pinActions}>{children}</Table>
    {pagination&&<div className="afc-data-list__footer">{pagination}</div>}
  </div>;
}
export function TableActions({children}: {children:React.ReactNode}){
  return <div className="afc-table-actions">{children}</div>;
}
export interface ListPaginationProps {
  page:number;
  total?:number;
  hasNext:boolean;
  busy?:boolean;
  onPrevious:()=>void;
  onNext:()=>void;
  extra?:React.ReactNode;
}
/** Supports offset and cursor pagination without guessing a total. */
export function ListPagination({page,total,hasNext,busy=false,onPrevious,onNext,extra}:ListPaginationProps){
  return <nav className="afc-list-pagination" aria-label="列表分页">
    <span className="afc-list-pagination__summary">第 {page} 页{total!==undefined?` · 共 ${total} 项`:''}</span>
    <Button variant="secondary" size="sm" disabled={busy||page<=1} onClick={onPrevious}>上一页</Button>
    <Button variant="secondary" size="sm" disabled={busy||!hasNext} onClick={onNext}>下一页</Button>
    {extra}
  </nav>;
}
