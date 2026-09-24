import {initialModuleValues,lineItems} from './modules.mjs';
import {Settings} from './settings.jsx';
import React,{useState,useEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {
  Button,Input,Select,Field,Dialog,DataList,FilterBar,DatePicker,TimePicker,
  TagDropdownPicker,HandwrittenSignaturePad,TableHeader,TableBody,
  TableRow,TableHead,TableCell,ListPagination,Trash,Plus,PencilSimpleLine
} from '@metro/platform-sdk/ui';
import {platformUiCss} from '@metro/platform-sdk/ui-styles';
import {createAppSandboxClient,createAppApiClient} from '@metro/platform-sdk/app-sandbox';

const script = document.currentScript;
const initialRoute = decodeURIComponent(script?.dataset.appRoute ?? '/');
const origin = script?.dataset.platformOrigin;
if (!origin) throw Error('PLATFORM_ORIGIN_REQUIRED');

const sandbox = createAppSandboxClient({
  appId: 'shifts',
  timeoutMs: 30_000,
  platformOrigin: origin,
  port: {
    parent: window.parent,
    send: (data, target) => window.parent.postMessage(data, target),
    listen: fn => {
      window.addEventListener('message', fn);
      return () => window.removeEventListener('message', fn);
    }
  }
});
const api = createAppApiClient(sandbox);
const membersCache = new Map();

document.documentElement.classList.add('afc-theme-neutral');

// Inject refined enterprise styling with pure neutral black/white/gray system
const style = document.createElement('style');
style.nonce = script?.nonce ?? '';
style.textContent = platformUiCss + `
body {
  margin: 0;
  background: var(--afc-color-canvas, #fafafa);
  color: var(--afc-color-ink, #18181b);
  font-family: var(--afc-font-ui, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
  -webkit-font-smoothing: antialiased;
}
* { box-sizing: border-box; }

.shifts {
  padding: 24px 20px 96px;
  max-width: 1040px;
  margin: 0 auto;
}

/* Page Header Banner */
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 22px;
  padding-bottom: 16px;
  border-bottom: 1px solid #e4e4e7;
}
.page-title-wrap {
  display: flex;
  align-items: center;
  gap: 12px;
}
.page-title-icon {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: #f4f4f5;
  color: #18181b;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #e4e4e7;
}
.page-title-text h1 {
  font-size: 20px;
  font-weight: 700;
  color: #18181b;
  margin: 0;
  line-height: 1.3;
  letter-spacing: -0.01em;
}
.page-title-text p {
  font-size: 12px;
  color: #71717a;
  margin: 2px 0 0;
}
.page-header-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 9999px;
  font-size: 12px;
  font-weight: 500;
  background: #f4f4f5;
  color: #3f3f46;
  border: 1px solid #e4e4e7;
}

/* Notice Alerts */
.notice-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-radius: 10px;
  margin-bottom: 18px;
  font-size: 13px;
  line-height: 1.4;
}
.notice-banner.success {
  background: #f4f4f5;
  border: 1px solid #d4d4d8;
  color: #18181b;
}
.notice-banner.error {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #991b1b;
}

/* Info Cards & Section Cards */
.info-card {
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 12px;
  padding: 18px 20px;
  margin-bottom: 16px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.02);
}
.info-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  font-size: 14px;
  font-weight: 600;
  color: #18181b;
}
.info-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}
@media (max-width: 768px) {
  .info-grid { grid-template-columns: 1fr; }
}

/* Shift Type Segmented Control (Pill) */
.shift-segmented {
  display: flex;
  gap: 4px;
  padding: 3px;
  background: #f4f4f5;
  border: 1px solid #e4e4e7;
  border-radius: 9999px;
  width: 100%;
}
.shift-segmented-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  border-radius: 9999px;
  border: none;
  background: transparent;
  color: #71717a;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  user-select: none;
}
.shift-segmented-btn:hover:not(.is-active) {
  color: #18181b;
}
.shift-segmented-btn.is-active {
  background: #ffffff;
  color: #18181b;
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0,0,0,0.06);
}

/* Person Picker Bar (Clean Reference Style) */
.person-picker-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  padding: 8px 14px;
  background: #fafafa;
  border: 1px solid #e4e4e7;
  border-radius: 12px;
  transition: all 0.15s ease;
}
.person-picker-bar:hover {
  border-color: #d4d4d8;
  background: #ffffff;
}
.person-picker-bar:focus-within {
  border-color: #18181b;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}
.person-picker-bar-left {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  min-width: 0;
  flex: 1;
}
.person-picker-label {
  font-size: 13px;
  font-weight: 600;
  color: #18181b;
  flex-shrink: 0;
}
.person-picker-empty {
  font-size: 13px;
  color: #a1a1aa;
}
.person-chips-flow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.person-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 9999px;
  font-size: 12px;
  color: #18181b;
  box-shadow: 0 1px 2px rgba(0,0,0,0.02);
  transition: all 0.15s ease;
}
.person-chip:hover {
  border-color: #18181b;
}
.person-chip-name {
  font-weight: 500;
}
.person-chip-no {
  font-size: 10px;
  color: #71717a;
  background: #f4f4f5;
  padding: 0 4px;
  border-radius: 4px;
}
.person-chip-del {
  border: none;
  background: transparent;
  color: #a1a1aa;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s ease;
}
.person-chip-del:hover {
  color: #ef4444;
}
.person-picker-bar-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.btn-quick-text {
  background: transparent;
  border: none;
  color: #71717a;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
  transition: all 0.15s ease;
}
.btn-quick-text:hover {
  background: #f4f4f5;
  color: #18181b;
}

/* Module Card Container */
.module-card {
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 12px;
  margin-bottom: 16px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.02);
  overflow: hidden;
  transition: border-color 0.15s ease;
}
.module-card:hover {
  border-color: #d4d4d8;
}
.module-card-head {
  display: flex;
  align-items: center;
  padding: 13px 18px;
  background: #ffffff;
  border-bottom: 1px solid #f4f4f5;
  gap: 12px;
}
.module-icon-wrap {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: #f4f4f5;
  color: #18181b;
  border: 1px solid #e4e4e7;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.module-head-info {
  flex: 1;
  min-width: 0;
}
.module-head-title {
  font-size: 14px;
  font-weight: 600;
  color: #18181b;
  line-height: 1.3;
}
.module-head-desc {
  font-size: 12px;
  color: #71717a;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.module-head-tag {
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 500;
  background: #f4f4f5;
  color: #52525b;
  border: 1px solid #e4e4e7;
  white-space: nowrap;
}
.module-card-body {
  padding: 16px 18px;
}

/* List Items Module (Clauses / Points) */
.list-items-container {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.list-item-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 12px;
  background: #fafafa;
  border: 1px solid #f4f4f5;
  border-radius: 9px;
  transition: all 0.15s ease;
}
.list-item-row:focus-within {
  background: #ffffff;
  border-color: #d4d4d8;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}
.list-item-index {
  width: 22px;
  height: 22px;
  margin-top: 6px;
  border-radius: 9999px;
  background: #f4f4f5;
  color: #3f3f46;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 1px solid #e4e4e7;
}
.list-item-fields {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}
.list-item-fields.has-remarks {
  grid-template-columns: minmax(0, 1fr) minmax(180px, 0.45fr);
}
@media (max-width: 640px) {
  .list-item-fields.has-remarks { grid-template-columns: 1fr; }
}
.list-item-delete {
  width: 32px;
  height: 32px;
  margin-top: 2px;
  border-radius: 9999px;
  border: none;
  background: transparent;
  color: #a1a1aa;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s ease;
}
.list-item-delete:hover {
  background: #fee2e2;
  color: #ef4444;
}

/* Capsule Add Button (Dashed Pill Button) */
.capsule-add-wrap {
  display: flex;
  justify-content: center;
  padding-top: 6px;
}
.btn-capsule-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 18px;
  border-radius: 9999px;
  border: 1px dashed #d4d4d8;
  background: #ffffff;
  color: #52525b;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  user-select: none;
}
.btn-capsule-add:hover {
  border-color: #18181b;
  color: #18181b;
  background: #f4f4f5;
}

/* Quiz Module (Compact Horizontal Row) */
.quiz-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.quiz-item-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: #fafafa;
  border: 1px solid #f4f4f5;
  border-radius: 9px;
  transition: all 0.15s ease;
}
.quiz-item-row:focus-within {
  background: #ffffff;
  border-color: #d4d4d8;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}
.quiz-item-index {
  width: 22px;
  height: 22px;
  border-radius: 9999px;
  background: #f4f4f5;
  color: #3f3f46;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 1px solid #e4e4e7;
}
.quiz-item-person {
  width: 170px;
  flex-shrink: 0;
}
.quiz-item-status {
  width: 130px;
  flex-shrink: 0;
}
.quiz-item-content {
  flex: 1;
  min-width: 0;
}
@media (max-width: 720px) {
  .quiz-item-row {
    flex-wrap: wrap;
    align-items: flex-start;
  }
  .quiz-item-person {
    width: calc(50% - 26px);
  }
  .quiz-item-status {
    width: calc(50% - 26px);
  }
  .quiz-item-content {
    width: 100%;
    order: 4;
  }
}

/* Safety Precaution Module */
.safety-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.safety-item {
  border: 1px solid #e4e4e7;
  border-radius: 10px;
  padding: 12px 14px;
  background: #fafafa;
  transition: all 0.15s ease;
}
.safety-item.is-checked {
  background: #ffffff;
  border-color: #18181b;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}
.safety-item-header {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  color: #18181b;
}
.safety-item-header input[type="checkbox"] {
  width: 17px;
  height: 17px;
  border-radius: 4px;
  accent-color: #18181b;
  cursor: pointer;
}
.safety-item-sub {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed #e4e4e7;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(200px, 0.45fr);
  gap: 10px;
}
@media (max-width: 640px) {
  .safety-item-sub { grid-template-columns: 1fr; }
}

/* Checklist Module */
.checklist-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 10px;
}
.checklist-pill {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-radius: 9999px;
  border: 1px solid #e4e4e7;
  background: #fafafa;
  font-size: 13px;
  font-weight: 500;
  color: #3f3f46;
  cursor: pointer;
  transition: all 0.15s ease;
  user-select: none;
}
.checklist-pill:hover {
  border-color: #d4d4d8;
  background: #f4f4f5;
}
.checklist-pill.is-checked {
  background: #18181b;
  border-color: #18181b;
  color: #ffffff;
}
.checklist-pill input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: #18181b;
  cursor: pointer;
}

/* Bottom Actions Bar */
.bottom-bar {
  position: sticky;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 14px 20px;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(8px);
  border: 1px solid #e4e4e7;
  border-radius: 12px;
  box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.03);
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 24px;
  z-index: 20;
  gap: 16px;
  flex-wrap: wrap;
}
.bottom-bar-feedback {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  flex: 1 1 240px;
}
.bottom-bar-status {
  font-size: 12px;
  line-height: 1.4;
  color: #52525b;
}
.bottom-bar-status.error { color: #991b1b; }
.bottom-bar-status.success { color: #166534; }
.bottom-bar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* Records List & Tags */
.shift-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 500;
}
.shift-tag.day {
  background: #f4f4f5;
  color: #18181b;
  border: 1px solid #e4e4e7;
}
.shift-tag.night {
  background: #18181b;
  color: #ffffff;
  border: 1px solid #18181b;
}
.record-snapshot-block {
  background: #fafafa;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  color: #3f3f46;
  margin-top: 6px;
}

/* Handwritten Signature Section */
.signature-box {
  border: 1px dashed #d4d4d8;
  border-radius: 10px;
  padding: 14px;
  background: #fafafa;
  text-align: center;
  margin-top: 10px;
}
.signature-img {
  max-width: 100%;
  max-height: 100px;
  object-fit: contain;
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 6px;
  padding: 6px;
}
`;
document.head.append(style);

// Module metadata dictionary: unified neutral icons, descriptions, and tags
const MODULE_METAS = {
  shift_info: { desc: '日期、时间与交接时段', tag: '基础', icon: 'clock' },
  staff_selector: { desc: '交班人与接班人员', tag: '关键', icon: 'users' },
  meeting_info: { desc: '晨会时间与主持人', tag: '必选', icon: 'clock' },
  meeting_participants: { desc: '主持人与参会人员', tag: '人员', icon: 'users' },
  study_content: { desc: '业务学习文件与要点传达', tag: '学习', icon: 'book' },
  ideology_minute: { desc: '班组思政与微分享交流', tag: '分享', icon: 'sparkle' },
  key_work_items: { desc: '重点任务与配合要求', tag: '重点', icon: 'list' },
  safety_prediction: { desc: '现场风险辨识与预想确认', tag: '安全', icon: 'shield' },
  quiz_record: { desc: '现场抽问与业务掌握情况', tag: '抽问', icon: 'chat' },
  checklist: { desc: '人员与工装状态点验', tag: '点验', icon: 'check' },
  post_shift_checklist: { desc: '交班前设备与现场状态', tag: '确认', icon: 'check' },
  todo_record: { desc: '需要后续跟进的事项', tag: '待办', icon: 'list' },
  fault_record: { desc: '当班新增设备故障', tag: '异常', icon: 'shield' },
  tool_check: { desc: '工器具状态点验', tag: '点验', icon: 'check' },
  other_matters: { desc: '补充交办与持续跟踪', tag: '选填', icon: 'note' }
};

function getModuleMeta(id, label) {
  if (MODULE_METAS[id]) return MODULE_METAS[id];
  if (id.includes('study')) return { desc: '业务学习与传达', tag: '学习', icon: 'book' };
  if (id.includes('safety') || id.includes('risk')) return { desc: '安全预想与风险防范', tag: '安全', icon: 'shield' };
  if (id.includes('check')) return { desc: '状态点验与核查', tag: '点验', icon: 'check' };
  return { desc: label || '填报事项', tag: '扩展', icon: 'folder' };
}

// Crisp inline SVG Icons in pure neutral style
function AppIcon({ name, size = 18 }) {
  switch (name) {
    case 'calendar':
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>;
    case 'clock':
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>;
    case 'users':
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
    case 'book':
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z"/></svg>;
    case 'sparkle':
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4L12 2z"/></svg>;
    case 'list':
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1.5" fill="currentColor"/><circle cx="4" cy="12" r="1.5" fill="currentColor"/><circle cx="4" cy="18" r="1.5" fill="currentColor"/></svg>;
    case 'shield':
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
    case 'chat':
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>;
    case 'check':
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>;
    case 'note':
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>;
    case 'sun':
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>;
    case 'moon':
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>;
    case 'folder':
    default:
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>;
  }
}

const labels = {
  ACCESS_DENIED: '没有此操作权限',
  INVALID_INPUT: '请检查填写内容',
  INVALID_PERSON: '所选人员已变化，请重新选择',
  FORM_TOO_LARGE: '填写内容过长，请精简',
  CONFLICT: '记录已更新，请重新打开',
  READ_FAILED: '读取失败，请重试；尚未提交任何更改',
  OPERATION_UNCONFIRMED: '操作结果未确认，请先核对记录'
};

async function call(name, payload = {}) {
  let result;
  try {
    result = await api.invoke(name, payload);
  } catch (e) {
    e.unknown = e.writeOutcome === 'unknown';
    throw e;
  }
  if (!result?.ok) {
    const e = Error(labels[result?.error?.code] ?? '操作未完成');
    e.unknown = result?.error?.writeOutcome === 'unknown';
    throw e;
  }
  return result.result;
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const clock = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());

function App() {
  const [route,setRoute] = useState(initialRoute);
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const warming = useRef(new Map());
  const visited = useRef(new Set());
  useEffect(() => sandbox.onRouteChange(setRoute), []);

  function warmOtherForm(kind) {
    visited.current.add(kind);
    if (!session) return;
    const other = kind === 'meeting' ? 'handover' : 'meeting';
    if (visited.current.has(other) || warming.current.has(other)) return;
    const pending = call('bootstrap', { kind: other, organizationId: session.organizationId });
    warming.current.set(other, pending);
    void pending
      .catch(() => {})
      .finally(() => { if (warming.current.get(other) === pending) warming.current.delete(other); });
  }

  useEffect(() => {
    let active = true;
    const started = Date.now();
    const timer = setInterval(async () => {
      if (sandbox.ready()) {
        clearInterval(timer);
        try {
          const s = await call('session');
          if (active) {
            setSession(s);
            const codes = s.grants.map(g => g.permission);
            await sandbox.invoke('platform.ui.navigation', {
              ids: [
                ...(codes.includes('app.shifts.submit') ? ['handover', 'meeting'] : []),
                ...(codes.includes('app.shifts.read') ? ['handover-records', 'meeting-records'] : []),
                ...(codes.includes('app.shifts.config') ? ['settings'] : [])
              ]
            });
          }
        } catch (e) {
          if (active) setError(e.message);
        }
      } else if (Date.now() - started > 10000) {
        clearInterval(timer);
        setError('连接未就绪，请重新打开应用');
      }
    }, 25);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const title = route === '/settings' ? '应用设置' :
                route === '/meeting-records' ? '晨会记录' :
                route === '/handover-records' ? '交接班记录' :
                route === '/meeting' ? '晨会' : '交接班';

  const subtitle = route === '/settings' ? '配置工班功能模块与 Webhook 群机器人消息推送' :
                   route.endsWith('records') ? '查看与审计历史填报台账及本人签署' :
                   route === '/meeting' ? '组织晨会召开、要点传达、安全预想与现场抽问' :
                   '执行班次交接、人员点验与当班运行状态确认';

  const titleIcon = route === '/settings' ? 'folder' :
                    route.endsWith('records') ? 'book' :
                    route === '/meeting' ? 'sparkle' : 'clock';

  const userOrgName = session?.organizations.find(o => o.id === session.organizationId)?.name ?? '运营工班';

  return (
    <main className="shifts">
      <header className="page-header">
        <div className="page-title-wrap">
          <div className="page-title-icon">
            <AppIcon name={titleIcon} size={20} />
          </div>
          <div className="page-title-text">
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
        </div>
        {session && (
          <div className="page-header-badge">
            <AppIcon name="users" size={13} />
            <span>{userOrgName}</span>
          </div>
        )}
      </header>

      {error && <div role="alert" className="notice-banner error">{error}</div>}

      {session ? (
        route === '/settings' ? (
          <Settings call={call} sandbox={sandbox} session={session} />
        ) : route.endsWith('records') ? (
          <Records key={route} session={session} kind={route.includes('meeting') ? 'meeting' : 'handover'} />
        ) : (
          <RecordForm key={route} session={session} kind={route === '/meeting' ? 'meeting' : 'handover'}
            preloaded={warming.current.get(route === '/meeting' ? 'meeting' : 'handover')} onBootstrapped={warmOtherForm} />
        )
      ) : !error && (
        <p style={{ color: '#a1a1aa', fontSize: 13 }}>正在连接工班工作台…</p>
      )}
    </main>
  );
}

function RecordForm({ session, kind, initial, onSaved, onBootstrapped, preloaded }) {
  const base = initial ? {
    id: initial.id,
    revision: initial.revision,
    organizationId: initial.organization_id,
    date: initial.record_date,
    time: initial.record_time,
    shiftType: initial.shift_type,
    hostId: initial.host_id ?? '',
    participantIds: initial.people.filter(p => p.role === 'participant').map(p => p.id),
    handoverIds: initial.people.filter(p => p.role === 'handover').map(p => p.id),
    takeoverIds: initial.people.filter(p => p.role === 'takeover').map(p => p.id),
    form: initial.form_data
  } : {
    id: crypto.randomUUID(),
    organizationId: session.organizationId,
    date: today(),
    time: clock(),
    shiftType: Number(clock().slice(0, 2)) < 14 ? 'night' : 'day',
    hostId: session.personId,
    participantIds: [],
    handoverIds: [],
    takeoverIds: [session.personId],
    form: {}
  };

  const [form, setForm] = useState(base);
  const [modules, setModules] = useState(initial?.module_snapshot ?? []);
  const [members, setMembers] = useState(() => membersCache.get(base.organizationId)?.rows ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const requestId = useRef(crypto.randomUUID());
  const draftRevision = useRef(0);

  useEffect(() => {
    let active = true;
    draftRevision.current = 0;
    setReady(false);
    setError('');
    (async () => {
      try {
        const boot = initial ? null : await (loadAttempt === 0 && preloaded ? preloaded : call('bootstrap', { kind, organizationId: form.organizationId }));
        if (!active) return;
        const t = initial ? { modules: initial.module_snapshot } : boot.template;
        setModules(t.modules);
        const prior = boot?.previous ?? null;
        draftRevision.current = boot?.draftRevision ?? 0;
        if (!initial) {
          setForm(f => ({
            ...f,
            ...(prior && kind === 'handover' ? { handoverIds: prior.handoverIds, shiftType: prior.shiftType === 'day' ? 'night' : 'day' } : {}),
            form: {
              ...initialModuleValues(t.modules),
              ...(t.modules.some(m => m.id === 'other_matters' && m.enableCarryOver) ? prior?.form ?? {} : {}),
              ...f.form
            }
          }));
        }
        setReady(true);
        if (!initial) onBootstrapped?.(kind);
      } catch (e) {
        if (active) setError(e.message);
      }
    })();
    return () => { active = false; };
  }, [form.organizationId, loadAttempt]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const cached = membersCache.get(form.organizationId);
        if (cached && Date.now() - cached.at < 30_000) {
          setMembers(cached.rows);
          return;
        }
        const people = await call('members', { organizationId: form.organizationId });
        if (active) {
          membersCache.set(form.organizationId, { rows: people.rows, at: Date.now() });
          setMembers(previous => [
            ...previous.filter(p => [form.hostId, ...form.participantIds, ...form.handoverIds, ...form.takeoverIds].includes(p.id) && !people.rows.some(n => n.id === p.id)),
            ...people.rows
          ]);
        }
      } catch (e) {
        if (active) setError(e.message);
      }
    })();
    return () => { active = false; };
  }, [form.organizationId, loadAttempt]);

  const patch = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    if (busy || uncertain || !ready) return;
    setBusy(true);
    setError('');
    try {
      const result = await call('save', { ...form, modules, kind, requestId: requestId.current });
      setNotice(
        result.notification === 'unconfirmed'
          ? '记录已保存，群机器人推送结果未确认'
          : result.signatureStatus === 'unconfirmed'
          ? '记录已保存，签署关联待核对'
          : '记录已保存成功'
      );
      setUncertain(true);
      onSaved?.(result);
    } catch (e) {
      setError(e.message);
      if (e.unknown) setUncertain(true);
    } finally {
      setBusy(false);
    }
  }

  async function stash() {
    setBusy(true);
    try {
      const d = await call('save-draft', { organizationId: form.organizationId, kind, value: form, revision: draftRevision.current, requestId: crypto.randomUUID() });
      draftRevision.current = d.revision;
      setNotice('草稿已成功暂存');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    try {
      const d = await call('load-draft', { organizationId: form.organizationId, kind });
      draftRevision.current = d.revision;
      if (d.draft) {
        setForm({ ...d.draft, id: crypto.randomUUID(), organizationId: session.organizationId });
        setNotice('已恢复上次保存的草稿');
      } else {
        setNotice('暂无已保存草稿');
      }
    } catch (e) {
      setError(e.message);
    }
  }

  const saved = notice.startsWith('记录已保存');
  let saveStatus = error || notice;
  if (!ready) saveStatus = error ? `表单加载失败：${error}` : '正在加载表单，完成后可保存';
  else if (busy) saveStatus = '正在保存，请稍候…';
  else if (uncertain && !saved) saveStatus = '保存结果未确认，请先核对记录，避免重复提交';
  let saveLabel = kind === 'meeting' ? '保存晨会记录' : '确认交接并保存';
  if (!ready) saveLabel = error ? '加载失败' : '正在加载…';
  else if (busy) saveLabel = '保存中…';
  else if (uncertain) saveLabel = saved ? '已保存' : '请先核对记录';

  return (
    <div className="shifts-form">
      {!ready && <div className="notice-banner" role="status">{error ? <>表单尚未加载完整。<Button type="button" onClick={() => setLoadAttempt(n => n + 1)}>重新加载</Button></> : '正在加载表单模块和上一班记录…'}</div>}
      {error && <div className="notice-banner error" role="alert">{error}</div>}
      {notice && <div className="notice-banner success" role="status">{notice}</div>}

      {/* Basic Info (Date & Time) Section */}
      <section className="module-card">
        <div className="module-card-head">
          <div className="module-icon-wrap">
            <AppIcon name="calendar" size={16} />
          </div>
          <div className="module-head-info">
            <div className="module-head-title">{kind === 'meeting' ? '晨会信息' : '交接班信息'}</div>
            <div className="module-head-desc">{kind === 'meeting' ? '会议日期与时间' : '交接日期、时间与班次'}</div>
          </div>
          <div className="module-head-tag">必填</div>
        </div>
        <div className="module-card-body">
          <div className="info-grid" style={kind === 'meeting' ? { gridTemplateColumns: '1fr 1fr' } : {}}>
            <Field label={kind === 'meeting' ? '晨会日期' : '交接日期'}>
              <DatePicker value={form.date} clearable={false} onChange={value => patch('date', value)} />
            </Field>
            <Field label={kind === 'meeting' ? '晨会时间' : '交接时间'}>
              <TimePicker value={form.time} minuteStep={1} clearable={false} onChange={value => patch('time', value)} />
            </Field>
            {kind === 'handover' && (
              <Field label="交接班次">
                <div className="shift-segmented">
                  <button
                    type="button"
                    className={`shift-segmented-btn ${form.shiftType === 'day' ? 'is-active' : ''}`}
                    onClick={() => patch('shiftType', 'day')}
                  >
                    <AppIcon name="sun" size={14} />
                    <span>白班</span>
                  </button>
                  <button
                    type="button"
                    className={`shift-segmented-btn ${form.shiftType === 'night' ? 'is-active' : ''}`}
                    onClick={() => patch('shiftType', 'night')}
                  >
                    <AppIcon name="moon" size={14} />
                    <span>夜班</span>
                  </button>
                </div>
              </Field>
            )}
          </div>
        </div>
      </section>

      {/* Personnel Section */}
      <section className="module-card">
        <div className="module-card-head">
          <div className="module-icon-wrap">
            <AppIcon name="users" size={16} />
          </div>
          <div className="module-head-info">
            <div className="module-head-title">{kind === 'meeting' ? '参会信息' : '交接人员'}</div>
            <div className="module-head-desc">{kind === 'meeting' ? '指定主持人与参会人员' : '交班人员与接班人员'}</div>
          </div>
          <div className="module-head-tag">人员</div>
        </div>
        <div className="module-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {kind === 'meeting' ? (
            <>
              {/* 主持人 */}
              <div className="person-picker-bar">
                <div className="person-picker-bar-left">
                  <span className="person-picker-label">主持人</span>
                  {(() => {
                    const host = members.find(p => p.id === form.hostId);
                    return host ? (
                      <span className="person-chip">
                        <span className="person-chip-name">{host.name}</span>
                        {host.employeeNo && <span className="person-chip-no">{host.employeeNo}</span>}
                        <button
                          type="button"
                          className="person-chip-del"
                          title="移除主持人"
                          onClick={() => patch('hostId', '')}
                        >
                          ×
                        </button>
                      </span>
                    ) : (
                      <span className="person-picker-empty">未指定（点击右侧按钮选择）</span>
                    );
                  })()}
                </div>
                <div className="person-picker-bar-right">
                  <TagDropdownPicker
                    buttonText={form.hostId ? '更换主持人' : '指定主持人'}
                    buttonVariant="secondary"
                    showTagsBelow={false}
                    align="right"
                    items={members.map(p => ({ id: p.id, label: p.name, badge: p.employeeNo }))}
                    selectedIds={form.hostId ? [form.hostId] : []}
                    onChange={ids => patch('hostId', ids[0] ?? '')}
                    multiple={false}
                  />
                </div>
              </div>

              {/* 参会人员 */}
              <div className="person-picker-bar">
                <div className="person-picker-bar-left">
                  <span className="person-picker-label">
                    参会人员 {form.participantIds?.length > 0 ? `(${form.participantIds.length})` : ''}
                  </span>
                  {form.participantIds?.length > 0 ? (
                    <div className="person-chips-flow">
                      {form.participantIds.map(id => {
                        const person = members.find(p => p.id === id);
                        if (!person) return null;
                        return (
                          <span className="person-chip" key={id}>
                            <span className="person-chip-name">{person.name}</span>
                            {person.employeeNo && <span className="person-chip-no">{person.employeeNo}</span>}
                            <button
                              type="button"
                              className="person-chip-del"
                              title="移除"
                              onClick={() => patch('participantIds', form.participantIds.filter(pid => pid !== id))}
                            >
                              ×
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="person-picker-empty">暂无参会人员</span>
                  )}
                </div>
                <div className="person-picker-bar-right">
                  <button
                    type="button"
                    className="btn-quick-text"
                    onClick={() => patch('participantIds', members.map(p => p.id))}
                  >
                    全选
                  </button>
                  {form.participantIds?.length > 0 && (
                    <button
                      type="button"
                      className="btn-quick-text"
                      onClick={() => patch('participantIds', [])}
                    >
                      清空
                    </button>
                  )}
                  <TagDropdownPicker
                    buttonText="选择参会人"
                    buttonVariant="secondary"
                    showTagsBelow={false}
                    align="right"
                    items={members.map(p => ({ id: p.id, label: p.name, badge: p.employeeNo }))}
                    selectedIds={form.participantIds}
                    onChange={v => patch('participantIds', v)}
                    multiple={true}
                  />
                </div>
              </div>
            </>
          ) : (
            <>
              {/* 交班人员 */}
              <div className="person-picker-bar">
                <div className="person-picker-bar-left">
                  <span className="person-picker-label">
                    交班人员 {form.handoverIds?.length > 0 ? `(${form.handoverIds.length})` : ''}
                  </span>
                  {form.handoverIds?.length > 0 ? (
                    <div className="person-chips-flow">
                      {form.handoverIds.map(id => {
                        const person = members.find(p => p.id === id);
                        if (!person) return null;
                        return (
                          <span className="person-chip" key={id}>
                            <span className="person-chip-name">{person.name}</span>
                            {person.employeeNo && <span className="person-chip-no">{person.employeeNo}</span>}
                            <button
                              type="button"
                              className="person-chip-del"
                              title="移除"
                              onClick={() => patch('handoverIds', form.handoverIds.filter(pid => pid !== id))}
                            >
                              ×
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="person-picker-empty">未选择交班人员</span>
                  )}
                </div>
                <div className="person-picker-bar-right">
                  <button
                    type="button"
                    className="btn-quick-text"
                    onClick={() => patch('handoverIds', members.map(p => p.id))}
                  >
                    全选
                  </button>
                  {form.handoverIds?.length > 0 && (
                    <button
                      type="button"
                      className="btn-quick-text"
                      onClick={() => patch('handoverIds', [])}
                    >
                      清空
                    </button>
                  )}
                  <TagDropdownPicker
                    buttonText="选择交班人"
                    buttonVariant="secondary"
                    showTagsBelow={false}
                    align="right"
                    items={members.map(p => ({ id: p.id, label: p.name, badge: p.employeeNo }))}
                    selectedIds={form.handoverIds}
                    onChange={v => patch('handoverIds', v)}
                    multiple={true}
                  />
                </div>
              </div>

              {/* 接班人员 */}
              <div className="person-picker-bar">
                <div className="person-picker-bar-left">
                  <span className="person-picker-label">
                    接班人员 {form.takeoverIds?.length > 0 ? `(${form.takeoverIds.length})` : ''}
                  </span>
                  {form.takeoverIds?.length > 0 ? (
                    <div className="person-chips-flow">
                      {form.takeoverIds.map(id => {
                        const person = members.find(p => p.id === id);
                        if (!person) return null;
                        return (
                          <span className="person-chip" key={id}>
                            <span className="person-chip-name">{person.name}</span>
                            {person.employeeNo && <span className="person-chip-no">{person.employeeNo}</span>}
                            <button
                              type="button"
                              className="person-chip-del"
                              title="移除"
                              onClick={() => patch('takeoverIds', form.takeoverIds.filter(pid => pid !== id))}
                            >
                              ×
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="person-picker-empty">未选择接班人员</span>
                  )}
                </div>
                <div className="person-picker-bar-right">
                  <button
                    type="button"
                    className="btn-quick-text"
                    onClick={() => patch('takeoverIds', members.map(p => p.id))}
                  >
                    全选
                  </button>
                  {form.takeoverIds?.length > 0 && (
                    <button
                      type="button"
                      className="btn-quick-text"
                      onClick={() => patch('takeoverIds', [])}
                    >
                      清空
                    </button>
                  )}
                  <TagDropdownPicker
                    buttonText="选择接班人"
                    buttonVariant="secondary"
                    showTagsBelow={false}
                    align="right"
                    items={members.map(p => ({ id: p.id, label: p.name, badge: p.employeeNo }))}
                    selectedIds={form.takeoverIds}
                    onChange={v => patch('takeoverIds', v)}
                    multiple={true}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      {/* Dynamic Module Cards */}
      {modules.filter(m => m.enabled).map(m => {
        const meta = getModuleMeta(m.id, m.label);
        return (
          <section className="module-card" key={m.id}>
            <div className="module-card-head">
              <div className="module-icon-wrap">
                <AppIcon name={meta.icon} size={16} />
              </div>
              <div className="module-head-info">
                <div className="module-head-title">{m.label}</div>
                <div className="module-head-desc">{meta.desc}</div>
              </div>
              <div className="module-head-tag">{meta.tag}</div>
            </div>
            <div className="module-card-body">
              <ModuleFields
                module={m}
                value={form.form[m.id]}
                members={members.filter(p => [form.hostId, ...form.participantIds, ...form.handoverIds, ...form.takeoverIds].includes(p.id))}
                onChange={value => patch('form', { ...form.form, [m.id]: value })}
              />
            </div>
          </section>
        );
      })}

      {/* Bottom Sticky Actions Bar */}
      <div className="bottom-bar">
        <div className="bottom-bar-feedback">
          {saveStatus && <div className={`bottom-bar-status ${error ? 'error' : saved ? 'success' : ''}`} role={error ? 'alert' : 'status'}>{saveStatus}</div>}
          <div className="bottom-bar-actions">
            {!initial && (
              <>
                <Button type="button" variant="ghost" shape="pill" size="sm" disabled={busy || uncertain} onClick={stash}>
                  暂存草稿
                </Button>
                <Button type="button" variant="ghost" shape="pill" size="sm" disabled={busy || uncertain} onClick={restore}>
                  恢复草稿
                </Button>
              </>
            )}
            {!ready && error && <Button type="button" variant="secondary" shape="pill" size="sm" onClick={() => setLoadAttempt(n => n + 1)}>重新加载</Button>}
            {saved && !initial && (
              <Button type="button" variant="secondary" shape="pill" size="sm" onClick={() => window.location.reload()}>
                新建一条
              </Button>
            )}
          </div>
        </div>
        <Button type="button" variant="primary" shape="pill" disabled={busy || uncertain || !ready} onClick={() => void save()}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

function ModuleFields({ module: m, value, members, onChange }) {
  // 1. Text / List Items Module (e.g. 思政三分钟, 重点工作, 补充交办)
  if (m.type === 'text') {
    const rows = lineItems(value);
    return (
      <div className="list-items-container">
        {rows.map((r, i) => (
          <div className="list-item-row" key={i}>
            <div className="list-item-index">{i + 1}</div>
            <div className={`list-item-fields ${m.enableRemarks ? 'has-remarks' : ''}`}>
              <Input
                aria-label={`${m.label}第${i + 1}条`}
                placeholder="请输入条款内容或工作要求…"
                value={r.text}
                maxLength={2000}
                onChange={e => onChange(rows.map((x, n) => (n === i ? { ...x, text: e.target.value } : x)))}
              />
              {m.enableRemarks && (
                <Input
                  aria-label={`${m.label}第${i + 1}条备注`}
                  placeholder="补充备注…"
                  value={r.remark ?? ''}
                  maxLength={500}
                  onChange={e => onChange(rows.map((x, n) => (n === i ? { ...x, remark: e.target.value } : x)))}
                />
              )}
            </div>
            <button
              type="button"
              className="list-item-delete"
              title="删除此项"
              onClick={() => onChange(rows.filter((_, n) => n !== i))}
            >
              <Trash size={15} />
            </button>
          </div>
        ))}
        <div className="capsule-add-wrap">
          <button
            type="button"
            className="btn-capsule-add"
            onClick={() => onChange([...rows, { text: '', remark: '' }])}
          >
            <Plus size={13} weight="bold" />
            <span>添加一条</span>
          </button>
        </div>
      </div>
    );
  }

  // 2. Quiz Record Module (现场抽问: 精致紧凑的单行卡片，包含被抽问人、回答情况与问题要点)
  if (m.type === 'quiz') {
    const rows = value ?? [];
    return (
      <div className="quiz-list">
        {rows.map((q, i) => (
          <div className="quiz-item-row" key={i}>
            <div className="quiz-item-index">{i + 1}</div>
            <div className="quiz-item-person">
              <Select
                aria-label="被抽问人"
                value={q.personId}
                onChange={e => onChange(rows.map((r, n) => (n === i ? { ...r, personId: e.target.value } : r)))}
              >
                <option value="">选择被抽问人</option>
                {members.map(p => (
                  <option value={p.id} key={p.id}>{p.name}</option>
                ))}
              </Select>
            </div>
            <div className="quiz-item-status">
              <Select
                aria-label="回答情况"
                value={q.status}
                onChange={e => onChange(rows.map((r, n) => (n === i ? { ...r, status: e.target.value } : r)))}
              >
                <option value="">回答情况</option>
                <option value="correct">回答正确</option>
                <option value="incorrect">回答错误</option>
              </Select>
            </div>
            <div className="quiz-item-content">
              <Input
                aria-label="抽问内容"
                placeholder="请输入抽问内容或业务要点…"
                maxLength={500}
                value={q.content}
                onChange={e => onChange(rows.map((r, n) => (n === i ? { ...r, content: e.target.value } : r)))}
              />
            </div>
            <button
              type="button"
              className="list-item-delete"
              title="删除此抽问"
              onClick={() => onChange(rows.filter((_, n) => n !== i))}
            >
              <Trash size={15} />
            </button>
          </div>
        ))}
        <div className="capsule-add-wrap">
          <button
            type="button"
            className="btn-capsule-add"
            onClick={() => onChange([...rows, { personId: '', content: '', status: '' }])}
          >
            <Plus size={13} weight="bold" />
            <span>添加抽问</span>
          </button>
        </div>
      </div>
    );
  }

  // 3. Safety Prediction Module (风险辨识 / 班前预想)
  if (m.type === 'safety') {
    return (
      <div className="safety-list">
        {m.items.map(item => {
          const v = value?.[item.id] ?? { checked: false, remark: '', personIds: [] };
          const update = next => onChange({ ...value, [item.id]: { ...v, ...next } });
          return (
            <div key={item.id} className={`safety-item ${v.checked ? 'is-checked' : ''}`}>
              <label className="safety-item-header">
                <input
                  type="checkbox"
                  checked={v.checked}
                  onChange={e => update({ checked: e.target.checked })}
                />
                <span>{item.label}</span>
              </label>
              <div className="safety-item-sub">
                <Input
                  aria-label={`${item.label}预防措施/备注`}
                  placeholder="防范措施或补充备注…"
                  maxLength={500}
                  value={v.remark}
                  onChange={e => update({ remark: e.target.value })}
                />
                <TagDropdownPicker
                  title="责任人"
                  buttonText="选择责任人"
                  buttonVariant="secondary"
                  emptyText="无责任人"
                  items={members.map(p => ({ id: p.id, label: p.name, badge: p.employeeNo }))}
                  selectedIds={v.personIds}
                  onChange={personIds => update({ personIds })}
                  multiple={true}
                />
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // 4. Checklist Module (点验清单 / 状态确认)
  return (
    <div className="checklist-grid">
      {m.items.map(item => {
        const checked = value?.[item.id] === true;
        return (
          <label key={item.id} className={`checklist-pill ${checked ? 'is-checked' : ''}`}>
            <input
              type="checkbox"
              checked={checked}
              onChange={e => onChange({ ...value, [item.id]: e.target.checked })}
            />
            <span>{item.label}</span>
          </label>
        );
      })}
    </div>
  );
}

function moduleSummary(m, value, people) {
  const name = id => people.find(p => p.id === id)?.name ?? '—';
  if (m.type === 'text') return lineItems(value).map(r => r.text + (r.remark ? ' · ' + r.remark : '')).join('\n') || '—';
  if (m.type === 'quiz') return (value ?? []).map(q => `${name(q.personId)}：${q.content}（${q.status === 'correct' ? '回答正确' : q.status === 'incorrect' ? '回答错误' : '未记录'}）`).join('\n') || '—';
  if (m.type === 'safety') return m.items.map(i => {
    const v = value?.[i.id];
    return `${v?.checked ? '✓' : '○'} ${i.label}${v?.remark ? ' · ' + v.remark : ''}${v?.personIds?.length ? ' · ' + v.personIds.map(name).join('、') : ''}`;
  }).join('\n');
  return m.items.map(i => `${value?.[i.id] ? '✓' : '○'} ${i.label}`).join('\n');
}

function Records({ session, kind }) {
  const [rows, setRows] = useState([]);
  const [pages, setPages] = useState([null]);
  const [next, setNext] = useState(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [org, setOrg] = useState('');
  const [shift, setShift] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(false);
  const [signing, setSigning] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [signatureImage, setSignatureImage] = useState(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setPages([null]);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let active = true;
    setBusy(true);
    call('list', {
      kind,
      from,
      to,
      search: query,
      ...(org ? { organizationId: org } : {}),
      ...(shift ? { shiftType: shift } : {}),
      ...(pages.at(-1) ? { after: pages.at(-1) } : {})
    })
      .then(r => {
        if (active) {
          setRows(r.rows);
          setNext(r.nextCursor);
          setError('');
        }
      })
      .catch(e => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => { active = false; };
  }, [from, to, org, shift, pages, refresh, query]);

  useEffect(() => {
    void sandbox.invoke('platform.ui.modal', { open: !!detail }).catch(() => {});
  }, [!!detail]);

  async function open(row) {
    try {
      setDetail(await call('detail', { id: row.id }));
      setEditing(false);
      setSigning(false);
      setSignatureImage(null);
    } catch (e) {
      setError(e.message);
    }
  }

  const readGrant = session.grants.find(g => g.permission === 'app.shifts.read');
  const orgs = session.organizations.filter(o => readGrant?.all || readGrant?.organizationIds.includes(o.id));
  const filterGroups = [
    ...(orgs.length > 1 ? [{ id: 'org', title: '所属工班', isMulti: false, options: orgs.map(o => ({ id: o.id, label: o.name })) }] : []),
    ...(kind === 'handover' ? [{ id: 'shift', title: '班次类别', isMulti: false, options: [{ id: 'day', label: '白班' }, { id: 'night', label: '夜班' }] }] : [])
  ];

  const applyFilters = f => {
    setFrom(f.startDate ?? '');
    setTo(f.endDate ?? '');
    setOrg(f.selectedOptions.org?.[0] ?? '');
    setShift(f.selectedOptions.shift?.[0] ?? '');
    setPages([null]);
  };

  return (
    <>
      {error && <div className="notice-banner error" role="alert">{error}</div>}

      <DataList
        toolbar={
          <FilterBar
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="搜索填报人员、条款内容或重点事项…"
            filterGroups={filterGroups}
            activeFilters={{
              startDate: from,
              endDate: to,
              selectedOptions: {
                org: org ? [org] : [],
                shift: shift ? [shift] : []
              }
            }}
            onApplyFilters={applyFilters}
            onResetFilters={() => applyFilters({ selectedOptions: {} })}
          />
        }
        emptyState={busy ? '正在加载台账数据…' : rows.length ? null : '暂无历史填报记录'}
        pagination={
          <ListPagination
            page={pages.length}
            busy={busy}
            hasNext={!!next}
            onPrevious={() => setPages(pages.slice(0, -1))}
            onNext={() => setPages([...pages, next])}
          />
        }
      >
        <TableHeader>
          <TableRow>
            <TableHead>填报日期 / 时间</TableHead>
            <TableHead>所属工班</TableHead>
            <TableHead>{kind === 'meeting' ? '主持人' : '接班人员'}</TableHead>
            <TableHead style={{ width: 100, textAlign: 'right' }}>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(row => (
            <TableRow key={row.id}>
              <TableCell>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 600, color: '#18181b' }}>{row.record_date}</span>
                  <span style={{ color: '#71717a' }}>{row.record_time}</span>
                  {kind === 'handover' && (
                    <span className={`shift-tag ${row.shift_type === 'day' ? 'day' : 'night'}`}>
                      {row.shift_type === 'day' ? '白班' : '夜班'}
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell>{session.organizations.find(o => o.id === row.organization_id)?.name ?? '—'}</TableCell>
              <TableCell>
                {row.people.filter(p => p.role === (kind === 'meeting' ? 'host' : 'takeover')).map(p => p.name).join('、') || '—'}
              </TableCell>
              <TableCell style={{ textAlign: 'right' }}>
                <Button size="sm" variant="secondary" shape="pill" onClick={() => open(row)}>
                  查看详情
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </DataList>

      {/* Record Detail / Edit Dialog */}
      <Dialog
        open={!!detail}
        title={editing ? '修改填报记录' : kind === 'meeting' ? '晨会台账详情' : '交接班台账详情'}
        size="lg"
        onClose={() => {
          setDetail(null);
          setSigning(false);
        }}
      >
        {detail && (
          editing ? (
            <RecordForm
              session={session}
              kind={kind}
              initial={detail}
              onSaved={() => {
                setDetail(null);
                setRefresh(v => v + 1);
              }}
            />
          ) : (
            <div className="shifts-dialog" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Header Info */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 12, borderBottom: '1px solid #e4e4e7' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 16, fontWeight: 700, color: '#18181b' }}>
                    {detail.record_date} {detail.record_time}
                  </span>
                  {kind === 'handover' && (
                    <span className={`shift-tag ${detail.shift_type === 'day' ? 'day' : 'night'}`}>
                      {detail.shift_type === 'day' ? '白班' : '夜班'}
                    </span>
                  )}
                </div>
                {session.grants.some(g => g.permission === 'app.shifts.submit') && (
                  <Button variant="secondary" shape="pill" size="sm" onClick={() => setEditing(true)}>
                    <PencilSimpleLine size={13} />
                    <span>修改</span>
                  </Button>
                )}
              </div>

              {/* Personnel */}
              <div style={{ background: '#fafafa', padding: '10px 14px', borderRadius: 8, fontSize: 13, border: '1px solid #f4f4f5' }}>
                <span style={{ color: '#71717a', marginRight: 8 }}>相关人员：</span>
                <span style={{ color: '#18181b', fontWeight: 500 }}>
                  {detail.people.map(p => p.name).join('、')}
                </span>
              </div>

              {/* Modules Snapshot */}
              {detail.module_snapshot.filter(m => m.enabled).map(m => {
                const meta = getModuleMeta(m.id, m.label);
                return (
                  <section key={m.id} style={{ marginTop: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <div className="module-icon-wrap" style={{ width: 24, height: 24, borderRadius: 6 }}>
                        <AppIcon name={meta.icon} size={13} />
                      </div>
                      <span style={{ fontSize: 14, fontWeight: 600, color: '#18181b' }}>{m.label}</span>
                    </div>
                    <div className="record-snapshot-block">
                      {moduleSummary(m, detail.form_data[m.id], detail.people)}
                    </div>
                  </section>
                );
              })}

              {/* Signature Section */}
              {kind === 'meeting' && (
                <section style={{ marginTop: 12, paddingTop: 14, borderTop: '1px solid #e4e4e7' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#18181b' }}>参会人员本人签署</span>
                  </div>

                  {detail.signatureInfo?.unavailable ? (
                    <p style={{ color: '#a1a1aa', fontSize: 13 }}>平台签署信息暂时无法读取</p>
                  ) : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                      {detail.people.map(p => {
                        const signer = detail.signatureInfo?.signers?.find(s => s.personId === p.id);
                        const isSigned = signer?.status === 'signed';
                        return (
                          <button
                            type="button"
                            key={p.id}
                            disabled={!isSigned}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '4px 10px',
                              borderRadius: 9999,
                              fontSize: 12,
                              border: isSigned ? '1px solid #18181b' : '1px solid #e4e4e7',
                              background: isSigned ? '#18181b' : '#fafafa',
                              color: isSigned ? '#ffffff' : '#a1a1aa',
                              cursor: isSigned ? 'pointer' : 'default'
                            }}
                            onClick={async () => {
                              try {
                                const sig = await call('signature-image', { id: detail.id, signerPersonId: p.id });
                                setSignatureImage(sig.image);
                              } catch (e) {
                                setError(e.message);
                              }
                            }}
                          >
                            <span>{p.name}</span>
                            <span>{isSigned ? '✓ 已签' : '○ 未签'}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {signatureImage && (
                    <div className="signature-box">
                      <div style={{ fontSize: 12, color: '#71717a', marginBottom: 6 }}>电子手写签名</div>
                      <img src={signatureImage} alt="电子签名" className="signature-img" />
                    </div>
                  )}

                  {detail.people.some(p => p.id === session.personId) &&
                    session.grants.some(g => g.permission === 'app.shifts.sign') && (
                      <div style={{ marginTop: 14 }}>
                        {signing ? (
                          <SignaturePad
                            id={detail.id}
                            onSaved={async () => {
                              setSigning(false);
                              await open(detail);
                            }}
                          />
                        ) : (
                          <Button variant="primary" shape="pill" onClick={() => setSigning(true)}>
                            本人手写签署
                          </Button>
                        )}
                      </div>
                    )}
                </section>
              )}
            </div>
          )
        )}
      </Dialog>
    </>
  );
}

function SignaturePad({ id, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);

  async function save(_blob, image) {
    if (busy || uncertain) return;
    setBusy(true);
    setError('');
    try {
      await call('sign', { id, image });
      await onSaved();
    } catch (e) {
      setError(e.message);
      if (e.unknown) setUncertain(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {error && <div className="notice-banner error" role="alert">{error}</div>}
      <div style={{ border: '1px solid #e4e4e7', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
        <HandwrittenSignaturePad
          embedded
          showHeading={false}
          showToolbar={true}
          submitting={busy || uncertain}
          onSubmit={save}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('app')).render(<App />);
window.addEventListener('pagehide', () => sandbox.close(), { once: true });
