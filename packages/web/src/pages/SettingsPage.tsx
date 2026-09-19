import { useEffect, useState } from 'react';
import { App, Button, Card, Input, Popconfirm, Radio, Space, Switch, Typography } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import type { InstructionItem, PermissionPolicy } from '@codeforeman/shared';
import { api } from '../api';
import SshKeysCard from '../SshKeysCard';

const POLICY_OPTIONS: { value: PermissionPolicy; label: string; desc: string }[] = [
  {
    value: 'allow-except-delete',
    label: '默认放行（推荐）',
    desc: '除删除文件（rm / git rm / find -delete 等）需确认外，其他操作自动通过',
  },
  {
    value: 'strict',
    label: '严格模式',
    desc: '文件编辑自动放行，Bash 等其他操作每次都要人工确认',
  },
  {
    value: 'allow-all',
    label: '全部放行',
    desc: '包括删除文件在内的所有操作都不再确认，请谨慎使用',
  },
];

export default function SettingsPage({ me }: { me: { role: string } | null }) {
  const [policy, setPolicy] = useState<PermissionPolicy>('allow-except-delete');
  const [instructions, setInstructions] = useState<InstructionItem[]>([]);
  const [saving, setSaving] = useState(false);
  const { message } = App.useApp();
  const isAdmin = me?.role === 'admin';

  useEffect(() => {
    api.get<{ permissionPolicy: PermissionPolicy; instructions: InstructionItem[] }>('/api/settings')
      .then((s) => { setPolicy(s.permissionPolicy); setInstructions(s.instructions); })
      .catch((e) => message.error(e.message));
  }, []);

  const change = async (value: PermissionPolicy) => {
    const prev = policy;
    setPolicy(value);
    setSaving(true);
    try {
      await api.put('/api/settings', { permissionPolicy: value });
      message.success('已保存，立即生效');
    } catch (e) {
      setPolicy(prev);
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // ---------- 全局指令 ----------

  const patchInstruction = (id: string, patch: Partial<InstructionItem>) => {
    setInstructions((list) => list.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  };

  const addInstruction = () => {
    setInstructions((list) => [...list, { id: crypto.randomUUID(), text: '', enabled: true }]);
  };

  const saveInstructions = async () => {
    if (instructions.some((i) => !i.text.trim())) {
      message.warning('存在空白指令，请填写内容或删除');
      return;
    }
    setSaving(true);
    try {
      const s = await api.put<{ instructions: InstructionItem[] }>('/api/settings', { instructions });
      setInstructions(s.instructions);
      message.success('已保存，对之后新起的会话生效');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-content" style={{ maxWidth: 720 }}>
      <Typography.Title level={4}>设置</Typography.Title>

      <Card size="small" title="权限管理">
        <Typography.Paragraph type="secondary">
          Claude 执行工具（运行命令、改文件等）时的确认策略。策略是全局的，对所有项目与会话生效。
        </Typography.Paragraph>
        <Radio.Group
          value={policy}
          disabled={!isAdmin || saving}
          onChange={(e) => change(e.target.value as PermissionPolicy)}
        >
          <Space direction="vertical" size={12}>
            {POLICY_OPTIONS.map((o) => (
              <Radio key={o.value} value={o.value}>
                <b>{o.label}</b>
                <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>{o.desc}</div>
              </Radio>
            ))}
          </Space>
        </Radio.Group>
        {!isAdmin && (
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
            只有管理员可以修改权限策略。
          </Typography.Paragraph>
        )}
      </Card>

      <Card
        size="small"
        title="全局指令"
        style={{ marginTop: 16 }}
        extra={isAdmin && (
          <Button size="small" icon={<PlusOutlined />} onClick={addInstruction}>添加指令</Button>
        )}
      >
        <Typography.Paragraph type="secondary">
          启用中的指令会注入每个 Claude 会话的系统提示词（环境约束、团队约定等），全局生效。
          修改后对之后新起的会话进程生效，进行中的会话不受影响。
        </Typography.Paragraph>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {instructions.map((item) => (
            <div key={item.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <Switch
                checked={item.enabled}
                disabled={!isAdmin}
                onChange={(enabled) => patchInstruction(item.id, { enabled })}
              />
              <Input.TextArea
                value={item.text}
                disabled={!isAdmin}
                autoSize={{ minRows: 2, maxRows: 10 }}
                placeholder="输入要注入会话的指令，例如：数据库/Redis 必须使用独立容器…"
                onChange={(e) => patchInstruction(item.id, { text: e.target.value })}
              />
              {isAdmin && (
                <Popconfirm title="删除这条指令？" onConfirm={() => setInstructions((l) => l.filter((i) => i.id !== item.id))}>
                  <Button type="text" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              )}
            </div>
          ))}
          {instructions.length === 0 && (
            <Typography.Text type="secondary">暂无指令，点击右上角「添加指令」。</Typography.Text>
          )}
        </Space>
        {isAdmin && (
          <div style={{ marginTop: 12, textAlign: 'right' }}>
            <Button type="primary" loading={saving} onClick={saveInstructions}>保存指令</Button>
          </div>
        )}
      </Card>

      {isAdmin && <SshKeysCard />}
    </div>
  );
}
