#!/usr/bin/env bash
# CodeForeman 数据备份：SQLite 在线备份 + 打包数据目录
# 用法：./scripts/backup.sh [数据目录] [备份输出目录]
set -euo pipefail

DATA_DIR=${1:-./data}
OUT_DIR=${2:-./backups}
TS=$(date +%Y%m%d-%H%M%S)

mkdir -p "$OUT_DIR"

# SQLite 在线备份（WAL 下直接 cp 不安全，先落到一致性快照）
if command -v sqlite3 >/dev/null && [ -f "$DATA_DIR/db/codeforeman.db" ]; then
  sqlite3 "$DATA_DIR/db/codeforeman.db" ".backup '$DATA_DIR/db/codeforeman.snapshot.db'"
fi

tar czf "$OUT_DIR/codeforeman-$TS.tar.gz" \
  --exclude='*.snapshot.db' \
  --exclude='data/logs' \
  -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"

rm -f "$DATA_DIR/db/codeforeman.snapshot.db"
echo "备份完成: $OUT_DIR/codeforeman-$TS.tar.gz"

# 只保留最近 30 份
ls -t "$OUT_DIR"/codeforeman-*.tar.gz 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null || true
