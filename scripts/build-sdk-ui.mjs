import {build} from 'esbuild';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
// Build public application UI from the same L2 sources as the platform.
// Published artifacts contain no imports of repository source paths.
await build({stdin:{contents:`export {PencilSimpleLine,Trash,Plus,ArrowLineDown,ArrowLineUp} from '@phosphor-icons/react';export {Button,IconButton} from './src/components/ui/Button';export {Input,Select,Field,QuantityInput} from './src/components/ui/FormControls';export {OrganizationPicker} from './src/components/ui/OrganizationPicker';export {OrganizationPeoplePicker} from './src/components/ui/OrganizationPeoplePicker';export {SearchField} from './src/components/ui/SearchField';export {DatePicker} from './src/components/ui/DatePicker';export {TimePicker} from './src/components/ui/TimePicker';export {TagDropdownPicker} from './src/components/ui/TagDropdownPicker';export {HandwrittenSignaturePad} from './src/components/ui/HandwrittenSignaturePad';export {Checkbox} from './src/components/ui/Checkbox';export {Switch} from './src/components/ui/Switch';export {FilterBar} from './src/components/ui/FilterBar';export {Table,TableHeader,TableBody,TableRow,TableHead,TableCell,TableActionButton} from './src/components/ui/Table';export {DataList,TableActions,ListPagination} from './src/components/ui/DataList';export {QueryList} from './src/components/ui/QueryList';export {Dialog} from './src/components/ui/Dialog';export {SidebarDialog} from './src/components/ui/SidebarDialog';`,resolveDir:root,loader:'ts'},bundle:true,format:'esm',platform:'browser',target:'es2022',external:['react','react-dom'],outfile:root+'packages/platform-sdk/dist/ui.js',minify:true});
const source=(await readFile(root+'index.css','utf8')).replace(/^@import[^;]+;/gm,'');
const result=await postcss([tailwind({content:[root+'src/components/ui/**/*.{ts,tsx}'],safelist:['afc-theme-neutral','afc-filter-bar-wrapper--spread'],theme:{extend:{}},plugins:[]}),autoprefixer()]).process(source,{from:root+'index.css'});
await writeFile(root+'packages/platform-sdk/dist/ui-styles.js',`export const platformUiCss=${JSON.stringify(result.css)};\n`);
await writeFile(root+'packages/platform-sdk/dist/ui-styles.d.ts','export declare const platformUiCss:string;\n');
await writeFile(root+'packages/platform-sdk/dist/ui.d.ts',`import type {ComponentProps,ComponentType,ButtonHTMLAttributes,InputHTMLAttributes,SelectHTMLAttributes,TableHTMLAttributes,HTMLAttributes,ReactNode} from 'react';
export declare const PencilSimpleLine:ComponentType<{size?:number;weight?:'regular'|'light'|'bold'}>;
export declare const Trash:typeof PencilSimpleLine;
export declare const Plus:typeof PencilSimpleLine;
export declare const ArrowLineDown:typeof PencilSimpleLine;
export declare const ArrowLineUp:typeof PencilSimpleLine;
export declare const Button:ComponentType<ButtonHTMLAttributes<HTMLButtonElement>&{variant?:'primary'|'secondary'|'ghost'|'danger'|'soft';size?:'xs'|'sm'|'md'|'lg';loading?:boolean;fullWidth?:boolean;leadingIcon?:ReactNode}>;
export declare const IconButton:ComponentType<ButtonHTMLAttributes<HTMLButtonElement>&{label:string;size?:'sm'|'md'|'lg'}>;
export declare const Input:ComponentType<InputHTMLAttributes<HTMLInputElement>>;
export interface OrganizationOption {id:string;name:string;parentId?:string|null;status?:string}
export declare const OrganizationPicker:ComponentType<{id?:string;options:readonly OrganizationOption[];value:string;onChange:(id:string)=>void;disabled?:boolean;required?:boolean;label?:string;excludeId?:string}>;
export interface PickerOrganization{id:string;name:string;parentId:string|null}
export interface PickerPerson{id:string;name:string;employeeNo:string;organizationId:string}
export interface OrganizationPeoplePickerProps{organizations:PickerOrganization[];people:PickerPerson[];organizationId:string;onOrganizationChange:(id:string)=>void;search:string;onSearchChange:(value:string)=>void;page:number;hasNext:boolean;onPageChange:(page:number)=>void;selected:(person:PickerPerson)=>boolean;onPersonChange:(person:PickerPerson,checked:boolean)=>void;organizationSelection?:(id:string)=>boolean|'mixed';onOrganizationSelection?:(id:string,checked:boolean)=>void;renderPersonAction?:(person:PickerPerson)=>ReactNode;disabled?:boolean;loading?:boolean}
export declare const OrganizationPeoplePicker:ComponentType<OrganizationPeoplePickerProps>;
export declare const SearchField:typeof Input;
export declare const DatePicker:ComponentType<{value?:string;onChange?:(value:string)=>void;placeholder?:string;disabled?:boolean;clearable?:boolean;minDate?:string;maxDate?:string;className?:string;size?:'sm'|'md'|'lg'}>;
export declare const TimePicker:ComponentType<{value?:string;onChange?:(value:string)=>void;placeholder?:string;disabled?:boolean;clearable?:boolean;minuteStep?:number;className?:string;size?:'sm'|'md'|'lg'}>;
export declare const TagDropdownPicker:ComponentType<{items:{id:string;label:string;group?:string;badge?:string|number;disabled?:boolean}[];selectedIds:string[];onChange:(ids:string[])=>void;title?:string;buttonText?:string;buttonVariant?:'primary'|'secondary'|'soft'|'ghost'|'outline';emptyText?:string;disabled?:boolean;multiple?:boolean;align?:'left'|'right';showTagsBelow?:boolean;className?:string}>;
export declare const Checkbox:ComponentType<Omit<InputHTMLAttributes<HTMLInputElement>,'type'>&{label?:ReactNode;description?:ReactNode;containerClassName?:string}>;
export declare const Switch:ComponentType<Omit<InputHTMLAttributes<HTMLInputElement>,'size'>&{label?:ReactNode;description?:ReactNode;size?:'sm'|'md'}>;
export declare const HandwrittenSignaturePad:ComponentType<{signerName?:string;submitting?:boolean;strokeColor?:string;strokeWidth?:number;transparentBackground?:boolean;onCancel?:()=>void;onSubmit?:(blob:Blob,dataUrl:string)=>Promise<void>|void;onChange?:(hasInk:boolean)=>void;embedded?:boolean;showHeading?:boolean;showToolbar?:boolean;height?:string;className?:string}>;
export declare const QuantityInput:ComponentType<Omit<InputHTMLAttributes<HTMLInputElement>,'value'|'onChange'|'min'|'max'|'type'>&{value:number|string;onValueChange:(value:string)=>void;min?:number;max?:number}>;
export declare const Select:ComponentType<SelectHTMLAttributes<HTMLSelectElement>>;
export declare const Field:ComponentType<{label:ReactNode;htmlFor?:string;children:ReactNode}>;
export interface DialogProps {open:boolean;onClose:()=>void;title:ReactNode;children:ReactNode;description?:ReactNode;icon?:ReactNode;headerAction?:ReactNode;footer?:ReactNode;size?:'sm'|'md'|'lg'|'xl';closeLabel?:string;className?:string;closeOnBackdropClick?:boolean}
export declare const Dialog:ComponentType<DialogProps>;
export interface SidebarDialogSection<Id extends string=string> {id:Id;label:string;icon?:ReactNode;disabled?:boolean}
export interface SidebarDialogProps<Id extends string=string> extends Omit<DialogProps,'size'> {sections:readonly SidebarDialogSection<Id>[];activeSection:Id;onSectionChange:(id:Id)=>void;navigationLabel?:string;sectionTitle?:ReactNode;contentClassName?:string}
export declare function SidebarDialog<Id extends string>(props:SidebarDialogProps<Id>):ReactNode;
export declare const FilterBar:ComponentType<{layout?:'compact'|'spread';searchValue?:string;onSearchChange?:(value:string)=>void;searchPlaceholder?:string;showDateRange?:boolean;rightAction?:ReactNode;filterGroups?:{id:string;title:string;options:{id:string;label:string}[];isMulti?:boolean;allowAll?:boolean}[];activeFilters?:{startDate?:string;endDate?:string;selectedOptions:Record<string,string[]>};onApplyFilters?:(filters:{startDate?:string;endDate?:string;selectedOptions:Record<string,string[]>})=>void;onResetFilters?:()=>void;showActiveTags?:boolean;moreActions?:{id:string;label:string;icon?:ReactNode;onClick?:()=>void;danger?:boolean;highlight?:boolean}[];onRemoveTag?:(groupId:string,optionId:string)=>void;className?:string}>;
export declare const Table:ComponentType<TableHTMLAttributes<HTMLTableElement>&{compact?:boolean;pinActions?:boolean;variant?:'default'|'directory';emptyState?:ReactNode;wrapperClassName?:string}>;
export declare const DataList:ComponentType<ComponentProps<typeof Table>&{toolbar?:ReactNode;notice?:ReactNode;pagination?:ReactNode}>;
export declare const QueryList:ComponentType<Omit<ComponentProps<typeof DataList>,'toolbar'>&{query:Omit<ComponentProps<typeof FilterBar>,'rightAction'>;actions?:ReactNode}>;
export declare const TableActions:ComponentType<{children:ReactNode}>;
export declare const ListPagination:ComponentType<{page:number;total?:number;hasNext:boolean;busy?:boolean;onPrevious:()=>void;onNext:()=>void;extra?:ReactNode}>;
export declare const TableActionButton:ComponentType<ButtonHTMLAttributes<HTMLButtonElement>&{icon:ReactNode}>;
export declare const TableHeader:ComponentType<HTMLAttributes<HTMLTableSectionElement>>;
export declare const TableBody:typeof TableHeader;
export declare const TableRow:ComponentType<HTMLAttributes<HTMLTableRowElement>>;
export declare const TableHead:ComponentType<HTMLAttributes<HTMLTableCellElement>>;
export declare const TableCell:typeof TableHead;
`);
