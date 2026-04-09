
# ⚠️ 明确平台，避免 M1 / x86 混乱
FROM node:18-bullseye-slim

# ===============================
# 1. 换 Debian 国内源（关键）
# ===============================
RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g' /etc/apt/sources.list \
 && sed -i 's|http://security.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' /etc/apt/sources.list


# ===============================
# 1. 系统依赖 + Python 环境
# ===============================
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-venv \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

# 确保 python / pip 命令可用
RUN ln -sf python3 /usr/bin/python && \
    ln -sf pip3 /usr/bin/pip

# ===============================
# 2. Python 依赖（按部署文档）
# ===============================
RUN pip3 install --no-cache-dir \
    nltk \
    jieba

# ===============================
# 3. 下载 NLTK 数据（关键）
# ===============================
# 放在镜像构建期，避免运行时联网失败
RUN python3 - <<'EOF'
import nltk
nltk.download('punkt')
try:
    nltk.download('punkt_tab')
except:
    pass
EOF

# ===============================
# 4. Node + pnpm
# ===============================
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

WORKDIR /opt/etherpad

# ===============================
# 5. 只复制依赖描述文件（缓存友好）
# ===============================
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY admin/package.json ./admin/
COPY ui/package.json ./ui/
COPY src/package.json ./src/
COPY bin/package.json ./bin/

RUN pnpm install --frozen-lockfile

# ===============================
# 6. 拷贝完整源码（包含你本地已 build 的产物）
# ===============================
COPY . .

# ===============================
# 7. 运行环境变量
# ===============================
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1

# ===============================
# 8. 端口 & 启动
# ===============================
EXPOSE 9002

CMD ["pnpm", "--filter", "ep_etherpad-lite", "run", "prod"]