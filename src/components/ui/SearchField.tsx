import React from 'react';
import {Input} from './FormControls';
import {PlatformIcon} from './PlatformIcon';

/** Always-visible capsule search for directory toolbars; submission belongs to the enclosing form. */
export const SearchField=React.forwardRef<HTMLInputElement,React.InputHTMLAttributes<HTMLInputElement>>(function SearchField({className,...props},ref){
 return <Input ref={ref} type="search" aria-label="搜索" {...props} className={['afc-control--search',className].filter(Boolean).join(' ')} leadingIcon={<PlatformIcon name="search" size={18}/>}/>;
});
