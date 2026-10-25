import React from "react";
import {Button, type ButtonProps} from "./Button";

export interface TableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  compact?: boolean;
  pinActions?: boolean;
  variant?: 'default' | 'directory';
  emptyState?: React.ReactNode;
  wrapperClassName?: string;
}

export const Table: React.FC<TableProps> = ({
  compact = false,
  pinActions = false,
  variant = 'default',
  emptyState,
  className = "",
  wrapperClassName = "",
  children,
  ...props
}) => {
  return (
    <div className={`afc-table-wrapper ${variant === 'directory' ? 'afc-table-wrapper--directory' : ''} ${pinActions ? "afc-table-wrapper--actions" : ""} ${wrapperClassName}`}>
      <table className={`afc-table ${compact ? "afc-table--compact" : ""} ${className}`} {...props}>
        {children}
      </table>
      {emptyState && <div className="afc-table-empty" role="status">{emptyState}</div>}
    </div>
  );
};

export const TableHeader: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({ className = "", children, ...props }) => (
  <thead className={className} {...props}>{children}</thead>
);

export const TableBody: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({ className = "", children, ...props }) => (
  <tbody className={className} {...props}>{children}</tbody>
);

export const TableRow: React.FC<React.HTMLAttributes<HTMLTableRowElement>> = ({ className = "", children, ...props }) => (
  <tr className={className} {...props}>{children}</tr>
);

export const TableHead: React.FC<React.ThHTMLAttributes<HTMLTableCellElement>> = ({ className = "", children, ...props }) => (
  <th className={className} {...props}>{children}</th>
);

export const TableCell: React.FC<React.TdHTMLAttributes<HTMLTableCellElement>> = ({ className = "", children, ...props }) => (
  <td className={className} {...props}>{children}</td>
);

const DESTRUCTIVE=/^(删除|作废|撤销|移除|停用|驳回|退回)/;
/** Inline text action for a table's trailing operations column; destructive labels render in red. */
export function TableActionButton({icon,children,className='',tone,...props}:ButtonProps&{icon?:React.ReactNode;tone?:'default'|'danger'}){
  const danger=tone==='danger'||(tone===undefined&&typeof children==='string'&&DESTRUCTIVE.test(children));
  return <Button {...props} variant="ghost" size="sm" className={`afc-table-action${danger?' afc-table-action--danger':''} ${className}`}>{icon&&<span className="afc-table-action__icon" aria-hidden="true">{icon}</span>}<span>{children}</span></Button>;
}
