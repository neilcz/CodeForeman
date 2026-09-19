#!/bin/sh
# 容器启动时把宿主机挂载到 /ssh-host 的 SSH key 复制到 /root/.ssh 并修正权限。
# 为什么不能直接挂载 /root/.ssh：
# 1. Docker Desktop 挂载进来的文件属主/权限常不符合 ssh 要求（UNPROTECTED PRIVATE KEY FILE）；
# 2. macOS 的 ~/.ssh/config 常含 UseKeychain 等苹果特有选项，Linux 版 ssh 会直接报错退出。
# 因此只复制私钥/公钥，config 不复制。
if [ -d /ssh-host ]; then
  mkdir -p /root/.ssh
  for f in /ssh-host/id_*; do
    [ -f "$f" ] && cp "$f" /root/.ssh/
  done
  chmod 700 /root/.ssh
  chmod 600 /root/.ssh/id_* 2>/dev/null
  chmod 644 /root/.ssh/*.pub 2>/dev/null
fi
exec "$@"
