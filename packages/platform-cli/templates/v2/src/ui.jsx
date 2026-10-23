import {useEffect, useState} from 'react';
import {defineApp, useApp} from '@metro/platform-sdk/app';
import {Button, Dialog, Field, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from '@metro/platform-sdk/ui';
import './ui.css';

function Records() {
  const {api, user, toast} = useApp();
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => api.call('list', {}).then(result => setRows(result.rows)).catch(() => toast('记录加载失败', 'error'));
  useEffect(() => { void load(); }, []);

  async function save() {
    setSaving(true);
    try {
      await api.call('create', {requestId: crypto.randomUUID(), title: title.trim()});
      setOpen(false);
      setTitle('');
      toast('已保存', 'success');
      await load();
    } catch {
      toast('保存失败，请稍后重试', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="records">
      {user.has('create') && <div className="records-actions"><Button onClick={() => setOpen(true)}>新增记录</Button></div>}
      <Table>
        <TableHeader><TableRow><TableHead>标题</TableHead><TableHead>创建时间</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.map(row => <TableRow key={row.id}><TableCell>{row.title}</TableCell><TableCell>{new Date(row.created_at).toLocaleString()}</TableCell></TableRow>)}
        </TableBody>
      </Table>
      {!rows.length && <p className="records-empty">暂无记录</p>}
      <Dialog open={open} title="新增记录" onClose={() => setOpen(false)}
        footer={<Button disabled={saving || !title.trim()} onClick={() => void save()}>{saving ? '正在保存…' : '保存'}</Button>}>
        <Field label="标题"><Input value={title} maxLength={100} onChange={event => setTitle(event.target.value)} /></Field>
      </Dialog>
    </div>
  );
}

export default defineApp({pages: {'/': Records}});
