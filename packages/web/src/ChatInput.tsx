import { useEffect, useRef, useState } from 'react';
import { App, Button } from 'antd';
import { Sender, Attachments } from '@ant-design/x';
import type { Attachment } from '@ant-design/x/es/attachments';
import { PaperClipOutlined } from '@ant-design/icons';
import type { AttachmentInfo } from '@codeforeman/shared';
import { uploadAttachment } from './api';
import { sendWs } from './ws';

/**
 * 会话输入区（独立组件）：输入/附件状态全部留在组件内部，
 * 打字只重渲染本组件，不再触碰消息列表（长会话打字卡顿的根源修复）。
 * 调用方以 key={sessionId} 挂载，切换会话时自动重置输入与待发送附件。
 */
export default function ChatInput({ sessionId }: { sessionId: string }) {
  const { message } = App.useApp();
  const [input, setInput] = useState('');
  const [attachItems, setAttachItems] = useState<Attachment[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [sending, setSending] = useState(false);
  /** uid → 预览 blob URL，用于移除/发送后回收 */
  const blobUrlsRef = useRef<Map<string, string>>(new Map());

  // 卸载（切换会话/离开页面）时兜底回收未清空的预览 blob
  useEffect(() => {
    const urls = blobUrlsRef.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  /** 图片/视频附件补本地预览 URL（FileList 只会为图片生成缩略图，视频需要 blob 才能出首帧） */
  const withPreview = (f: File, uid: string): Attachment => {
    const a: Attachment = {
      uid,
      name: f.name || `粘贴的图片-${Date.now()}.png`,
      size: f.size,
      // UploadFile.originFileObj 类型是 RcFile（File + uid），运行时不依赖 uid 字段
      originFileObj: f as Attachment['originFileObj'],
    };
    if (/^(image|video)\//.test(f.type)) {
      const url = URL.createObjectURL(f);
      blobUrlsRef.current.set(uid, url);
      a.url = url;
    }
    return a;
  };

  const clearAttachments = () => {
    for (const url of blobUrlsRef.current.values()) URL.revokeObjectURL(url);
    blobUrlsRef.current.clear();
    setAttachItems([]);
    setAttachOpen(false);
  };

  /** Attachments 增删统一入口：新条目补预览 URL，移除的条目回收 blob */
  const onAttachChange = (fileList: Attachment[]) => {
    const next = fileList.map((it) => {
      const f = it.originFileObj as File | undefined;
      if (f && !it.url && /^(image|video)\//.test(f.type)) return withPreview(f, it.uid);
      return it;
    });
    for (const [uid, url] of blobUrlsRef.current) {
      if (!next.some((it) => it.uid === uid)) {
        URL.revokeObjectURL(url);
        blobUrlsRef.current.delete(uid);
      }
    }
    setAttachItems(next);
  };

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed && !attachItems.length) return;
    setSending(true);
    try {
      // 先上传附件拿到服务端路径，再随消息发出（AI 按路径 Read 查看）
      let attachments: AttachmentInfo[] | undefined;
      if (attachItems.length) {
        attachments = await Promise.all(
          attachItems.map((it) => uploadAttachment(sessionId, it.originFileObj as File)),
        );
      }
      sendWs({ type: 'chat.send', sessionId, text: trimmed, attachments });
      setInput('');
      clearAttachments();
    } catch (e) {
      message.error(`附件上传失败：${(e as Error).message}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="sender-bar">
      <Sender
        value={input}
        onChange={setInput}
        onSubmit={(t) => void sendMessage(t)}
        loading={sending}
        autoSize={{ minRows: 2, maxRows: 8 }}
        placeholder="输入消息，Enter 发送（Shift+Enter 换行）；对话进行中发送会排队；回形针或直接粘贴可添加附件"
        header={
          <Sender.Header
            title="附件"
            open={attachOpen}
            onOpenChange={setAttachOpen}
            closable
          >
            <Attachments
              beforeUpload={() => false}
              items={attachItems}
              onChange={({ fileList }) => onAttachChange(fileList)}
              styles={{
                // 缩略图压到一行高；末尾 + 按钮同高，不再占满卡片尺寸
                file: { height: 40, width: 'auto' },
                upload: { height: 40, width: 40, minWidth: 0 },
              }}
              placeholder={{
                icon: <PaperClipOutlined />,
                title: '点击或拖拽上传',
                description: '支持图片、视频和任意文件，发送时随消息一起上传',
              }}
            />
          </Sender.Header>
        }
        prefix={
          <Button
            type="text"
            icon={<PaperClipOutlined />}
            onClick={() => setAttachOpen((o) => !o)}
            title="添加附件"
          />
        }
        onPasteFile={(files) => {
          // 面板收起时 Attachments 未挂载，ref 是 null —— 直接写入 state 才是可靠路径
          if (!files.length) return;
          const uid = () => `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          setAttachItems((prev) => [...prev, ...Array.from(files).map((f) => withPreview(f, uid()))]);
          setAttachOpen(true);
        }}
      />
    </div>
  );
}
