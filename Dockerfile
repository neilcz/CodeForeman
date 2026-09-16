# ---------- 构建阶段 ----------
FROM node:22-bookworm-slim AS build
# better-sqlite3 优先用预编译产物，下载失败时回退源码编译
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# 先只拷 package.json，利用层缓存
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm install

COPY packages/ packages/
RUN npm run build && npm prune --omit=dev

# ---------- 运行阶段 ----------
FROM node:22-bookworm-slim

# git：CodeForeman 的 Git Service 与 Claude Code 都依赖
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI（共享凭证通过挂载 /root/.claude 或 ANTHROPIC_API_KEY 注入）
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/package.json ./packages/server/
COPY --from=build /app/packages/web/dist ./packages/web/dist

ENV NODE_ENV=production \
    PORT=3780 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    WEB_DIST=/app/packages/web/dist

EXPOSE 3780
VOLUME ["/data/projects", "/data/db", "/root/.claude"]

CMD ["node", "packages/server/dist/index.js"]
