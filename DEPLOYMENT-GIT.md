# Etherpad Lite Git 部署指南（从零开始）

> 🎯 **本文档适合运维小白**：所有步骤都有详细说明，复制粘贴即可完成部署

---

## 📋 项目信息

| 项目 | 信息 |
|------|------|
| **项目名称** | Etherpad Lite |
| **GitHub 仓库** | `https://github.com/your-org/alic-etherpad-lite.git` |
| **服务器 IP** | `8.138.89.124` |
| **生产环境端口** | `9001` |
| **测试环境端口** | `9002` |
| **数据库** | MySQL (112.74.92.135:3306) |

---

## 🚀 部署策略

**Git 直接部署**：在服务器上直接 `git clone` 代码，无需本地打包上传

**优势**：
- ✅ 版本可追溯（Git 管理）
- ✅ 回滚简单（`git checkout`）
- ✅ 更新快速（`git pull`）
- ✅ 无需本地打包

---

## ⚙️ 环境要求

### 服务器环境检查

```bash

ssh root@8.138.89.124

# 检查 Node.js 版本（需要 >= 18.x）
node -v

# 检查 pnpm 版本（需要 >= 8.x）
pnpm -v

# 检查 PM2 是否安装
pm2 -v

# 检查 Git 是否安装
git --version
```

### 如果环境不满足，请先安装：

```bash
# 安装 Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装 pnpm
npm install -g pnpm

# 安装 PM2
npm install -g pm2

# 安装 Git
sudo apt-get install -y git
```

---

## 📦 首次部署 - 测试环境

### 1️⃣ 克隆代码

```bash
# 进入部署目录
cd /opt

# 1. 生成 key（按提示回车）
ssh-keygen -t ed25519 -C "18811321306@163.com"

# 2. 启动 agent 并加入私钥
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519

# 3. 显示公钥（复制内容到 GitHub）
cat ~/.ssh/id_ed25519.pub

# 4. 测试连接
ssh -T git@github.com

# 克隆代码到测试环境目录
git clone git@github.com:Ruotong2025/alic-etherpad-lite.git etherpad-test

# 进入项目目录
cd etherpad-test

# 切换到 develop 分支（测试环境）
git checkout develop
```


1. ✅ 检测 Python 3 是否安装
2. ✅ 检测并安装 pip
3. ✅ 安装 nltk 库
4. ✅ 安装 jieba 库
5. ✅ 下载 NLTK 数据包
6. ✅ 测试 Python 脚本
7. ✅ 检查 Node.js 依赖



### 方法 2: 手动安装

#### 步骤 1: 安装 Python 3
`
`**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install python3 python3-pip -y
```

**验证安装:**
```bash
python3 --version
# 应该显示 Python 3.6 或更高版本
```

---

#### 步骤 2: 安装 Python 依赖包

```bash
# 安装 nltk（自然语言处理库）
pip3 install nltk

# 安装 jieba（中文分词库）
pip3 install jieba
```

---

#### 步骤 3: 下载 NLTK 数据

```bash
# 方式 1: 使用 Python 命令
python3 -c "import nltk; nltk.download('punkt'); nltk.download('punkt_tab')"

# 方式 2: 使用 NLTK 下载器
python3 -m nltk.downloader punkt punkt_tab
```

---

#### 步骤 4: 验证安装

```bash
python3 -c "
import nltk
import jieba
print('✅ nltk version:', nltk.__version__)
print('✅ jieba version:', jieba.__version__)

# 测试 NLTK 数据
try:
    nltk.data.find('tokenizers/punkt_tab')
    print('✅ punkt_tab 已下载')
except:
    nltk.data.find('tokenizers/punkt')
    print('✅ punkt 已下载')
"
```

---

#### 步骤 5: 安装 Node.js 依赖

```bash
cd /opt/etherpad-test/src
npm install python-shell
cd ..
```

---

## 测试 Python 脚本

### 测试句子分割功能

```bash
# 创建测试输入
echo '{"action":"count_sentences","text":"这是第一句话。This is the second sentence."}' | python3 src/node/scheduler/etherpad_changes/sentence_splitter.py
```

**期望输出：**
```json
{"sentence_count": 2, "success": true}
```

---

### 测试完整任务流程

```bash
# 手动执行定时任务
cd src
node --require tsx/cjs node/scheduler/etherpad-processor.js --process-pad_changes
```


### 2️⃣ 安装依赖

```bash
# 安装所有依赖（包括 devDependencies，因为需要编译前端）
pnpm install

# ⚠️ 如果遇到 pnpm 警告（Failed to create bin...），可以忽略
```

### 3️⃣ 🔥 修复依赖兼容性问题（重要！）

**问题**：`oidc-provider` 依赖的 `eta` 包版本过旧，导致启动报错：
```
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './core' is not defined by "exports"
```

**解决方案**：

```bash
# 进入 src 子目录（monorepo 结构）
cd /opt/etherpad-test/src

# 更新 oidc-provider 和 eta 到最新版本
pnpm add oidc-provider@latest eta@latest

# 返回根目录
cd /opt/etherpad-test

# 更新所有依赖
pnpm update
```

### 4️⃣ 编译前端资源

```bash
# 编译前端（admin 和 ui）
pnpm run build:ui
```

**预期输出**：
```
> etherpad-lite@2.3.2 build /opt/etherpad-test
> pnpm --filter admin run build-copy && pnpm --filter ui run build-copy
```

### 5️⃣ 创建配置文件

```bash
# 创建 settings.json
cat > settings.json << 'EOF'
{
  "title": "Etherpad",
  "favicon": null,
  "skinName": "colibris",
  "skinVariants": "super-light-toolbar super-light-editor light-background",
  "ip": "127.0.0.1",
  "port": 9002,
  "showSettingsInAdminPage": true,
  "dbType": "mysql",
  "dbSettings": {
    "user": "root",
    "host": "112.74.92.135",
    "port": 3306,
    "password": "1q2w3e4R",
    "database": "alic",
    "charset": "utf8mb4"
  },
  "defaultPadText": "Welcome to Etherpad!\n\nThis pad text is synchronized as you type, so that everyone viewing this page sees the same text. This allows you to collaborate seamlessly on documents!\n\nGet involved with Etherpad at https://etherpad.org\n",
  "padOptions": {
    "noColors": false,
    "showControls": true,
    "showChat": true,
    "showLineNumbers": true,
    "useMonospaceFont": false,
    "userName": null,
    "userColor": null,
    "rtl": false,
    "alwaysShowChat": false,
    "chatAndUsers": false,
    "lang": null
  },
  "padShortcutEnabled": {
    "altF9": true,
    "altC": true,
    "cmdShift2": true,
    "delete": true,
    "return": true,
    "esc": true,
    "cmdS": true,
    "tab": true,
    "cmdZ": true,
    "cmdY": true,
    "cmdI": true,
    "cmdB": true,
    "cmdU": true,
    "cmd5": true,
    "cmdShiftL": true,
    "cmdShiftN": true,
    "cmdShift1": true,
    "cmdShiftC": true,
    "cmdH": true,
    "ctrlHome": true,
    "pageUp": true,
    "pageDown": true
  },
  "suppressErrorsInPadText": false,
  "requireSession": false,
  "editOnly": false,
  "minify": true,
  "maxAge": 21600,
  "abiword": null,
  "soffice": null,
  "tidyHtml": null,
  "allowUnknownFileEnds": true,
  "requireAuthentication": false,
  "requireAuthorization": false,
  "trustProxy": true,
  "cookie": {
    "sameSite": "Lax"
  },
  "disableIPlogging": false,
  "automaticReconnectionTimeout": 0,
  "scrollWhenFocusLineIsOutOfViewport": {
    "percentage": {
      "editionAboveViewport": 0,
      "editionBelowViewport": 0
    },
    "duration": 0,
    "scrollWhenCaretIsInTheLastLineOfViewport": false,
    "percentageToScrollWhenUserPressesArrowUp": 0
  },
  "users": {},
  "socketTransportProtocols": ["websocket", "polling"],
  "socketIo": {
    "maxHttpBufferSize": 10000
  },
  "loadTest": false,
  "dumpOnUncleanExit": false,
  "indentationOnNewLine": false,
  "importExportRateLimiting": {
    "windowMs": 90000,
    "max": 10
  },
  "importMaxFileSize": 52428800,
  "commitRateLimiting": {
    "duration": 1,
    "points": 10
  },
  "exposeVersion": false,
  "loglevel": "INFO",
  "logconfig": {
    "appenders": {
      "console": {
        "type": "console"
      }
    },
    "categories": {
      "default": {
        "appenders": ["console"],
        "level": "info"
      }
    }
  },
  "plugins": {
    "ep_etherpad-lite": {
      "oauth2": false
    }
  },
  "customLocaleStrings": {},
  "enableAdminUITests": false
}
EOF
```

### 6️⃣ 创建 PM2 配置文件

```bash
# 创建 ecosystem.config.cjs
cat > ecosystem.config.cjs << 'EOF'
module.exports = {
  apps: [{
    name: 'etherpad-test',
    script: 'src/node/server.ts',
    interpreter: 'node',
    interpreterArgs: '--require tsx/cjs',
    cwd: '/opt/etherpad-test',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    },
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
EOF
```

**配置说明**：
- `script: 'src/node/server.ts'`：直接运行 TypeScript 源码
- `interpreter: 'node'` + `interpreterArgs: '--require tsx/cjs'`：使用 `tsx` 运行时编译
- `exec_mode: 'fork'` + `instances: 1`：使用 fork 模式（避免 cluster 模式问题）

### 7️⃣ 启动服务

```bash
# 创建日志目录
mkdir -p logs

# 启动 PM2
pm2 start ecosystem.config.cjs

# 查看状态
pm2 list

# 查看日志（确认启动成功）
pm2 logs etherpad-test --lines 50
```

**预期输出**：
```
[INFO] http - HTTP server listening for connections
[INFO] settings - You can access your Etherpad instance at http://127.0.0.1:9002/
[INFO] server - Etherpad is running
```

### 8️⃣ 测试访问

```bash
# 在服务器上测试
curl http://127.0.0.1:9002

# 如果返回 HTML，说明启动成功
```

---

## 📦 首次部署 - 生产环境

### 1️⃣ 克隆代码

```bash
# 进入部署目录
cd /opt

# 克隆代码到生产环境目录
git clone https://github.com/your-org/alic-etherpad-lite.git etherpad-prod

# 进入项目目录
cd etherpad-prod

# 切换到 main 分支（生产环境）
git checkout main
```

### 2️⃣ 安装依赖

```bash
# 安装所有依赖
pnpm install
```

### 3️⃣ 🔥 修复依赖兼容性问题

```bash
# 进入 src 子目录
cd /opt/etherpad-prod/src

# 更新 oidc-provider 和 eta
pnpm add oidc-provider@latest eta@latest

# 返回根目录
cd /opt/etherpad-prod

# 更新所有依赖
pnpm update
```

### 4️⃣ 编译前端资源

```bash
# 编译前端
pnpm run build
```

### 5️⃣ 创建配置文件

```bash



cat > package.json << 'EOF'
{
  "name": "etherpad",
  "description": "A free and open source realtime collaborative editor",
  "homepage": "https://etherpad.org",
  "type": "module",
  "keywords": [
    "etherpad",
    "realtime",
    "collaborative",
    "editor"
  ],
  "bin": {
    "etherpad-healthcheck": "bin/etherpad-healthcheck"
  },
  "scripts": {
    "lint": "pnpm --filter ep_etherpad-lite run lint",
    "test": "pnpm --filter ep_etherpad-lite run test",
    "test-utils": "pnpm --filter ep_etherpad-lite run test-utils",
    "test-container": "pnpm --filter ep_etherpad-lite run test-container",
    "dev": "pnpm --filter ep_etherpad-lite run dev",
    "prod": "pnpm --filter ep_etherpad-lite run prod",
    "ts-check": "pnpm --filter ep_etherpad-lite run ts-check",
    "ts-check:watch": "pnpm --filter ep_etherpad-lite run ts-check:watch",
    "test-ui": "pnpm --filter ep_etherpad-lite run test-ui",
    "test-ui:ui": "pnpm --filter ep_etherpad-lite run test-ui:ui",
    "test-admin": "pnpm --filter ep_etherpad-lite run test-admin",
    "test-admin:ui": "pnpm --filter ep_etherpad-lite run test-admin:ui",
    "plugins": "pnpm --filter bin run plugins",
    "install-plugins": "pnpm --filter bin run plugins i",
    "remove-plugins": "pnpm --filter bin run remove-plugins",
    "list-plugins": "pnpm --filter bin run list-plugins",
    "build:etherpad": "pnpm --filter admin run build-copy && pnpm --filter ui run build-copy",
    "build:ui": "pnpm --filter ui run build-copy && pnpm --filter admin run build-copy",
    "makeDocs": "pnpm --filter bin run makeDocs"
  },
  "dependencies": {
    "diff-match-patch": "^1.0.5",
    "ep_etherpad-lite": "workspace:./src",
    "python-shell": "^5.0.0"
  },
  "devDependencies": {
    "admin": "workspace:./admin",
    "docs": "workspace:./doc",
    "ui": "workspace:./ui"
  },
  "engines": {
    "node": ">=18.18.2",
    "npm": ">=6.14.0",
    "pnpm": ">=8.3.0"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/Ruotong2025/alic-etherpad-lite.git"
  },
  "overrides": {
    "eta": "2.0.0"
  },
  "version": "2.3.2",
  "license": "Apache-2.0"
}
EOF


# 创建 settings.json
cat > settings.json << 'EOF'
{
  "title": "Etherpad - 生产环境",
  "favicon": null,
  "skinName": "colibris",
  "skinVariants": "super-light-toolbar super-light-editor light-background",
  "ip": "127.0.0.1",
  "port": 9001,
  "showSettingsInAdminPage": true,
  "dbType": "mysql",
  "dbSettings": {
    "user": "root",
    "host": "112.74.92.135",
    "port": 3306,
    "password": "1q2w3e4R",
    "database": "alic",
    "charset": "utf8mb4"
  },
  "trustProxy": true,
  "loglevel": "INFO",
  "logconfig": {
    "appenders": {
      "console": {
        "type": "console"
      }
    },
    "categories": {
      "default": {
        "appenders": ["console"],
        "level": "info"
      }
    }
  },
  "authenticationMethod": "sso",
  "sso": {
    "issuer": "http://8.138.89.124:9001",
    "clients": []
  }
}
EOF
```

### 6️⃣ 创建 PM2 配置文件

```bash
# 创建 ecosystem.config.cjs
cat > ecosystem.config.cjs << 'EOF'
module.exports = {
  apps: [{
    name: 'etherpad-prod',
    script: 'src/node/server.ts',
    interpreter: 'node',
    interpreterArgs: '--require tsx/cjs',
    cwd: '/opt/etherpad-prod',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '2G',
    env: {
      NODE_ENV: 'production'
    },
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
EOF
```

### 7️⃣ 启动服务

```bash
# 创建日志目录
mkdir -p logs

# 启动 PM2
pm2 start ecosystem.config.cjs

# 查看状态
pm2 list

# 查看日志
pm2 logs etherpad-prod --lines 50
```

### 8️⃣ 保存 PM2 配置（开机自启）

```bash
# 保存 PM2 进程列表
pm2 save

# 设置开机自启
pm2 startup
# 按照提示执行命令（通常是 sudo 开头的命令）
```

---

## 🌐 配置 Nginx 反向代理

### 测试环境 Nginx 配置

```bash
sudo nano /etc/nginx/sites-available/etherpad-test
```

**配置内容**：

```nginx
server {
    listen 8080;
    server_name _;
    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:9002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }
}
```




**启用配置**：

```bash
# 创建软链接
sudo ln -s /etc/nginx/sites-available/etherpad-test /etc/nginx/sites-enabled/

# 测试配置
sudo nginx -t

# 重载 Nginx
sudo systemctl reload nginx
```

### 生产环境 Nginx 配置

```bash
sudo nano /etc/nginx/sites-available/etherpad-prod
```

**配置内容**：

```nginx
server {
    listen 80;
    server_name _;
    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:9001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }
}
```

**启用配置**：

```bash
# 创建软链接
sudo ln -s /etc/nginx/sites-available/etherpad-prod /etc/nginx/sites-enabled/

# 测试配置
sudo nginx -t

# 重载 Nginx
sudo systemctl reload nginx
```

---

## 🔄 日常更新部署

### 测试环境更新

```bash
# 进入项目目录
cd /opt/etherpad-test

# 停止服务
pm2 stop etherpad-test

# 拉取最新代码
git pull origin develop

# 安装/更新依赖
pnpm install

# 编译前端
pnpm run build

# 启动服务
pm2 start etherpad-test

# 查看日志
pm2 logs etherpad-test --lines 50
```

### 生产环境更新

```bash
# 进入项目目录
cd /opt/etherpad-prod

# 停止服务
pm2 stop etherpad-prod

# 拉取最新代码
git pull origin main

# 安装/更新依赖
pnpm install

# 编译前端
pnpm run build

# 启动服务
pm2 start etherpad-prod

# 查看日志
pm2 logs etherpad-prod --lines 50
```

---

## 🔧 常用命令

### PM2 命令

```bash
# 查看所有进程
pm2 list

# 查看日志（实时）
pm2 logs etherpad-test

# 查看最近 100 行日志
pm2 logs etherpad-test --lines 100

# 停止服务
pm2 stop etherpad-test

# 启动服务
pm2 start etherpad-test

# 重启服务
pm2 restart etherpad-test

# 删除进程
pm2 delete etherpad-test

# 清空日志
pm2 flush

# 监控
pm2 monit
```

### Git 命令

```bash
# 查看当前分支
git branch

# 查看当前状态
git status

# 查看提交历史
git log --oneline -10

# 切换分支
git checkout develop

# 拉取最新代码
git pull

# 回滚到指定版本
git checkout <commit-hash>
```

### 依赖管理

```bash
# 安装依赖
pnpm install

# 更新所有依赖
pnpm update

# 清理缓存
pnpm store prune

# 查看依赖树
pnpm list --depth=1
```

---

## 🚨 遇到问题时的完整重装步骤

### 测试环境完整重装

```bash
# 1. 停止并删除 PM2 进程
pm2 stop etherpad-test
pm2 delete etherpad-test
pm2 save

# 2. 删除旧目录
cd /opt
rm -rf etherpad-test

# 3. 重新克隆代码
git clone https://github.com/your-org/alic-etherpad-lite.git etherpad-test
cd etherpad-test
git checkout develop

# 4. 安装依赖
pnpm install

# 5. 🔥 修复依赖兼容性（重要！）
cd src
pnpm add oidc-provider@latest eta@latest
cd ..
pnpm update

# 6. 编译前端
pnpm run build

# 7. 创建配置文件（复制上面的 settings.json 和 ecosystem.config.cjs）
cat > settings.json << 'EOF'
{
  "title": "Etherpad - 测试环境 [TEST]",
  "favicon": null,
  "skinName": "colibris",
  "skinVariants": "super-light-toolbar super-light-editor light-background",
  "ip": "127.0.0.1",
  "port": 9002,
  "showSettingsInAdminPage": true,
  "dbType": "mysql",
  "dbSettings": {
    "user": "root",
    "host": "112.74.92.135",
    "port": 3306,
    "password": "1q2w3e4R",
    "database": "alic",
    "charset": "utf8mb4"
  },
  "trustProxy": true,
  "loglevel": "INFO",
  "logconfig": {
    "appenders": {
      "console": {
        "type": "console"
      }
    },
    "categories": {
      "default": {
        "appenders": ["console"],
        "level": "info"
      }
    }
  },
  "authenticationMethod": "sso",
  "sso": {
    "issuer": "http://8.138.89.124:9002",
    "clients": []
  }
}
EOF

cat > ecosystem.config.cjs << 'EOF'
module.exports = {
  apps: [{
    name: 'etherpad-test',
    script: 'src/node/server.ts',
    interpreter: 'node',
    interpreterArgs: '--require tsx/cjs',
    cwd: '/opt/etherpad-test',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    },
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
EOF

# 8. 创建日志目录
mkdir -p logs

# 9. 启动服务
pm2 start ecosystem.config.cjs

# 10. 查看日志确认启动成功
pm2 logs etherpad-test --lines 50
```

### 生产环境完整重装

```bash
# 1. 停止并删除 PM2 进程
pm2 stop etherpad-prod
pm2 delete etherpad-prod
pm2 save

# 2. 删除旧目录
cd /opt
rm -rf etherpad-prod

# 3. 重新克隆代码
git clone https://github.com/your-org/alic-etherpad-lite.git etherpad-prod
cd etherpad-prod
git checkout main

# 4. 安装依赖
pnpm install

# 5. 🔥 修复依赖兼容性（重要！）
cd src
pnpm add oidc-provider@latest eta@latest
cd ..
pnpm update

# 6. 编译前端
pnpm run build

# 7. 创建配置文件
cat > settings.json << 'EOF'
{
  "title": "Etherpad - 生产环境",
  "favicon": null,
  "skinName": "colibris",
  "skinVariants": "super-light-toolbar super-light-editor light-background",
  "ip": "127.0.0.1",
  "port": 9001,
  "showSettingsInAdminPage": true,
  "dbType": "mysql",
  "dbSettings": {
    "user": "root",
    "host": "112.74.92.135",
    "port": 3306,
    "password": "1q2w3e4R",
    "database": "alic",
    "charset": "utf8mb4"
  },
  "trustProxy": true,
  "loglevel": "INFO",
  "logconfig": {
    "appenders": {
      "console": {
        "type": "console"
      }
    },
    "categories": {
      "default": {
        "appenders": ["console"],
        "level": "info"
      }
    }
  },
  "authenticationMethod": "sso",
  "sso": {
    "issuer": "http://8.138.89.124:9001",
    "clients": []
  }
}
EOF

cat > ecosystem.config.cjs << 'EOF'
module.exports = {
  apps: [{
    name: 'etherpad-prod',
    script: 'src/node/server.ts',
    interpreter: 'node',
    interpreterArgs: '--require tsx/cjs',
    cwd: '/opt/etherpad-prod',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '2G',
    env: {
      NODE_ENV: 'production'
    },
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
EOF

# 8. 创建日志目录
mkdir -p logs

# 9. 启动服务
pm2 start ecosystem.config.cjs

# 10. 查看日志确认启动成功
pm2 logs etherpad-prod --lines 50

# 11. 保存 PM2 配置
pm2 save
```

---

## ✅ 部署完成检查清单

### 测试环境

- [ ] 代码已克隆到 `/opt/etherpad-test`
- [ ] 依赖已安装（`pnpm install`）
- [ ] 依赖兼容性已修复（`oidc-provider` 和 `eta` 已更新）
- [ ] 前端已编译（`pnpm run build`）
- [ ] `settings.json` 已创建（端口 9002）
- [ ] `ecosystem.config.cjs` 已创建
- [ ] PM2 进程状态为 `online`
- [ ] 日志中显示 `Etherpad is running`
- [ ] 无 `ERR_PACKAGE_PATH_NOT_EXPORTED` 错误
- [ ] `curl http://127.0.0.1:9002` 返回 HTML
- [ ] Nginx 配置已启用

### 生产环境

- [ ] 代码已克隆到 `/opt/etherpad-prod`
- [ ] 依赖已安装（`pnpm install`）
- [ ] 依赖兼容性已修复（`oidc-provider` 和 `eta` 已更新）
- [ ] 前端已编译（`pnpm run build`）
- [ ] `settings.json` 已创建（端口 9001）
- [ ] `ecosystem.config.cjs` 已创建
- [ ] PM2 进程状态为 `online`
- [ ] 日志中显示 `Etherpad is running`
- [ ] 无 `ERR_PACKAGE_PATH_NOT_EXPORTED` 错误
- [ ] `curl http://127.0.0.1:9001` 返回 HTML
- [ ] Nginx 配置已启用
- [ ] PM2 已保存（`pm2 save`）
- [ ] 开机自启已设置（`pm2 startup`）

---

## 🔍 常见问题排查

### 问题 1：`ERR_PACKAGE_PATH_NOT_EXPORTED` 错误

**症状**：
```
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './core' is not defined by "exports" in /opt/etherpad-test/node_modules/eta/package.json
```

**原因**：`oidc-provider` 依赖的 `eta` 包版本过旧，与 Node.js 18+ 不兼容

**解决方案**：
```bash
cd /opt/etherpad-test
cd src
pnpm add oidc-provider@latest eta@latest
cd ..
pnpm update
pm2 restart etherpad-test
```

### 问题 2：PM2 进程状态为 `errored`

**排查步骤**：
```bash
# 1. 查看日志
pm2 logs etherpad-test --lines 100

# 2. 如果是依赖问题，重新安装
cd /opt/etherpad-test
rm -rf node_modules src/node_modules
pnpm install

# 3. 修复依赖兼容性
cd src
pnpm add oidc-provider@latest eta@latest
cd ..
pnpm update

# 4. 删除旧进程，重新启动
pm2 delete etherpad-test
pm2 start ecosystem.config.cjs
```

### 问题 3：端口被占用

**症状**：
```
Error: listen EADDRINUSE: address already in use :::9002
```

**解决方案**：
```bash
# 查找占用端口的进程
lsof -i :9002

# 杀死进程
kill -9 <PID>

# 或者停止所有 PM2 进程
pm2 kill
pm2 start ecosystem.config.cjs
```

### 问题 4：Git 冲突

**症状**：
```
error: Your local changes to the following files would be overwritten by merge
```

**解决方案**：
```bash
# 方案 1：保存本地修改
git stash
git pull
git stash pop

# 方案 2：放弃本地修改
git reset --hard
git pull
```

### 问题 5：前端资源未更新

**症状**：页面样式或功能不正常

**解决方案**：
```bash
cd /opt/etherpad-test

# 清理旧的编译文件
rm -rf src/static/dist admin/dist ui/dist

# 重新编译
pnpm run build

# 重启服务
pm2 restart etherpad-test
```

---

## 📝 注意事项

1. **依赖兼容性修复是必须的**：每次重新安装都要执行 `pnpm add oidc-provider@latest eta@latest`
2. **PM2 配置使用 fork 模式**：`exec_mode: 'fork'` 和 `instances: 1` 是必须的，不要改为 cluster 模式
3. **TypeScript 运行时编译**：项目使用 `tsx` 直接运行 `.ts` 文件，不需要编译成 `.js`
4. **前端必须编译**：`pnpm run build` 是必须的，用于编译 admin 和 ui 前端资源
5. **日志目录**：确保 `logs/` 目录存在，否则 PM2 无法写入日志
6. **数据库连接**：确保服务器能访问 `112.74.92.135:3306`
7. **SSO 配置**：`sso.issuer` 必须与实际访问地址一致

---

## 📞 联系支持

如果遇到问题，请提供以下信息：

1. **PM2 日志**：`pm2 logs etherpad-test --lines 100`
2. **环境信息**：`node -v && pnpm -v && pm2 -v`
3. **Git 状态**：`git status && git log --oneline -5`
4. **错误截图**：完整的错误堆栈信息

---

**祝部署顺利！🎉**
