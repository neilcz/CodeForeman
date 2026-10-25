import { useEffect, useState } from 'react';
import { App, Button, Card, Input, Popconfirm, Radio, Select, Space, Switch, Typography } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import type { ClaudeAuthStyle, ClaudeProfileInfo, InstructionItem, PermissionPolicy, TaskExecutionMode } from '@codeforeman/shared';
import { api } from '../api';
import SshKeysCard from '../SshKeysCard';

interface SettingsResp {
  permissionPolicy: PermissionPolicy;
  taskExecutionMode: TaskExecutionMode;
  instructions: InstructionItem[];
  claudeProfiles: ClaudeProfileInfo[];
  activeClaudeProfileId: string | null;
  /** 保存后生效配置是否变了（服务端据此重启了空闲会话进程） */
  envChanged?: boolean;
  restartedSessions?: number;
}

const AUTH_OPTIONS: { value: ClaudeAuthStyle; label: string }[] = [
  { value: 'bearer', label: 'Bearer（网关）' },
  { value: 'api-key', label: 'x-api-key（官方）' },
];

/** 配置行的本地编辑态：密钥不回填，留空 = 不改动已存的那份 */
interface ProfileRow {
  /** 行标识（选中态的 key）：已保存的用配置 id，新建的用临时 key */
  rowKey: string;
  id?: string;
  name: string;
  baseUrl: string;
  authStyle: ClaudeAuthStyle;
  model: string;
  hasApiKey: boolean;
  apiKey: string;
}

const toRow = (p: ClaudeProfileInfo): ProfileRow => ({
  rowKey: p.id,
  id: p.id,
  name: p.name,
  baseUrl: p.baseUrl,
  authStyle: p.authStyle,
  model: p.model,
  hasApiKey: p.hasApiKey,
  apiKey: '',
});

const POLICY_OPTIONS: { value: PermissionPolicy; label: string; desc: string }[] = [
  {
    value: 'allow-except-delete',
    label: '默认放行（推荐）',
    desc: '删除 /tmp 临时目录下的文件、删除本会话中创建的临时测试文件自动放行；删除项目文件及磁盘上其他文件需确认；方案确认（ExitPlanMode）和提问始终由你人工决定',
  },
  {
    value: 'strict',
    label: '严格模式',
    desc: '文件编辑自动放行，Bash 等其他操作每次都要人工确认；方案确认和提问同样人工决定',
  },
  {
    value: 'allow-all',
    label: '全部放行',
    desc: '包括删除文件、方案确认在内的所有操作都不再确认（完全托管模式），请谨慎使用',
  },
];

export default function SettingsPage({ me }: { me: { role: string } | null }) {
  const [policy, setPolicy] = useState<PermissionPolicy>('allow-except-delete');
  const [executionMode, setExecutionMode] = useState<TaskExecutionMode>('parallel');
  const [instructions, setInstructions] = useState<InstructionItem[]>([]);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [activeProfileId, setActiveProfileId] = useState('');
  const [profilesDirty, setProfilesDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const { message } = App.useApp();
  const isAdmin = me?.role === 'admin';

  const applySettings = (s: SettingsResp) => {
    setPolicy(s.permissionPolicy);
    setExecutionMode(s.taskExecutionMode);
    setInstructions(s.instructions);
    setProfiles(s.claudeProfiles.map(toRow));
    setActiveProfileId(s.activeClaudeProfileId ?? '');
    setProfilesDirty(false);
  };

  useEffect(() => {
    api.get<SettingsResp>('/api/settings').then(applySettings).catch((e) => message.error(e.message));
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

  const changeExecutionMode = async (value: TaskExecutionMode) => {
    const prev = executionMode;
    setExecutionMode(value);
    setSaving(true);
    try {
      await api.put('/api/settings', { taskExecutionMode: value });
      message.success('已保存，运行中的计划仍按原方式收尾');
    } catch (e) {
      setExecutionMode(prev);
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // ---------- Claude 接入配置（可存多套，选一套生效） ----------

  const patchProfile = (rowKey: string, patch: Partial<ProfileRow>) => {
    setProfiles((list) => list.map((r) => (r.rowKey === rowKey ? { ...r, ...patch } : r)));
    setProfilesDirty(true);
  };

  const addProfile = () => {
    const row: ProfileRow = {
      rowKey: crypto.randomUUID(), name: '', baseUrl: '', authStyle: 'bearer', model: '',
      hasApiKey: false, apiKey: '',
    };
    setProfiles((list) => [...list, row]);
    setProfilesDirty(true);
  };

  const removeProfile = (rowKey: string) => {
    setProfiles((list) => list.filter((r) => r.rowKey !== rowKey));
    setProfilesDirty(true);
  };

  /** 提交整份配置列表（后端按 id 增量合并，留空的密钥保持原值）；返回落库后的行 */
  const pushProfiles = async (): Promise<ProfileRow[]> => {
    const res = await api.put<SettingsResp>('/api/settings', {
      claudeProfiles: profiles.map((r) => ({
        id: r.id,
        name: r.name.trim(),
        model: r.model.trim(),
        baseUrl: r.baseUrl.trim(),
        authStyle: r.authStyle,
        ...(r.apiKey.trim() ? { apiKey: r.apiKey.trim() } : {}),
      })),
    });
    applySettings(res);
    return res.claudeProfiles.map(toRow);
  };

  const saveProfiles = async () => {
    if (profiles.some((r) => !r.name.trim())) {
      message.warning('每套配置都要填名称');
      return;
    }
    setSaving(true);
    try {
      const rows = await pushProfiles();
      message.success(`已保存 ${rows.length} 套配置`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /**
   * 选一套生效（含「服务器默认」）＝一次点击完成「切换」：
   * 有未保存改动时先落库（顺带让新建的行拿到 id），再设为生效项。
   */
  const selectActive = async (rowKey: string) => {
    const index = profiles.findIndex((r) => r.rowKey === rowKey);
    if (rowKey && index < 0) return;
    setSaving(true);
    try {
      // 有未保存改动先落库：新建的行这时才拿到 id（落库后 rowKey 会变成 id，故按位置取回该行）
      let rows = profiles;
      if (profilesDirty) {
        if (profiles.some((r) => !r.name.trim())) {
          message.warning('每套配置都要填名称，先补齐再切换');
          return;
        }
        rows = await pushProfiles();
      }
      const picked = index < 0 ? undefined : rows[index];
      if (rowKey && !picked?.id) return;
      const res = await api.put<SettingsResp>('/api/settings', {
        activeClaudeProfileId: picked?.id ?? null,
      });
      applySettings(res);
      const where = picked?.name || '服务器默认（.env）';
      message.success(
        `已切换到「${where}」` + (res.restartedSessions ? `，重启了 ${res.restartedSessions} 个空闲会话进程` : ''),
      );
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** 当前生效配置对应的行 key（'' = 服务器默认） */
  const checkedRowKey = profiles.find((r) => r.id && r.id === activeProfileId)?.rowKey ?? '';

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
    <div className="page-content">
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

      <Card size="small" title="计划执行" style={{ marginTop: 16 }}>
        <Typography.Paragraph type="secondary">
          从会话保存的计划会回到原会话执行。切换方式只影响之后开始的计划，运行中的计划仍按启动时方式收尾。
        </Typography.Paragraph>
        <Radio.Group
          value={executionMode}
          disabled={!isAdmin || saving}
          onChange={(e) => changeExecutionMode(e.target.value as TaskExecutionMode)}
        >
          <Space direction="vertical" size={12}>
            <Radio value="parallel">
              <b>并行（独立分支）</b>
              <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>
                每条计划在独立分支和 worktree 中执行，验收后按原计划设置合并；同一来源会话内仍逐个执行
              </div>
            </Radio>
            <Radio value="serial">
              <b>串行（当前分支）</b>
              <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>
                全局一次执行一条，不新建分支；每条提交 commit 后自动执行下一条，待验收不阻塞队列
              </div>
            </Radio>
          </Space>
        </Radio.Group>
        {!isAdmin && (
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
            只有管理员可以修改计划执行方式。
          </Typography.Paragraph>
        )}
      </Card>

      <Card
        size="small"
        title="Claude 接入配置"
        style={{ marginTop: 16 }}
        extra={isAdmin && (
          <Space>
            <Button size="small" icon={<PlusOutlined />} onClick={addProfile}>添加配置</Button>
            <Button size="small" type="primary" loading={saving} disabled={!profilesDirty} onClick={saveProfiles}>
              保存配置
            </Button>
          </Space>
        )}
      >
        <Typography.Paragraph type="secondary">
          模型、网关地址（Base URL）、密钥可以存成多套，点左侧圆点选中的那套对所有会话生效——
          某套网关不可用时换一套即可继续用，不用改 .env、不用重启服务。
          <br />
          选中的这套是完整配置：<b>留空的项一律不设置</b>，不会沿用 .env 或本机 ~/.claude/settings.json
          里别家的地址/密钥/模型（只选「服务器默认」时才完全沿用它们）。密钥只存在服务端、不回显到页面，留空即保持原样。
          Base URL 填到域名或前缀即可（如 <code>https://apipok.com</code>），<b>不要带 /v1/messages</b>——CLI 会自己拼这段路径。
          <br />
          改动对新起的 Claude 进程生效：切换后空闲会话的进程立刻重启，正在跑的会话在下一轮自动换过来。
        </Typography.Paragraph>
        <Radio.Group
          value={checkedRowKey}
          disabled={!isAdmin || saving}
          onChange={(e) => selectActive(e.target.value as string)}
          style={{ width: '100%' }}
        >
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Radio value="">
              <b>服务器默认</b>
              <span className="claude-profile-hint">沿用服务器 .env / 环境变量里的接入配置</span>
            </Radio>
            {profiles.map((r) => (
              <div className="claude-profile-row" key={r.rowKey}>
                <Radio value={r.rowKey} />
                <Input
                  className="cp-name" addonBefore="名称" value={r.name} disabled={!isAdmin} placeholder="如 Kimi / 官方"
                  onChange={(e) => patchProfile(r.rowKey, { name: e.target.value })}
                />
                <Input
                  className="cp-url" addonBefore="Base URL" value={r.baseUrl} disabled={!isAdmin}
                  placeholder="留空=不设置"
                  onChange={(e) => patchProfile(r.rowKey, { baseUrl: e.target.value })}
                />
                <Select
                  className="cp-auth" value={r.authStyle} disabled={!isAdmin} options={AUTH_OPTIONS}
                  onChange={(v) => patchProfile(r.rowKey, { authStyle: v })}
                />
                <Input.Password
                  className="cp-key" addonBefore="API Key" value={r.apiKey} disabled={!isAdmin}
                  placeholder={r.hasApiKey ? '已保存，留空不改' : '未设置'}
                  onChange={(e) => patchProfile(r.rowKey, { apiKey: e.target.value })}
                />
                <Input
                  className="cp-model" addonBefore="模型" value={r.model} disabled={!isAdmin}
                  placeholder="留空=不设置"
                  onChange={(e) => patchProfile(r.rowKey, { model: e.target.value })}
                />
                {isAdmin && (
                  <Popconfirm title="删除这套配置？" okText="删除" onConfirm={() => removeProfile(r.rowKey)}>
                    <Button className="cp-del" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                )}
              </div>
            ))}
          </Space>
        </Radio.Group>
        {!profiles.length && (
          <Typography.Text type="secondary">还没有配置。点右上角「添加配置」，填好名称与网关信息后保存即可。</Typography.Text>
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
