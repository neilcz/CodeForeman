/** REST API 客户端：自动附带登录 token，401 时跳转登录页 */

import type { AttachmentInfo } from '@codeforeman/shared';

export function getToken(): string | null {
  return localStorage.getItem('cf_token');
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem('cf_token', token);
  else localStorage.removeItem('cf_token');
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !url.includes('/auth/login')) {
    setToken(null);
    location.href = '/login';
    throw new Error('未登录');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const e = new Error((err as { error?: string }).error ?? res.statusText) as Error & { code?: string };
    // 服务端约定的错误码（如 branch_missing），前端据此走特殊交互
    if ((err as { code?: string }).code) e.code = (err as { code?: string }).code;
    throw e;
  }
  return res.json();
}

export const api = {
  get: <T>(url: string) => req<T>('GET', url),
  post: <T>(url: string, body?: unknown) => req<T>('POST', url, body ?? {}),
  put: <T>(url: string, body?: unknown) => req<T>('PUT', url, body),
  patch: <T>(url: string, body?: unknown) => req<T>('PATCH', url, body),
  del: <T>(url: string) => req<T>('DELETE', url),
};

/** 上传聊天附件：原始字节流 POST（免 multipart），按 MIME 归类图片/视频/文件 */
export async function uploadAttachment(sessionId: string, file: File): Promise<AttachmentInfo> {
  const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file';
  const res = await fetch(
    `/api/sessions/${sessionId}/attachments?name=${encodeURIComponent(file.name)}&kind=${kind}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/octet-stream' },
      body: file,
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json();
}

/** 附件取回 URL：img/a 标签带不了 Authorization 头，走 ?token= 鉴权 */
export function attachmentUrl(sessionId: string, file: string): string {
  return `/api/sessions/${sessionId}/attachments/${encodeURIComponent(file)}?token=${encodeURIComponent(getToken() ?? '')}`;
}
