import React from 'react';
import {DataList,type DataListProps} from './DataList';
import {FilterBar,type FilterBarProps} from './FilterBar';

export interface QueryListProps extends Omit<DataListProps,'toolbar'> {
  query: Omit<FilterBarProps,'rightAction'>;
  actions?: React.ReactNode;
}

/** Search and filters stay controlled by the page; this component owns their list layout. */
export function QueryList({query,actions,...list}:QueryListProps){
  return <DataList {...list} toolbar={<FilterBar {...query} rightAction={actions}/>}/>;
}
