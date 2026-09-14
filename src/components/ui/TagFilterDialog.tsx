import React, { useMemo, useState } from 'react';
import { Dialog } from './Dialog';
import { Tag } from './Tag';

export interface TagFilterItem {
  id: string;
  label: string;
  group?: string;
  badge?: string | number;
  disabled?: boolean;
}

export interface TagFilterDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  icon?: React.ReactNode;
  items: TagFilterItem[];
  selectedIds: string[];
  onChange: (selectedIds: string[]) => void;
  multiple?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export const TagFilterDialog: React.FC<TagFilterDialogProps> = ({
  open,
  onClose,
  title,
  description,
  icon,
  items,
  selectedIds,
  onChange,
  multiple = true,
  size = 'md',
  className = ''
}) => {
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

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      icon={icon}
      size={size}
      className={`afc-tag-filter-dialog ${className}`.trim()}
    >
      <div className="pt-1 pb-3">
        {/* 标签列表区 */}
        <div className="max-h-[420px] overflow-y-auto pr-1 space-y-4">
          {items.length === 0 ? (
            <div className="text-center py-8 text-xs text-gray-400">
              暂无可选项目
            </div>
          ) : (
            <>
              {/* 分组展示 */}
              {Object.entries(groupedItems.groups).map(([groupName, groupList]) => {
                const groupItemIds = groupList.map((x) => x.id);
                const selectedInGroupCount = groupItemIds.filter((id) => selectedIds.includes(id)).length;
                const isAllSelected = groupList.length > 0 && selectedInGroupCount === groupList.length;

                return (
                  <div key={groupName} className="space-y-2">
                    {/* 分组标题与 全选 / 清除 动作 */}
                    <div className="flex items-center justify-between text-xs px-0.5">
                      <span className="font-bold text-gray-700 tracking-wide">
                        {groupName}{' '}
                        <span className="font-normal text-gray-400">
                          ({selectedInGroupCount > 0 ? `${selectedInGroupCount}/` : ''}{groupList.length})
                        </span>
                      </span>
                      {multiple && (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleSelectAllGroup(groupList)}
                            className={`text-[11px] font-semibold transition-colors bg-transparent border-0 p-0 cursor-pointer ${
                              isAllSelected ? 'text-gray-400 hover:text-gray-600' : 'text-emerald-600 hover:text-emerald-800'
                            }`}
                          >
                            全选
                          </button>
                          <span className="text-gray-300 text-[10px]">|</span>
                          <button
                            type="button"
                            onClick={() => handleClearGroup(groupList)}
                            className="text-[11px] font-semibold text-gray-400 hover:text-red-500 transition-colors bg-transparent border-0 p-0 cursor-pointer"
                          >
                            清除
                          </button>
                        </div>
                      )}
                    </div>

                    {/* 标签网格 */}
                    <div className="flex flex-wrap gap-2">
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
                              <span className={`ml-1 text-[10px] ${isSelected ? 'text-white/80' : 'text-gray-400'}`}>
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

              {/* 无分组展示 */}
              {groupedItems.ungrouped.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs px-0.5">
                    <span className="font-bold text-gray-700 tracking-wide">
                      {Object.keys(groupedItems.groups).length > 0 ? '其他' : '全部选项'}{' '}
                      <span className="font-normal text-gray-400">({groupedItems.ungrouped.length})</span>
                    </span>
                    {multiple && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleSelectAllGroup(groupedItems.ungrouped)}
                          className="text-[11px] font-semibold text-emerald-600 hover:text-emerald-800 transition-colors bg-transparent border-0 p-0 cursor-pointer"
                        >
                          全选
                        </button>
                        <span className="text-gray-300 text-[10px]">|</span>
                        <button
                          type="button"
                          onClick={() => handleClearGroup(groupedItems.ungrouped)}
                          className="text-[11px] font-semibold text-gray-400 hover:text-red-500 transition-colors bg-transparent border-0 p-0 cursor-pointer"
                        >
                          清除
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
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
                            <span className={`ml-1 text-[10px] ${isSelected ? 'text-white/80' : 'text-gray-400'}`}>
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
      </div>
    </Dialog>
  );
};

export interface TagPickerProps {
  items: TagFilterItem[];
  selectedIds: string[];
  onChange: (selectedIds: string[]) => void;
  title?: string;
  buttonText?: string;
  buttonVariant?: 'primary' | 'secondary' | 'soft' | 'ghost' | 'outline';
  emptyText?: string;
  disabled?: boolean;
  multiple?: boolean;
  className?: string;
}

export const TagPicker: React.FC<TagPickerProps> = ({
  items,
  selectedIds,
  onChange,
  title = '选择标签',
  buttonText = '选择',
  buttonVariant = 'primary',
  emptyText = '未选择项目',
  disabled = false,
  multiple = true,
  className = ''
}) => {
  const [open, setOpen] = useState(false);

  return (
    <div className={`space-y-2 ${className}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-gray-700">{title}</span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          className={`px-3 py-1 text-xs font-semibold rounded-full transition-all cursor-pointer ${
            buttonVariant === 'secondary'
              ? 'bg-[#edf4f0] text-gray-700 hover:bg-[#e2ece6]'
              : 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm'
          }`}
        >
          {buttonText}
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5 pt-0.5">
        {selectedIds.length === 0 ? (
          <span className="text-[11px] text-gray-400">{emptyText}</span>
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
      <TagFilterDialog
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        items={items}
        selectedIds={selectedIds}
        onChange={onChange}
        multiple={multiple}
      />
    </div>
  );
};
