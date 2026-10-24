import React, { useState, useRef, useMemo } from 'react';
import { Tag } from './Tag';
import { X, CaretDown } from '@phosphor-icons/react';
import { IconButton } from './Button';
import { FloatingPortal } from './FloatingPortal';

export interface TagFilterItem {
  id: string;
  label: string;
  group?: string;
  badge?: string | number;
  disabled?: boolean;
}

export interface TagDropdownPickerProps {
  items: TagFilterItem[];
  selectedIds: string[];
  onChange: (selectedIds: string[]) => void;
  title?: string;
  showTitle?: boolean;
  buttonText?: string;
  buttonVariant?: 'primary' | 'secondary' | 'soft' | 'ghost' | 'outline';
  emptyText?: string;
  disabled?: boolean;
  multiple?: boolean;
  align?: 'left' | 'right';
  showTagsBelow?: boolean;
  inline?: boolean;
  className?: string;
}

export const TagDropdownPicker: React.FC<TagDropdownPickerProps> = ({
  items,
  selectedIds,
  onChange,
  title = '',
  showTitle = true,
  buttonText,
  buttonVariant = 'primary',
  emptyText = '未选择项目',
  disabled = false,
  multiple = true,
  align = 'right',
  showTagsBelow = true,
  inline = false,
  className = ''
}) => {
  const [isOpen, setIsOpen] = useState(inline);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // 按 group 分组
  const groupedItems = useMemo(() => {
    const groups: { [key: string]: TagFilterItem[] } = {};
    const ungrouped: TagFilterItem[] = [];

    items.forEach((item) => {
      if (item.group) {
        if (!groups[item.group]) groups[item.group] = [];
        groups[item.group].push(item);
      } else {
        ungrouped.push(item);
      }
    });

    return { groups, ungrouped };
  }, [items]);

  const handleToggle = (id: string) => {
    if (!multiple) {
      onChange(selectedIds.includes(id) ? [] : [id]);
      return;
    }
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((item) => item !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  // 分组级别的全选
  const handleSelectAllGroup = (groupList: TagFilterItem[]) => {
    const validGroupIds = groupList.filter((item) => !item.disabled).map((item) => item.id);
    const newSelected = Array.from(new Set([...selectedIds, ...validGroupIds]));
    onChange(newSelected);
  };

  // 分组级别的清除
  const handleClearGroup = (groupList: TagFilterItem[]) => {
    const groupIdsSet = new Set(groupList.map((item) => item.id));
    onChange(selectedIds.filter((id) => !groupIdsSet.has(id)));
  };

  const btnStyle = {
    primary: 'bg-accent text-white hover:bg-accent-hover shadow-sm',
    secondary: 'bg-soft text-ink hover:bg-hover border border-line',
    soft: 'bg-soft text-ink hover:bg-hover',
    ghost: 'bg-transparent text-muted hover:bg-hover hover:text-ink',
    outline: 'border border-strong text-ink hover:border-accent hover:text-ink'
  }[buttonVariant];

  if (inline) {
    return (
      <div className={`space-y-2 ${className}`}>
        <button
          type="button"
          disabled={disabled}
          aria-expanded={isOpen}
          onClick={() => setIsOpen(!isOpen)}
          className="flex w-full items-center justify-between border-0 bg-transparent p-0 text-left cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="text-xs font-bold text-ink">
            {title}
            {selectedIds.length > 0 && <span className="ml-2 font-normal text-muted">已选 {selectedIds.length}</span>}
          </span>
          <span className="inline-flex items-center gap-1 text-xs font-medium text-muted">
            {isOpen ? '收起' : '展开'}
            <CaretDown size={12} weight="bold" className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
          </span>
        </button>
        {isOpen && (
          <div role="group" aria-label={title} className="space-y-2">
            {multiple && items.length > 0 && (
              <div className="flex justify-end gap-2 text-[11px] font-semibold">
                <button type="button" disabled={disabled} onClick={() => handleSelectAllGroup(items)} className="border-0 bg-transparent p-0 text-ink cursor-pointer hover:text-ink disabled:cursor-not-allowed">全选</button>
                <span className="text-placeholder">|</span>
                <button type="button" disabled={disabled} onClick={() => onChange([])} className="border-0 bg-transparent p-0 text-muted cursor-pointer hover:text-red-500 disabled:cursor-not-allowed">清除</button>
              </div>
            )}
            <div className="flex max-h-[320px] flex-wrap gap-1.5 overflow-y-auto">
              {items.length === 0 ? <span className="text-xs text-muted">{emptyText}</span> : items.map((item) => {
                const selected = selectedIds.includes(item.id);
                return (
                  <Tag key={item.id} interactive={!disabled&&!item.disabled} selected={selected} onClick={() => !disabled&&!item.disabled && handleToggle(item.id)} className={disabled||item.disabled ? 'opacity-40 cursor-not-allowed' : ''}>
                    {item.label}
                    {item.badge && <span className={`ml-1 text-[10px] ${selected ? 'text-white/80' : 'text-muted'}`}>{item.badge}</span>}
                  </Tag>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  const panel = (
    <>
          {/* 下拉窗头部 */}
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-line">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-ink">{title}</span>
              {selectedIds.length > 0 && (
                <span className="text-xs font-mono text-ink bg-soft px-2 py-0.5 rounded-full font-bold">
                  已选 {selectedIds.length}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {selectedIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => onChange([])}
                  className="text-xs font-semibold text-muted hover:text-ink transition-colors bg-transparent border-0 p-0 cursor-pointer"
                >
                  清除
                </button>
              )}
              <IconButton
                label="关闭选择器"
                size="sm"
                variant="ghost"
                onClick={() => setIsOpen(false)}
                className="p-1 rounded-full text-muted hover:text-ink hover:bg-hover transition-colors cursor-pointer"
              >
                <X size={15} weight="bold" />
              </IconButton>
            </div>
          </div>

          {/* 分组与标签选择区 */}
          <div className="max-h-[320px] overflow-y-auto pr-1 space-y-4 scrollbar-thin scrollbar-thumb-gray-200">
            {items.length === 0 ? (
              <div className="text-center py-6 text-xs text-muted">暂无可选项目</div>
            ) : (
              <>
                {Object.entries(groupedItems.groups).map(([groupName, groupList]) => {
                  const groupItemIds = groupList.map((x) => x.id);
                  const selectedInGroupCount = groupItemIds.filter((id) => selectedIds.includes(id)).length;
                  const isAllSelected = groupList.length > 0 && selectedInGroupCount === groupList.length;

                  return (
                    <div key={groupName} className="space-y-2">
                      <div className="flex items-center justify-between text-xs px-0.5">
                        <span className="font-bold text-ink">
                          {groupName}{' '}
                          <span className="font-normal text-muted">
                            ({selectedInGroupCount > 0 ? `${selectedInGroupCount}/` : ''}{groupList.length})
                          </span>
                        </span>
                        {multiple && (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleSelectAllGroup(groupList)}
                              className={`text-[11px] font-semibold transition-colors bg-transparent border-0 p-0 cursor-pointer ${
                                isAllSelected ? 'text-muted' : 'text-ink hover:text-ink'
                              }`}
                            >
                              全选
                            </button>
                            <span className="text-placeholder text-[10px]">|</span>
                            <button
                              type="button"
                              onClick={() => handleClearGroup(groupList)}
                              className="text-[11px] font-semibold text-muted hover:text-red-500 transition-colors bg-transparent border-0 p-0 cursor-pointer"
                            >
                              清除
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {groupList.map((item) => {
                          const isSelected = selectedIds.includes(item.id);
                          return (
                            <Tag
                              key={item.id}
                              interactive
                              selected={isSelected}
                              onClick={() => !item.disabled && handleToggle(item.id)}
                              className={item.disabled ? 'opacity-40 cursor-not-allowed' : ''}
                            >
                              {item.label}
                              {item.badge && (
                                <span className={`ml-1 text-[10px] ${isSelected ? 'text-white/80' : 'text-muted'}`}>
                                  {item.badge}
                                </span>
                              )}
                            </Tag>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {groupedItems.ungrouped.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs px-0.5">
                      <span className="font-bold text-ink">
                        {Object.keys(groupedItems.groups).length > 0 ? '其他' : '全部选项'}{' '}
                        <span className="font-normal text-muted">({groupedItems.ungrouped.length})</span>
                      </span>
                      {multiple && (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleSelectAllGroup(groupedItems.ungrouped)}
                            className="text-[11px] font-semibold text-ink hover:text-ink transition-colors bg-transparent border-0 p-0 cursor-pointer"
                          >
                            全选
                          </button>
                          <span className="text-placeholder text-[10px]">|</span>
                          <button
                            type="button"
                            onClick={() => handleClearGroup(groupedItems.ungrouped)}
                            className="text-[11px] font-semibold text-muted hover:text-red-500 transition-colors bg-transparent border-0 p-0 cursor-pointer"
                          >
                            清除
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {groupedItems.ungrouped.map((item) => {
                        const isSelected = selectedIds.includes(item.id);
                        return (
                          <Tag
                            key={item.id}
                            interactive
                            selected={isSelected}
                            onClick={() => !item.disabled && handleToggle(item.id)}
                            className={item.disabled ? 'opacity-40 cursor-not-allowed' : ''}
                          >
                            {item.label}
                            {item.badge && (
                              <span className={`ml-1 text-[10px] ${isSelected ? 'text-white/80' : 'text-muted'}`}>
                                {item.badge}
                              </span>
                            )}
                          </Tag>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
    </>
  );

  return (
    <div className={`relative inline-block ${showTagsBelow || title && showTitle ? 'w-full space-y-2' : ''} ${className}`}>
      {/* 头部触发按钮行 */}
      <div className={`flex items-center ${title && showTitle ? 'justify-between' : 'justify-start'}`}>
        {title && showTitle ? <span className="text-xs font-bold text-ink">{title}</span> : null}
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          onClick={() => !disabled && setIsOpen(!isOpen)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all duration-150 cursor-pointer select-none ${btnStyle} ${
            disabled ? 'opacity-50 cursor-not-allowed' : ''
          }`}
        >
          <span>{buttonText || title || '选择项目'}</span>
          {selectedIds.length > 0 && (
            <span className="inline-flex items-center justify-center px-1.5 py-0.2 rounded-full text-[10px] bg-white/30 text-current font-bold">
              {selectedIds.length}
            </span>
          )}
          <CaretDown
            size={12}
            weight="bold"
            className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {/* 下方选中的标签平铺流 */}
      {showTagsBelow && (
        <div className="flex flex-wrap gap-1.5 min-h-[28px] pt-0.5">
          {selectedIds.length === 0 ? (
            <span className="text-[11px] text-muted">{emptyText}</span>
          ) : (
            selectedIds.map((id) => {
              const item = items.find((x) => x.id === id);
              return (
                <Tag
                  key={id}
                  onRemove={disabled ? undefined : () => onChange(selectedIds.filter((x) => x !== id))}
                >
                  {item?.label || id}
                </Tag>
              );
            })
          )}
        </div>
      )}

      <FloatingPortal
          open={isOpen}
          anchorRef={triggerRef}
          onDismiss={() => setIsOpen(false)}
          width={380}
          align={align === 'right' ? 'end' : 'start'}
          ariaLabel={title}
          className="p-4 overflow-y-auto bg-paper rounded-2xl border border-line shadow-2xl shadow-black/10 select-none animation-fade-in"
      >{panel}</FloatingPortal>
    </div>
  );
};
