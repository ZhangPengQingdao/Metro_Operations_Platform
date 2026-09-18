import React, { useState, useRef, useEffect } from "react";
import {
  MagnifyingGlass,
  Funnel,
  List,
  CaretDown,
  CaretRight,
  X,
  ArrowsClockwise
} from "@phosphor-icons/react";
import { Button, IconButton } from "./Button";
import { Tag } from "./Tag";
import { DatePicker } from "./DatePicker";

export interface FilterOption {
  id: string;
  label: string;
}

export interface FilterGroup {
  id: string;
  title: string;
  options: FilterOption[];
  isMulti?: boolean;
  allowAll?: boolean;
}

export interface FilterState {
  startDate?: string;
  endDate?: string;
  selectedOptions: Record<string, string[]>; // groupId -> selected optionIds
}

export interface ActionMenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
  highlight?: boolean;
}

export interface FilterBarProps {
  layout?: "compact" | "spread";
  // Search props
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;

  showDateRange?: boolean;

  // Filter props
  filterGroups?: FilterGroup[];
  activeFilters?: FilterState;
  onApplyFilters?: (filters: FilterState) => void;
  onResetFilters?: () => void;

  // More actions props
  moreActions?: ActionMenuItem[];

  // Custom action on the right side (optional)
  rightAction?: React.ReactNode;

  // Active tags bar (default false)
  showActiveTags?: boolean;
  onRemoveTag?: (groupId: string, optionId: string) => void;

  className?: string;
}

const emptyFilters: FilterState = { selectedOptions: {} };

export const FilterBar: React.FC<FilterBarProps> = ({
  layout = "compact",
  searchValue = "",
  onSearchChange,
  searchPlaceholder = "搜索关键词...",
  filterGroups = [],
  showDateRange = true,
  activeFilters = emptyFilters,
  onApplyFilters,
  onResetFilters,
  moreActions = [],
  rightAction,
  showActiveTags = false,
  onRemoveTag,
  className = ""
}) => {
  const [isSearchOpen, setIsSearchOpen] = useState(layout === "spread" || Boolean(searchValue));
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const [localSearch, setLocalSearch] = useState(searchValue);
  const [tempFilters, setTempFilters] = useState<FilterState>(activeFilters);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const filterPopoverRef = useRef<HTMLDivElement>(null);
  const menuPopoverRef = useRef<HTMLDivElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // Sync prop changes
  useEffect(() => {
    setLocalSearch(searchValue);
  }, [searchValue]);

  useEffect(() => {
    setTempFilters(activeFilters);
  }, [activeFilters]);

  // Auto focus on search expand
  useEffect(() => {
    if (layout !== "spread" && isSearchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isSearchOpen]);

  // Click outside listener for filter and menu popovers
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        isFilterOpen &&
        filterPopoverRef.current &&
        !filterPopoverRef.current.contains(event.target as Node) &&
        filterButtonRef.current &&
        !filterButtonRef.current.contains(event.target as Node)
      ) {
        setIsFilterOpen(false);
      }
      if (
        isMenuOpen &&
        menuPopoverRef.current &&
        !menuPopoverRef.current.contains(event.target as Node) &&
        menuButtonRef.current &&
        !menuButtonRef.current.contains(event.target as Node)
      ) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isFilterOpen, isMenuOpen]);

  // Count active filter conditions
  const activeCount = React.useMemo(() => {
    let count = 0;
    if (activeFilters.startDate || activeFilters.endDate) count++;
    Object.values(activeFilters.selectedOptions || {}).forEach((opts) => {
      count += (opts || []).length;
    });
    return count;
  }, [activeFilters]);

  const handleSearchSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    onSearchChange?.(localSearch);
  };

  const handleClearSearch = (e: React.MouseEvent) => {
    e.stopPropagation();
    setLocalSearch("");
    onSearchChange?.("");
    searchInputRef.current?.focus();
  };

  const handleCollapseSearch = () => {
    setIsSearchOpen(false);
    if (localSearch) {
      setLocalSearch("");
      onSearchChange?.("");
    }
  };

  const handleToggleOption = (groupId: string, optionId: string, isMulti = true, allowAll = true) => {
    setTempFilters((prev) => {
      const currentGroup = prev.selectedOptions[groupId] || [];
      let nextGroup: string[];

      if (optionId === "all") {
        nextGroup = [];
      } else if (isMulti) {
        if (currentGroup.includes(optionId)) {
          nextGroup = currentGroup.filter((id) => id !== optionId);
        } else {
          nextGroup = [...currentGroup, optionId];
        }
      } else {
        nextGroup = currentGroup.includes(optionId) && allowAll ? [] : [optionId];
      }

      return {
        ...prev,
        selectedOptions: {
          ...prev.selectedOptions,
          [groupId]: nextGroup
        }
      };
    });
  };

  const handleApply = () => {
    onApplyFilters?.(tempFilters);
    setIsFilterOpen(false);
  };

  const handleReset = () => {
    const empty: FilterState = { startDate: "", endDate: "", selectedOptions: {} };
    setTempFilters(empty);
    onResetFilters?.();
    setIsFilterOpen(false);
  };

  // Collect active tag list for display (if showActiveTags is true)
  const activeTagsList = React.useMemo(() => {
    if (!showActiveTags) return [];
    const tags: Array<{ groupId: string; groupTitle: string; optionId: string; label: string }> = [];
    filterGroups.forEach((group) => {
      const selected = activeFilters.selectedOptions[group.id] || [];
      selected.forEach((optId) => {
        const found = group.options.find((o) => o.id === optId);
        if (found) {
          tags.push({
            groupId: group.id,
            groupTitle: group.title,
            optionId: optId,
            label: `${group.title}: ${found.label}`
          });
        }
      });
    });
    return tags;
  }, [filterGroups, activeFilters, showActiveTags]);

  return (
    <div className={`afc-filter-bar-wrapper inline-flex flex-col ${layout === "spread" ? "afc-filter-bar-wrapper--spread" : ""} ${className}`}>
      {/* 1. Main Toolbar Row */}
      <div className="afc-filter-bar flex items-center justify-end gap-2 relative">
        {/* SEARCH EXPANDABLE ANIMATED COMPONENT */}
        <div className="afc-filter-search-anim-wrap flex items-center gap-1.5">
          {isSearchOpen && layout !== "spread" && (
            <button
              type="button"
              className="afc-filter-icon-btn afc-filter-collapse-btn text-[var(--afc-color-muted)] hover:text-[var(--afc-color-primary-hover)]"
              title="收起搜索"
              aria-label="收起搜索"
              onClick={handleCollapseSearch}
            >
              <CaretRight size={17} weight="bold" />
            </button>
          )}

          <div
            className={`afc-filter-search-morph ${isSearchOpen ? "is-expanded" : "is-collapsed"}`}
            onClick={() => {
              if (!isSearchOpen) setIsSearchOpen(true);
            }}
          >
            <form onSubmit={handleSearchSubmit} className="w-full flex items-center h-full m-0 p-0">
              <div className="afc-filter-search-capsule">
                <button
                  type="button"
                  className="afc-filter-search-icon-btn"
                  title={isSearchOpen ? "搜索" : "展开搜索"}
                  aria-label={isSearchOpen ? "搜索" : "展开搜索"}
                  onClick={(e) => {
                    if (!isSearchOpen) {
                      e.stopPropagation();
                      setIsSearchOpen(true);
                    } else {
                      handleSearchSubmit();
                    }
                  }}
                >
                  <MagnifyingGlass size={17} />
                </button>

                <input
                  ref={searchInputRef}
                  type="text"
                  value={localSearch}
                  onChange={(e) => {
                    setLocalSearch(e.target.value);
                    onSearchChange?.(e.target.value);
                  }}
                  placeholder={searchPlaceholder}
                  className="afc-filter-search-input"
                  style={{ outline: "none", border: "none", boxShadow: "none" }}
                  tabIndex={isSearchOpen ? 0 : -1}
                />

                {isSearchOpen && localSearch && (
                  <button
                    type="button"
                    onClick={handleClearSearch}
                    className="afc-filter-clear-btn"
                    title="清除"
                    aria-label="清除"
                  >
                    <X size={13} weight="bold" />
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>

        {/* FILTER BUTTON & POPOVER */}
        {(showDateRange || filterGroups.length > 0) && <div className="relative">
          <button
            ref={filterButtonRef}
            type="button"
            className={`afc-filter-icon-btn ${isFilterOpen || activeCount > 0 ? "is-active" : ""}`}
            title="筛选条件"
            aria-label="筛选条件"
            onClick={() => setIsFilterOpen((v) => !v)}
          >
            <Funnel size={18} weight={activeCount > 0 ? "fill" : "regular"} />
            {activeCount > 0 && (
              <span className="afc-filter-badge-count">{activeCount}</span>
            )}
          </button>

          {/* Filter Floating Card */}
          {isFilterOpen && (
            <div
              ref={filterPopoverRef}
              className="afc-filter-popover"
              role="dialog"
              aria-label="添加筛选条件"
            >
              <div className="flex items-center justify-between pb-3 mb-3">
                <h3 className="font-bold text-[var(--afc-color-ink)] text-sm md:text-base">添加筛选条件</h3>
                <IconButton
                  label="关闭筛选条件"
                  size="sm"
                  variant="ghost"
                  onClick={() => setIsFilterOpen(false)}
                  className="text-[var(--afc-color-muted)] hover:text-[var(--afc-color-ink)] p-1 rounded-full hover:bg-[var(--afc-color-neutral-soft)]"
                >
                  <X size={16} />
                </IconButton>
              </div>

              <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
                {/* Time Range Section */}
                {showDateRange && <div>
                  <div className="text-xs font-bold text-[var(--afc-color-muted)] mb-2">按时间范围</div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <DatePicker
                        size="sm"
                        value={tempFilters.startDate || ""}
                        onChange={(val) =>
                          setTempFilters((prev) => ({ ...prev, startDate: val }))
                        }
                        placeholder="开始日期"
                        clearable
                      />
                    </div>
                    <span className="text-[var(--afc-color-muted)] text-xs">-</span>
                    <div className="flex-1">
                      <DatePicker
                        size="sm"
                        value={tempFilters.endDate || ""}
                        onChange={(val) =>
                          setTempFilters((prev) => ({ ...prev, endDate: val }))
                        }
                        placeholder="结束日期"
                        clearable
                      />
                    </div>
                  </div>
                </div>}

                {/* Filter Groups */}
                {filterGroups.map((group) => {
                  const selected = tempFilters.selectedOptions[group.id] || [];
                  const isAll = selected.length === 0;

                  return (
                    <div key={group.id} className="pt-2">
                      <div className="text-xs font-bold text-[var(--afc-color-muted)] mb-2">{group.title}</div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                        {/* "全部" Option */}
                        {group.allowAll !== false && <label className="flex items-center gap-2 text-xs text-[var(--afc-color-ink)] cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={isAll}
                            onChange={() => handleToggleOption(group.id, "all")}
                            className="afc-checkbox__control"
                          />
                          <span>全部</span>
                        </label>}

                        {/* Group Options */}
                        {group.options.map((opt) => {
                          const checked = selected.includes(opt.id);
                          return (
                            <label
                              key={opt.id}
                              className="flex items-center gap-2 text-xs text-[var(--afc-color-ink)] cursor-pointer select-none"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => handleToggleOption(group.id, opt.id, group.isMulti ?? true, group.allowAll ?? true)}
                                className="afc-checkbox__control"
                              />
                              <span>{opt.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Footer Controls */}
              <div className="flex items-center justify-between pt-4 mt-4">
                <button
                  type="button"
                  onClick={handleReset}
                  className="flex items-center gap-1 text-xs text-[var(--afc-color-muted)] hover:text-[var(--afc-color-ink)] font-medium py-1.5 px-2 rounded-full hover:bg-[var(--afc-color-neutral-soft)] transition-colors"
                >
                  <ArrowsClockwise size={14} />
                  <span>重置</span>
                </button>

                <div className="flex items-center gap-2">
                  <Button
                    variant="soft"
                    size="sm"
                    onClick={() => setIsFilterOpen(false)}
                  >
                    取消
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleApply}
                  >
                    确定
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>}

        {/* MORE ACTIONS DROPDOWN */}
        {moreActions.length > 0 && (
          <div className="relative">
            <button
              ref={menuButtonRef}
              type="button"
              className={`afc-filter-pill-btn ${isMenuOpen ? "is-active" : ""}`}
              title="更多功能"
              aria-label="更多功能"
              onClick={() => setIsMenuOpen((v) => !v)}
            >
              <List size={18} />
              <CaretDown size={12} weight="bold" />
            </button>

            {isMenuOpen && (
              <div
                ref={menuPopoverRef}
                className="afc-filter-menu-popover"
                role="menu"
              >
                {moreActions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    className={`afc-filter-menu-item ${action.danger ? "is-danger" : ""} ${action.highlight ? "is-highlight" : ""}`}
                    role="menuitem"
                    onClick={() => {
                      setIsMenuOpen(false);
                      action.onClick?.();
                    }}
                  >
                    {action.icon && <span className="text-base">{action.icon}</span>}
                    <span className={action.highlight ? "font-bold text-[var(--afc-color-primary-hover)]" : ""}>{action.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Optional Right Action */}
        {rightAction && <div className="afc-filter-right-action flex items-center gap-2">{rightAction}</div>}
      </div>

      {/* 2. Optional Active Tags (Default Hidden) */}
      {showActiveTags && activeTagsList.length > 0 && (
        <div className="flex items-center justify-end gap-2 flex-wrap pt-2 animate-fadeIn">
          <span className="text-xs text-[var(--afc-color-muted)] font-medium">已选筛选:</span>
          {activeTagsList.map((tag) => (
            <Tag
              key={`${tag.groupId}-${tag.optionId}`}
              onRemove={() => onRemoveTag?.(tag.groupId, tag.optionId)}
            >
              {tag.label}
            </Tag>
          ))}
          <button
            type="button"
            onClick={handleReset}
            className="text-xs text-[var(--afc-color-primary)] hover:text-[var(--afc-color-primary-hover)] font-medium hover:underline ml-1"
          >
            清空
          </button>
        </div>
      )}
    </div>
  );
};
