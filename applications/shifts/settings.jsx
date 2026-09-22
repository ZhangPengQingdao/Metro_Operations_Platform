import React, { useEffect, useRef, useState } from 'react';
import {
  Button, Input, Select, Field, Dialog, Switch,
  Trash, Plus, PencilSimpleLine
} from '@metro/platform-sdk/ui';
import { defaults } from './modules.mjs';

function SettingIcon({ name, size = 16 }) {
  switch (name) {
    case 'clock':
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>;
    case 'users':
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
    case 'sparkle':
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4L12 2z"/></svg>;
    case 'shield':
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
    case 'chat':
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>;
    case 'check':
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>;
    case 'webhook':
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>;
    default:
      return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>;
  }
}

export function Settings({ session, call, sandbox }) {
  const [tab, setTab] = useState('handover');
  const [settings, setSettings] = useState(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [edit, setEdit] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(null);
  const drag = useRef(null);

  const org = session.organizationId;
  const current = settings?.[tab];

  useEffect(() => {
    let active = true;
    setSettings(null);
    setError('');
    call('settings', { organizationId: org })
      .then(value => { if (active) setSettings(value); })
      .catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [org, loadAttempt]);

  useEffect(() => {
    void sandbox.invoke('platform.ui.modal', { open: !!edit }).catch(() => {});
  }, [!!edit]);

  const update = value => setSettings(s => ({ ...s, [tab]: { ...s[tab], value } }));

  function setModules(modules) {
    update({ ...current.value, mode: 'override', modules });
  }

  function reorder(id, target) {
    if (!target || id === target) return;
    const modules = [...current.value.modules];
    const from = modules.findIndex(m => m.id === id);
    const to = modules.findIndex(m => m.id === target);
    if (from < 0 || to < 0) return;
    modules.splice(to, 0, ...modules.splice(from, 1));
    setModules(modules);
  }

  async function save() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await call('configure', {
        organizationId: org,
        type: tab,
        value: {
          ...current.value,
          mode: tab === 'webhook' && current.value.mode === 'disabled' ? 'disabled' : 'override'
        },
        revision: current.revision,
        requestId: crypto.randomUUID()
      });
      setSettings(await call('settings', { organizationId: org }));
      setNotice('设置已成功保存');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function saveModule() {
    if (!edit.label.trim()) {
      setError('请填写模块名称');
      return;
    }
    const exists = current.value.modules.some(m => m.id === edit.id);
    setModules(exists ? current.value.modules.map(m => m.id === edit.id ? edit : m) : [...current.value.modules, edit]);
    setEdit(null);
  }

  function addCustom() {
    setEdit({
      id: 'custom_list_' + crypto.randomUUID(),
      custom: true,
      label: '自定义模块',
      type: 'text',
      enabled: true,
      defaultText: '',
      enableDefaultContent: false,
      enableRemarks: false
    });
  }

  const editItem = (index, patch) =>
    setEdit({
      ...edit,
      items: edit.items.map((item, i) => (i === index ? { ...item, ...patch } : item))
    });

  return (
    <div className="settings-page">
      {error && <div className="notice-banner error" role="alert">{error}</div>}
      {!settings && <div role="status">{error ? <Button onClick={() => setLoadAttempt(n => n + 1)}>重新加载设置</Button> : '正在加载模块设置…'}</div>}
      {notice && <div className="notice-banner success" role="status">{notice}</div>}

      {/* Nav Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, borderBottom: '1px solid #e2e8f0', paddingBottom: 12 }}>
        {[
          ['handover', '交接班功能模块', 'clock'],
          ['meeting', '晨会功能模块', 'sparkle'],
          ['webhook', '群机器人推送', 'webhook']
        ].map(([key, label, iconName]) => {
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                padding: '7px 18px',
                borderRadius: 9999,
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                border: active ? '1px solid #18181b' : '1px solid #e4e4e7',
                background: active ? '#18181b' : '#ffffff',
                color: active ? '#ffffff' : '#52525b',
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
              onClick={() => {
                setTab(key);
                setNotice('');
              }}
            >
              <SettingIcon name={iconName} size={15} />
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      {current && (
        <section className="info-card">
          {tab === 'webhook' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 14, borderBottom: '1px solid #f1f5f9' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>启用群机器人消息推送</div>
                  <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                    当交接班完成或晨会召开保存时，自动将摘要通知推送到企业微信或钉钉群
                  </div>
                </div>
                <Switch
                  checked={current.value.mode !== 'disabled'}
                  onChange={e => update({ ...current.value, mode: e.target.checked ? 'override' : 'disabled' })}
                />
              </div>

              <Field label="群机器人 Webhook 地址（支持企业微信/钉钉）">
                <Input
                  type="password"
                  autoComplete="off"
                  placeholder={current.value.configured ? '地址已配置，如需更换请输入新 Webhook URL' : 'https://qyapi.weixin.qq.com/... 或 https://oapi.dingtalk.com/...'}
                  value={current.value.url ?? ''}
                  onChange={e => update({ ...current.value, url: e.target.value })}
                />
              </Field>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>自动触发事件</span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, background: '#f8fafc', padding: 14, borderRadius: 8, border: '1px solid #eef2f6' }}>
                  <Switch
                    label="交接班确认后自动推送工作群"
                    checked={current.value.handover === true}
                    onChange={e => update({ ...current.value, handover: e.target.checked })}
                  />
                  <Switch
                    label="晨会保存后自动推送工作群"
                    checked={current.value.meeting === true}
                    onChange={e => update({ ...current.value, meeting: e.target.checked })}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>
                  {tab === 'meeting' ? '晨会填报模块列表' : '交接班填报模块列表'}
                </span>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>可拖动 ⠿ 调整在填报页中的显示次序</span>
              </div>

              {/* Fixed Base Module Banner */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 14px',
                  borderRadius: 8,
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  marginBottom: 10
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 6, background: '#e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
                    <SettingIcon name="users" size={15} />
                  </div>
                  <strong style={{ fontSize: 14, color: '#334155' }}>
                    {tab === 'meeting' ? '晨会时间 / 主持人 / 参会人员' : '交接班次 / 时间 / 交接人员'}
                  </strong>
                </div>
                <span style={{ padding: '2px 8px', borderRadius: 4, background: '#e2e8f0', color: '#475569', fontSize: 11, fontWeight: 600 }}>
                  必选基础模块
                </span>
              </div>

              {/* Dynamic Modules List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {current.value.modules.map(m => (
                  <div
                    key={m.id}
                    data-module-id={m.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 14px',
                      borderRadius: 8,
                      background: '#ffffff',
                      border: '1px solid #e2e8f0',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.02)',
                      opacity: dragging === m.id ? 0.55 : 1,
                      transition: 'border-color 0.15s ease'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <button
                        type="button"
                        aria-label={'拖动排序：' + m.label}
                        title="按住拖动排序"
                        style={{
                          touchAction: 'none',
                          cursor: 'grab',
                          padding: '4px 6px',
                          background: '#f1f5f9',
                          borderRadius: 4,
                          border: 'none',
                          color: '#64748b',
                          fontSize: 16,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}
                        onPointerDown={e => {
                          drag.current = m.id;
                          setDragging(m.id);
                          e.currentTarget.setPointerCapture(e.pointerId);
                        }}
                        onPointerMove={e => {
                          if (drag.current) {
                            const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-module-id]')?.dataset.moduleId;
                            reorder(drag.current, target);
                          }
                        }}
                        onPointerUp={() => {
                          drag.current = null;
                          setDragging(null);
                        }}
                        onPointerCancel={() => {
                          drag.current = null;
                          setDragging(null);
                        }}
                        onKeyDown={e => {
                          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                          e.preventDefault();
                          const i = current.value.modules.findIndex(x => x.id === m.id);
                          reorder(m.id, current.value.modules[i + (e.key === 'ArrowUp' ? -1 : 1)]?.id);
                        }}
                      >
                        ⠿
                      </button>
                      <span style={{ fontSize: 14, fontWeight: 500, color: '#0f172a' }}>{m.label}</span>
                      {m.custom && (
                        <span style={{ padding: '2px 6px', borderRadius: 4, background: '#eff6ff', color: '#2563eb', fontSize: 11 }}>
                          自定义
                        </span>
                      )}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <Switch
                        checked={m.enabled}
                        onChange={e =>
                          setModules(
                            current.value.modules.map(x => (x.id === m.id ? { ...x, enabled: e.target.checked } : x))
                          )
                        }
                      />
                      {m.type !== 'quiz' && (
                        <Button variant="ghost" size="sm" onClick={() => setEdit(structuredClone(m))}>
                          <PencilSimpleLine size={13} />
                          <span>编辑</span>
                        </Button>
                      )}
                      {m.custom && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setModules(current.value.modules.filter(x => x.id !== m.id))}
                        >
                          <Trash size={13} />
                          <span>删除</span>
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="capsule-add-wrap" style={{ marginTop: 14 }}>
                <button type="button" className="btn-capsule-add" onClick={addCustom}>
                  <Plus size={14} weight="bold" />
                  <span>添加自定义模块</span>
                </button>
              </div>
            </div>
          )}

          {/* Bottom Actions */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 22, paddingTop: 16, borderTop: '1px solid #f1f5f9' }}>
            <div style={{ display: 'flex', gap: 10 }}>
              {tab !== 'webhook' && (
                <Button variant="ghost" onClick={() => setModules(structuredClone(defaults[tab]))}>
                  恢复初始模块
                </Button>
              )}
              {tab === 'webhook' && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await call('test-webhook', { organizationId: org });
                      setNotice('群机器人测试推送已触发，请检查企微或钉钉工作群');
                    } catch (e) {
                      setError(e.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  测试发送一条
                </Button>
              )}
            </div>
            <Button disabled={busy} onClick={save}>
              {busy ? '保存中…' : '保存设置更改'}
            </Button>
          </div>
        </section>
      )}

      {/* Edit Module Dialog */}
      <Dialog
        open={!!edit}
        title={edit?.label ? `配置模块：${edit.label}` : '编辑模块'}
        onClose={() => setEdit(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEdit(null)}>
              取消
            </Button>
            <Button onClick={saveModule}>确定保存</Button>
          </>
        }
      >
        {edit && (
          <div className="shifts-dialog" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {edit.custom && (
              <Field label="模块显示名称">
                <Input
                  maxLength={60}
                  value={edit.label}
                  onChange={e => setEdit({ ...edit, label: e.target.value })}
                />
              </Field>
            )}

            {edit.type === 'text' && (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, background: '#f8fafc', padding: 14, borderRadius: 8, border: '1px solid #eef2f6' }}>
                  {edit.id === 'other_matters' ? (
                    <Switch
                      label="自动带入上次填写的未结事项"
                      checked={edit.enableCarryOver === true}
                      onChange={e => setEdit({ ...edit, enableCarryOver: e.target.checked })}
                    />
                  ) : !(tab === 'meeting' && edit.id === 'study_content') ? (
                    <Switch
                      label="启用默认预设内容"
                      checked={edit.enableDefaultContent === true}
                      onChange={e => setEdit({ ...edit, enableDefaultContent: e.target.checked })}
                    />
                  ) : null}
                  {(tab === 'meeting' || edit.custom) && (
                    <Switch
                      label="每条后启用独立备注栏"
                      checked={edit.enableRemarks === true}
                      onChange={e => setEdit({ ...edit, enableRemarks: e.target.checked })}
                    />
                  )}
                </div>

                {edit.enableDefaultContent && (
                  <Field label="默认预设内容（每行生成一项）">
                    <textarea
                      rows={4}
                      maxLength={1500}
                      value={edit.defaultText}
                      onChange={e => setEdit({ ...edit, defaultText: e.target.value })}
                      style={{
                        width: '100%',
                        borderRadius: 8,
                        border: '1px solid #cbd5e1',
                        padding: 10,
                        fontSize: 13,
                        fontFamily: 'inherit'
                      }}
                    />
                  </Field>
                )}
              </>
            )}

            {edit.items && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>子项配置</span>
                {edit.items.map((item, i) => (
                  <div
                    key={item.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: 8,
                      borderRadius: 8,
                      background: '#f8fafc',
                      border: '1px solid #e2e8f0'
                    }}
                  >
                    <Input
                      aria-label={'第' + (i + 1) + '项标签'}
                      placeholder="子项标签名称"
                      maxLength={120}
                      value={item.label}
                      onChange={e => editItem(i, { label: e.target.value })}
                    />
                    {edit.type === 'safety' && (
                      <Input
                        aria-label={'第' + (i + 1) + '项默认备注'}
                        placeholder="默认备注"
                        maxLength={500}
                        value={item.remark ?? ''}
                        onChange={e => editItem(i, { remark: e.target.value })}
                      />
                    )}
                    <button
                      type="button"
                      className="list-item-delete"
                      title="删除此项"
                      onClick={() => setEdit({ ...edit, items: edit.items.filter((_, n) => n !== i) })}
                    >
                      <Trash size={15} />
                    </button>
                  </div>
                ))}
                <div className="capsule-add-wrap" style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    className="btn-capsule-add"
                    onClick={() =>
                      setEdit({
                        ...edit,
                        items: [...edit.items, { id: crypto.randomUUID(), label: '', remark: '' }]
                      })
                    }
                  >
                    <Plus size={13} weight="bold" />
                    <span>添加一项</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
