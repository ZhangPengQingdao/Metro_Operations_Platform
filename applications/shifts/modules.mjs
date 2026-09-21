const text = (id, label, defaultText = '') => ({
  id, label, type: 'text', enabled: true, defaultText,
  enableDefaultContent: !!defaultText, enableRemarks: false, enableCarryOver: id === 'other_matters',
});
const checks = (id, label, items) => ({id, label, type: 'checks', enabled: true, items: items.map((label, i) => ({id: `item-${i + 1}`, label, remark: ''}))});
export const defaults = {
  handover: [checks('checklist', '班前确认', ['人员状态良好（无饮酒、精神饱满）', '工装穿戴齐全（劳保用品完备）']), text('todo_record', '待办任务'), text('fault_record', '新增故障'), text('material_consume', '物料消耗'), text('maintenance_plan', '检修计划'), text('tool_check', '工器具管理'), checks('post_shift_checklist', '交班确认', ['设备运行状态正常', '卫生清理完毕', '工器具归位']), text('other_matters', '其他事项')],
  meeting: [text('study_content', '学习文件'), text('ideology_minute', '思政三分钟'), text('key_work_items', '当班基本要求', '明确当日重点任务\n强调风险点与配合要求'), {...checks('safety_prediction', '安全预想', ['作业安全风险提示', '大客流与突发情况准备']), type: 'safety'}, {id: 'quiz_record', label: '抽问记录', type: 'quiz', enabled: true}, text('other_matters', '其他事项')],
};
const fail = () => { throw Error('INVALID_INPUT'); };
const string = (value, max) => typeof value === 'string' && value.length <= max;
export const lineItems = value => typeof value === 'string' ? value.split('\n').filter(Boolean).map(text => ({text, remark: ''})) : value ?? [];
export function validateModules(kind, value) {
  if (!defaults[kind] || !Array.isArray(value) || value.length > 30) fail();
  const seen = new Set();
  const output = value.map(m => {
    if (!m || !string(m.id, 80)) fail();
    const base = defaults[kind].find(x => x.id === m.id);
    const custom = /^custom_list_[a-z0-9-]{1,60}$/.test(m.id);
    if ((!base && !custom) || seen.has(m.id) || m.type !== (base?.type ?? 'text') || typeof m.enabled !== 'boolean' || !string(m.label, 60) || !m.label.trim()) fail();
    seen.add(m.id);
    const result = {id: m.id, label: m.label.trim(), type: m.type, enabled: m.enabled, ...(custom ? {custom: true} : {})};
    if (m.type === 'text') {
      if (!string(m.defaultText ?? '', 1500)) fail();
      const locked = kind === 'meeting' && m.id === 'study_content';
      Object.assign(result, {enableDefaultContent: !locked && m.enableDefaultContent === true, defaultText: locked ? '' : m.defaultText ?? '', enableRemarks: m.enableRemarks === true, enableCarryOver: m.id === 'other_matters' && m.enableCarryOver === true});
    }
    if (['checks', 'safety'].includes(m.type)) {
      if (!Array.isArray(m.items) || m.items.length > 20 || m.items.some(x => !x || !/^[a-z0-9-]{1,60}$/.test(x.id) || !string(x.label, 120) || !x.label.trim() || !string(x.remark ?? '', 500)) || new Set(m.items.map(x => x.id)).size !== m.items.length) fail();
      result.items = m.items.map(x => ({id: x.id, label: x.label.trim(), remark: m.type === 'safety' ? x.remark ?? '' : ''}));
    }
    return result;
  });
  if (defaults[kind].some(m => !seen.has(m.id))) fail();
  return output;
}
export function initialModuleValues(modules) {
  return Object.fromEntries(modules.map(m => [m.id, m.type === 'text' ? lineItems(m.enableDefaultContent ? m.defaultText : '') : m.type === 'quiz' ? [] : m.type === 'safety' ? Object.fromEntries(m.items.map(i => [i.id, {checked: false, remark: i.remark ?? '', personIds: []}])) : {}]));
}
export function validateForm(modules, input, personIds = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const out = {};
  for (const m of modules.filter(x => x.enabled)) {
    const value = input[m.id];
    if (m.type === 'text') {
      const rows = lineItems(value);
      if (!Array.isArray(rows) || rows.length > 30) fail();
      out[m.id] = rows.map(r => {
        if (!r || !string(r.text, 2000) || !string(r.remark ?? '', 500)) fail();
        return {text: r.text, remark: m.enableRemarks ? r.remark ?? '' : ''};
      });
    } else if (m.type === 'quiz') {
      if (value !== undefined && (!Array.isArray(value) || value.length > 30)) fail();
      out[m.id] = (value ?? []).map(q => {
        if (!q || !personIds.includes(q.personId) || !string(q.content, 500) || !['', 'correct', 'incorrect'].includes(q.status)) fail();
        return {personId: q.personId, content: q.content, status: q.status};
      });
    } else {
      if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) fail();
      out[m.id] = {};
      for (const item of m.items) {
        if (m.type === 'checks') {
          if (value?.[item.id] !== undefined && typeof value[item.id] !== 'boolean') fail();
          out[m.id][item.id] = value?.[item.id] === true;
        } else {
          const v = value?.[item.id] ?? {};
          if (!v || typeof v !== 'object' || Array.isArray(v) || v.checked !== undefined && typeof v.checked !== 'boolean' || !string(v.remark ?? '', 500) || v.personIds !== undefined && (!Array.isArray(v.personIds) || v.personIds.some(id => !personIds.includes(id)))) fail();
          out[m.id][item.id] = {checked: v.checked === true, remark: v.remark ?? '', personIds: [...new Set(v.personIds ?? [])]};
        }
      }
    }
  }
  if (new TextEncoder().encode(JSON.stringify(out)).length > 6000) throw Error('FORM_TOO_LARGE');
  return out;
}
