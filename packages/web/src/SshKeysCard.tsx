import { useEffect, useState } from 'react';
import { App, Button, Card, Form, Input, List, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { DeleteOutlined, KeyOutlined } from '@ant-design/icons';
import type { SshKeyInfo } from '@codeforeman/shared';
import { api } from './api';

/** SSH Key 管理卡片（设置页内嵌，仅 admin 可见；API 侧也强制 admin） */
export default function SshKeysCard() {
  const [keys, setKeys] = useState<SshKeyInfo[]>([]);
  const { message } = App.useApp();
  const [genForm] = Form.useForm();
  const [importForm] = Form.useForm();
  const [genLoading, setGenLoading] = useState(false);
  const [importLoading, setImportLoading] = useState(false);

  const load = () => api.get<SshKeyInfo[]>('/api/ssh-keys').then(setKeys).catch((e) => message.error(e.message));
  useEffect(() => { load(); }, []);

  const generate = async (v: { name: string; type: 'ed25519' | 'rsa' }) => {
    setGenLoading(true);
    try {
      await api.post('/api/ssh-keys/generate', v);
      genForm.resetFields(['name']);
      message.success('密钥对已生成，把公钥添加到 Git server 即可使用');
      load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setGenLoading(false);
    }
  };

  const importKey = async (v: { name: string; privateKey: string; publicKey?: string }) => {
    setImportLoading(true);
    try {
      await api.post('/api/ssh-keys/import', v);
      importForm.resetFields();
      message.success('私钥已导入，对应公钥已在 git server 配好的话现在就能用');
      load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setImportLoading(false);
    }
  };

  const remove = async (name: string) => {
    try {
      await api.del(`/api/ssh-keys/${name}`);
      message.success('已删除');
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <Card size="small" title="SSH Key 管理" style={{ marginTop: 16 }}>
      <Typography.Paragraph type="secondary">
        这里的 key 用于 clone / push SSH 地址（git@github.com:...）的仓库。
        生成或导入后，把公钥添加到 GitHub/GitLab 的 Deploy Keys（或账号 SSH Keys）即可生效。
      </Typography.Paragraph>

      <Card type="inner" size="small" title="生成新密钥对" style={{ marginBottom: 12 }}>
        <Form form={genForm} layout="inline" onFinish={generate} initialValues={{ type: 'ed25519' }}>
          <Form.Item name="name" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="名称（如 github-deploy）" />
          </Form.Item>
          <Form.Item name="type">
            <Select
              style={{ width: 140 }}
              options={[{ value: 'ed25519', label: 'ed25519（推荐）' }, { value: 'rsa', label: 'rsa-4096' }]}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={genLoading}>生成</Button>
        </Form>
      </Card>

      <Card type="inner" size="small" title="导入已有私钥" style={{ marginBottom: 12 }}>
        <Form form={importForm} layout="vertical" onFinish={importKey}>
          <Form.Item name="name" rules={[{ required: true, message: '请输入名称' }]} style={{ maxWidth: 320 }}>
            <Input placeholder="名称（如 my-laptop-key）" />
          </Form.Item>
          <Form.Item
            name="privateKey"
            rules={[{ required: true, message: '请粘贴私钥' }]}
            extra="PEM/OpenSSH 格式（-----BEGIN ... PRIVATE KEY-----）。不能带 passphrase，容器内无法交互输入密码。"
          >
            <Input.TextArea rows={5} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" style={{ fontFamily: 'monospace' }} />
          </Form.Item>
          <Form.Item name="publicKey" extra="可选。不填会自动从私钥推导。">
            <Input.TextArea rows={2} placeholder="ssh-ed25519 AAAA... （可选）" style={{ fontFamily: 'monospace' }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={importLoading}>导入</Button>
        </Form>
      </Card>

      <List
        dataSource={keys}
        locale={{ emptyText: '还没有 key' }}
        renderItem={(k) => (
          <List.Item
            actions={[
              <Popconfirm key="del" title={`删除 key ${k.name}？`} onConfirm={() => remove(k.name)}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>,
            ]}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <Space>
                <KeyOutlined />
                <b>{k.name}</b>
                <Tag>{k.type}</Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{k.fingerprint}</Typography.Text>
              </Space>
              <Typography.Paragraph
                copyable={{ tooltips: ['复制公钥', '已复制'] }}
                code
                style={{ marginTop: 8, marginBottom: 0, fontSize: 12, wordBreak: 'break-all' }}
              >
                {k.publicKey}
              </Typography.Paragraph>
            </div>
          </List.Item>
        )}
      />
    </Card>
  );
}
