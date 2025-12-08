# Etherpad 协同编辑器部署文档

## 一、测试环境部署

### 1. 购买服务器
购买云服务器（如 AWS EC2、阿里云 ECS 等）
- 建议配置：2核4G及以上
- 操作系统：Ubuntu 22.04 LTS

### 2. 创建VPC，配置子网，配置安全组
#### 2.1 创建VPC
在云服务商控制台创建VPC网络

#### 2.2 创建子网
创建公有子网和私有子网

#### 2.3 配置安全组，开放端口
开放以下端口，对外提供服务：
- 80 (HTTP)
- 443 (HTTPS)
- 22 (SSH)
- 9001 (Etherpad默认端口，可选，建议通过nginx代理访问)

```bash
# 示例：配置防火墙规则
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### 3. 配置数据库防火墙
如使用独立的数据库服务器，需配置数据库防火墙，允许Etherpad服务器IP入站访问

**测试连接：**
```bash
# 从Etherpad服务器测试数据库连接
mysql -h <数据库地址> -u <用户名> -p
```

### 4. 数据库建表
Etherpad使用MySQL数据库，需要创建数据库和必要的表结构。

#### 4.1 创建数据库
```sql
CREATE DATABASE IF NOT EXISTS etherpad CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

#### 4.2 Etherpad表结构
Etherpad会在首次启动时自动创建必要的表结构，包括：
- `store` - 存储pad数据
- `session` - 存储会话信息

**注意：** Etherpad支持自动建表，无需手动创建表结构。

### 5. 测试数据库连接
从Etherpad服务器测试是否能访问数据库：
```bash
mysql -h <数据库地址> -P 3306 -u <用户名> -p<密码> -e "USE etherpad; SHOW TABLES;"
```

### 6. 部署Node.js和Nginx

#### 6.1 安装Node.js
Etherpad要求 Node.js >= 18.18.2

```bash
# 更新系统
sudo apt update
sudo apt upgrade -y

# 安装Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# 验证安装
node -v  # 应该显示 v18.x.x
npm -v

# 安装pnpm
npm install -g pnpm
pnpm -v
```

#### 6.2 安装Nginx
```bash
sudo apt update
sudo apt install nginx -y

# 启动nginx
sudo systemctl start nginx
sudo systemctl enable nginx

# 检查nginx状态
sudo systemctl status nginx
```

### 7. 申请域名
申请测试环境域名，例如：`etherpad-test.alicedu.net`

### 8. 解析域名
在域名服务商（如 Route 53、阿里云DNS等）配置A记录，将域名指向服务器公网IP

```
类型: A
主机记录: etherpad-test
记录值: <服务器公网IP>
TTL: 600
```

### 9. 申请SSL证书
在阿里云或AWS ACM申请免费SSL证书
- 域名：`etherpad-test.alicedu.net`
- 验证方式：DNS验证或文件验证

### 10. 配置SSL证书

#### 10.1 在DNS配置解析记录，等待证书签发
按照证书服务商要求添加DNS验证记录，等待证书签发（通常5-30分钟）

#### 10.2 将证书上传到服务器
```bash
# 从本地上传证书到服务器（Mac/Linux）
scp -i <your-key.pem> /path/to/etherpad-test.alicedu.net.key ubuntu@<服务器IP>:/tmp
scp -i <your-key.pem> /path/to/etherpad-test.alicedu.net.pem ubuntu@<服务器IP>:/tmp

# Windows使用WinSCP或其他工具上传
```

#### 10.3 将证书放在指定位置
```bash
# SSH登录服务器后执行
sudo mkdir -p /etc/nginx/ssl/etherpad-test.alicedu.net
cd /etc/nginx/ssl/etherpad-test.alicedu.net
sudo cp /tmp/etherpad-test.alicedu.net.pem etherpad-test.alicedu.net.pem
sudo cp /tmp/etherpad-test.alicedu.net.key etherpad-test.alicedu.net.key
sudo chmod 600 /etc/nginx/ssl/etherpad-test.alicedu.net/*
sudo chown root:root /etc/nginx/ssl/etherpad-test.alicedu.net/*
```

### 11. 部署Etherpad服务

#### 11.1 创建服务用户
```bash
# 创建专用用户运行etherpad
sudo useradd -m -s /bin/bash etherpad

# （可选）给该用户设置密码
sudo passwd etherpad
```

#### 11.2 部署代码到服务器
```bash
# 方式一：从GitHub克隆代码
sudo mkdir -p /home/etherpad/app
sudo chown etherpad:etherpad /home/etherpad/app
cd /home/etherpad/app
sudo -u etherpad git clone https://github.com/Ruotong2025/alic-etherpad-lite.git .

# 方式二：从本地打包上传
# 本地执行打包
tar -czf etherpad-app.tar.gz --exclude=node_modules --exclude=.git .

# 上传到服务器
scp -i <your-key.pem> etherpad-app.tar.gz ubuntu@<服务器IP>:/tmp

# 在服务器上解压
sudo mkdir -p /home/etherpad/app
sudo tar -xzf /tmp/etherpad-app.tar.gz -C /home/etherpad/app
sudo chown -R etherpad:etherpad /home/etherpad/app
```

#### 11.3 配置环境文件
创建测试环境配置文件 `settings.test.json`：

```bash
sudo -u etherpad nano /home/etherpad/app/settings.test.json
```

配置内容示例：
```json
{
  "title": "Etherpad Test",
  "favicon": null,
  "skinName": "colibris",
  "skinVariants": "super-light-toolbar super-light-editor light-background",
  "ip": "0.0.0.0",
  "port": 9001,
  "showSettingsInAdminPage": true,
  "dbType": "mysql",
  "dbSettings": {
    "user": "etherpad_user",
    "host": "<数据库地址>",
    "port": 3306,
    "password": "<数据库密码>",
    "database": "etherpad_test",
    "charset": "utf8mb4"
  },
  "defaultPadText": "Welcome to Etherpad!\\n\\nStart collaborating now!",
  "requireSession": false,
  "editOnly": false,
  "minify": true,
  "maxAge": 21600,
  "trustProxy": true,
  "cookie": {
    "sameSite": "Lax"
  },
  "loglevel": "INFO",
  "logconfig": {
    "appenders": {
      "console": { "type": "console" },
      "file": {
        "type": "file",
        "filename": "/home/etherpad/logs/etherpad.log",
        "maxLogSize": 10485760,
        "backups": 3,
        "compress": true
      }
    },
    "categories": {
      "default": {
        "appenders": ["console", "file"],
        "level": "info"
      }
    }
  }
}
```

#### 11.4 安装依赖
```bash
cd /home/etherpad/app
sudo -u etherpad pnpm install

# 构建前端资源
sudo -u etherpad pnpm run build:etherpad
```

#### 11.5 测试启动服务
```bash
cd /home/etherpad/app
sudo -u etherpad pnpm run prod -- --settings settings.test.json

# 测试服务是否正常
curl http://localhost:9001

# 如果正常，Ctrl+C停止服务
```

#### 11.6 创建Systemd服务配置
```bash
sudo nano /etc/systemd/system/etherpad-test.service
```

配置内容：
```ini
[Unit]
Description=Etherpad Collaborative Editor - Test Environment
After=network.target mysql.service

[Service]
Type=simple
User=etherpad
WorkingDirectory=/home/etherpad/app
Environment="NODE_ENV=production"
ExecStart=/usr/bin/pnpm run prod -- --settings /home/etherpad/app/settings.test.json
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

# 安全配置
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/home/etherpad/app /home/etherpad/logs

[Install]
WantedBy=multi-user.target
```

#### 11.7 启动服务
```bash
# 重新加载systemd配置
sudo systemctl daemon-reload

# 启用开机自启
sudo systemctl enable etherpad-test

# 启动服务
sudo systemctl start etherpad-test

# 查看服务状态
sudo systemctl status etherpad-test
```

#### 11.8 查看日志
```bash
# 查看服务状态
sudo systemctl status etherpad-test

# 实时查看日志
sudo journalctl -u etherpad-test -f

# 查看最近100行日志
sudo journalctl -u etherpad-test -n 100
```

### 12. 配置Nginx反向代理

#### 12.1 创建Nginx配置文件
```bash
sudo nano /etc/nginx/sites-available/etherpad-test
```

配置内容：
```nginx
# HTTP 端口监听，自动跳转到 HTTPS
server {
    listen 80;
    server_name etherpad-test.alicedu.net;

    # 自动重定向到 HTTPS
    return 301 https://$host$request_uri;
}

# HTTPS 配置
server {
    listen 443 ssl http2;
    server_name etherpad-test.alicedu.net;

    # SSL证书配置
    ssl_certificate /etc/nginx/ssl/etherpad-test.alicedu.net/etherpad-test.alicedu.net.pem;
    ssl_certificate_key /etc/nginx/ssl/etherpad-test.alicedu.net/etherpad-test.alicedu.net.key;

    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # 日志配置
    access_log /var/log/nginx/etherpad-test.access.log;
    error_log /var/log/nginx/etherpad-test.error.log;

    # 客户端上传大小限制
    client_max_body_size 50M;

    # 代理到Etherpad服务
    location / {
        proxy_pass http://localhost:9001;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 超时设置
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        send_timeout 60s;
    }

    # Socket.IO支持
    location /socket.io/ {
        proxy_pass http://localhost:9001/socket.io/;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 超时设置
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
```

#### 12.2 启用配置并重启Nginx
```bash
# 创建软链接启用配置
sudo ln -s /etc/nginx/sites-available/etherpad-test /etc/nginx/sites-enabled/

# 测试nginx配置
sudo nginx -t

# 重新加载nginx配置
sudo systemctl reload nginx

# 如果有错误，查看错误日志
sudo tail -f /var/log/nginx/error.log
```

### 13. 验证服务

#### 13.1 测试域名访问
```bash
# 测试HTTP重定向
curl -I http://etherpad-test.alicedu.net

# 测试HTTPS访问
curl -I https://etherpad-test.alicedu.net
```

#### 13.2 浏览器访问测试
1. 打开浏览器访问：`https://etherpad-test.alicedu.net`
2. 验证SSL证书是否正常
3. 创建一个新的pad，测试协同编辑功能
4. 测试多用户实时协同编辑

#### 13.3 功能测试清单
- [ ] 页面正常加载
- [ ] 创建新pad
- [ ] 文本编辑和格式化
- [ ] 多用户实时协同
- [ ] 聊天功能
- [ ] 导入/导出功能
- [ ] 历史版本查看（时间滑块）

---

## 二、正式环境部署

### 部署前准备工作

**第一次部署生产环境前的检查清单：**

1. ✓ 确认测试环境运行稳定
2. ✓ 备份当前生产环境数据（如有）
3. ✓ 确认生产环境配置文件中的数据库配置正确
4. ✓ 确认生产环境使用不同的端口（如9002）避免冲突
5. ✓ 通知用户服务升级时间窗口

### 部署操作步骤

### 5. 正式环境数据库建表

#### 5.1 创建生产数据库
```sql
CREATE DATABASE IF NOT EXISTS etherpad_prod CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 创建专用数据库用户（推荐）
CREATE USER 'etherpad_prod'@'%' IDENTIFIED BY '<强密码>';
GRANT ALL PRIVILEGES ON etherpad_prod.* TO 'etherpad_prod'@'%';
FLUSH PRIVILEGES;
```

### 6. 测试数据库连接
从Etherpad生产服务器测试是否能访问生产数据库：
```bash
mysql -h <生产数据库地址> -P 3306 -u etherpad_prod -p -e "USE etherpad_prod; SHOW TABLES;"
```

### 7. 申请生产域名
申请生产环境域名，例如：`etherpad.alicedu.net`

### 8. 解析域名
在域名服务商配置A记录，将生产域名指向服务器公网IP
```
类型: A
主机记录: etherpad
记录值: <服务器公网IP>
TTL: 600
```

### 9. 申请SSL证书
在阿里云或AWS ACM申请生产环境SSL证书
- 域名：`etherpad.alicedu.net`
- 验证方式：DNS验证

### 10. 配置SSL证书

#### 10.1 在DNS配置解析记录，等待证书签发
按照证书服务商要求添加DNS验证记录

#### 10.2 将证书上传到服务器
```bash
# 从本地上传证书到服务器
scp -i <your-key.pem> /path/to/etherpad.alicedu.net.key ubuntu@<服务器IP>:/tmp
scp -i <your-key.pem> /path/to/etherpad.alicedu.net.pem ubuntu@<服务器IP>:/tmp
```

#### 10.3 将证书放在指定位置
```bash
sudo mkdir -p /etc/nginx/ssl/etherpad.alicedu.net
cd /etc/nginx/ssl/etherpad.alicedu.net
sudo cp /tmp/etherpad.alicedu.net.pem etherpad.alicedu.net.pem
sudo cp /tmp/etherpad.alicedu.net.key etherpad.alicedu.net.key
sudo chmod 600 /etc/nginx/ssl/etherpad.alicedu.net/*
sudo chown root:root /etc/nginx/ssl/etherpad.alicedu.net/*
```

### 11. 部署Etherpad生产服务

#### 11.1 创建生产环境目录
```bash
sudo mkdir -p /home/etherpad/app-prod
sudo chown etherpad:etherpad /home/etherpad/app-prod
```

#### 11.2 部署生产代码
```bash
# 方式一：从GitHub克隆代码（生产环境建议使用特定版本tag）
cd /home/etherpad/app-prod
sudo -u etherpad git clone -b master https://github.com/Ruotong2025/alic-etherpad-lite.git .

# 方式二：从测试环境复制
sudo cp -r /home/etherpad/app/* /home/etherpad/app-prod/
sudo chown -R etherpad:etherpad /home/etherpad/app-prod
```

#### 11.3 配置生产环境文件
创建生产环境配置文件 `settings.prod.json`：

```bash
sudo -u etherpad nano /home/etherpad/app-prod/settings.prod.json
```

配置内容示例：
```json
{
  "title": "Etherpad",
  "favicon": null,
  "skinName": "colibris",
  "skinVariants": "super-light-toolbar super-light-editor light-background",
  "ip": "0.0.0.0",
  "port": 9002,
  "showSettingsInAdminPage": false,
  "dbType": "mysql",
  "dbSettings": {
    "user": "etherpad_prod",
    "host": "<生产数据库地址>",
    "port": 3306,
    "password": "<生产数据库密码>",
    "database": "etherpad_prod",
    "charset": "utf8mb4"
  },
  "defaultPadText": "Welcome to Etherpad!\\n\\nStart collaborating now!",
  "requireSession": false,
  "editOnly": false,
  "minify": true,
  "maxAge": 86400,
  "trustProxy": true,
  "cookie": {
    "sameSite": "Lax",
    "secure": true
  },
  "disableIPlogging": false,
  "loglevel": "WARN",
  "logconfig": {
    "appenders": {
      "file": {
        "type": "file",
        "filename": "/home/etherpad/logs/etherpad-prod.log",
        "maxLogSize": 52428800,
        "backups": 10,
        "compress": true
      }
    },
    "categories": {
      "default": {
        "appenders": ["file"],
        "level": "warn"
      }
    }
  },
  "exposeVersion": false
}
```

#### 11.4 安装依赖并构建
```bash
cd /home/etherpad/app-prod
sudo -u etherpad pnpm install --prod
sudo -u etherpad pnpm run build:etherpad
```

#### 11.5 测试启动生产服务
```bash
cd /home/etherpad/app-prod
sudo -u etherpad pnpm run prod -- --settings settings.prod.json

# 测试服务
curl http://localhost:9002

# 如果正常，Ctrl+C停止
```

#### 11.6 创建生产环境Systemd服务
```bash
sudo nano /etc/systemd/system/etherpad-prod.service
```

配置内容：
```ini
[Unit]
Description=Etherpad Collaborative Editor - Production Environment
After=network.target mysql.service

[Service]
Type=simple
User=etherpad
WorkingDirectory=/home/etherpad/app-prod
Environment="NODE_ENV=production"
ExecStart=/usr/bin/pnpm run prod -- --settings /home/etherpad/app-prod/settings.prod.json
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

# 安全配置
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/home/etherpad/app-prod /home/etherpad/logs

[Install]
WantedBy=multi-user.target
```

#### 11.7 启动生产服务
```bash
# 重新加载systemd配置
sudo systemctl daemon-reload

# 启用开机自启
sudo systemctl enable etherpad-prod

# 启动服务
sudo systemctl start etherpad-prod

# 查看服务状态
sudo systemctl status etherpad-prod
```

#### 11.8 查看日志
```bash
# 查看服务状态
sudo systemctl status etherpad-prod

# 实时查看日志
sudo journalctl -u etherpad-prod -f

# 查看文件日志
tail -f /home/etherpad/logs/etherpad-prod.log
```

### 12. 配置生产环境Nginx

```bash
sudo nano /etc/nginx/sites-available/etherpad-prod
```

配置内容：
```nginx
# HTTP 端口监听，自动跳转到 HTTPS
server {
    listen 80;
    server_name etherpad.alicedu.net;

    # 自动重定向到 HTTPS
    return 301 https://$host$request_uri;
}

# HTTPS 配置
server {
    listen 443 ssl http2;
    server_name etherpad.alicedu.net;

    # SSL证书配置
    ssl_certificate /etc/nginx/ssl/etherpad.alicedu.net/etherpad.alicedu.net.pem;
    ssl_certificate_key /etc/nginx/ssl/etherpad.alicedu.net/etherpad.alicedu.net.key;

    # SSL安全配置
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:ECDHE:ECDH:AES:HIGH:!NULL:!aNULL:!MD5:!ADH:!RC4;
    ssl_prefer_server_ciphers on;

    # HSTS (可选，增强安全性)
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # 日志配置
    access_log /var/log/nginx/etherpad-prod.access.log;
    error_log /var/log/nginx/etherpad-prod.error.log;

    # 客户端上传大小限制
    client_max_body_size 50M;

    # 代理到Etherpad生产服务（端口9002）
    location / {
        proxy_pass http://localhost:9002;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 超时设置
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        send_timeout 60s;

        # 缓冲设置
        proxy_buffering off;
    }

    # Socket.IO支持
    location /socket.io/ {
        proxy_pass http://localhost:9002/socket.io/;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 超时设置
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;

        # 禁用缓冲
        proxy_buffering off;
    }

    # 静态资源缓存（可选优化）
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        proxy_pass http://localhost:9002;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
```

启用配置：
```bash
# 创建软链接
sudo ln -s /etc/nginx/sites-available/etherpad-prod /etc/nginx/sites-enabled/

# 测试配置
sudo nginx -t

# 重新加载nginx
sudo systemctl reload nginx
```

### 13. 验证生产服务

#### 13.1 服务健康检查
```bash
# 检查Etherpad进程
sudo systemctl status etherpad-prod

# 检查端口监听
sudo netstat -tlnp | grep 9002

# 检查Nginx状态
sudo systemctl status nginx

# 测试本地访问
curl -I http://localhost:9002
curl -I https://etherpad.alicedu.net
```

#### 13.2 浏览器完整测试
1. 访问 `https://etherpad.alicedu.net`
2. 验证SSL证书（应该是绿色锁标志）
3. 创建测试pad：`https://etherpad.alicedu.net/p/test`
4. 测试编辑功能
5. 打开多个浏览器窗口测试协同编辑
6. 测试聊天功能
7. 测试导入/导出功能
8. 测试移动端访问

#### 13.3 性能和监控
```bash
# 查看资源使用情况
htop

# 查看Etherpad日志
tail -f /home/etherpad/logs/etherpad-prod.log

# 查看Nginx访问日志
tail -f /var/log/nginx/etherpad-prod.access.log

# 查看错误日志
tail -f /var/log/nginx/etherpad-prod.error.log
```

---

## 三、日常运维

### 1. 服务管理命令

```bash
# 测试环境
sudo systemctl start etherpad-test      # 启动
sudo systemctl stop etherpad-test       # 停止
sudo systemctl restart etherpad-test    # 重启
sudo systemctl status etherpad-test     # 状态

# 生产环境
sudo systemctl start etherpad-prod      # 启动
sudo systemctl stop etherpad-prod       # 停止
sudo systemctl restart etherpad-prod    # 重启
sudo systemctl status etherpad-prod     # 状态
```

### 2. 日志查看

```bash
# 实时查看系统日志
sudo journalctl -u etherpad-prod -f

# 查看最近500行日志
sudo journalctl -u etherpad-prod -n 500

# 查看今天的日志
sudo journalctl -u etherpad-prod --since today

# 查看应用日志文件
tail -f /home/etherpad/logs/etherpad-prod.log
```

### 3. 数据库备份

```bash
# 创建备份脚本
sudo nano /home/etherpad/scripts/backup-db.sh
```

备份脚本内容：
```bash
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/home/etherpad/backups"
DB_NAME="etherpad_prod"
DB_USER="etherpad_prod"
DB_PASS="<数据库密码>"
DB_HOST="<数据库地址>"

mkdir -p $BACKUP_DIR

mysqldump -h $DB_HOST -u $DB_USER -p$DB_PASS $DB_NAME | gzip > $BACKUP_DIR/etherpad_${DATE}.sql.gz

# 保留最近30天的备份
find $BACKUP_DIR -name "etherpad_*.sql.gz" -mtime +30 -delete

echo "Backup completed: etherpad_${DATE}.sql.gz"
```

设置定时任务：
```bash
# 添加执行权限
sudo chmod +x /home/etherpad/scripts/backup-db.sh

# 设置crontab（每天凌晨2点备份）
sudo crontab -e

# 添加以下行
0 2 * * * /home/etherpad/scripts/backup-db.sh >> /home/etherpad/logs/backup.log 2>&1
```

### 4. 更新部署

#### 4.1 更新测试环境
```bash
# 备份当前版本
cd /home/etherpad
sudo -u etherpad cp -r app app.backup.$(date +%Y%m%d)

# 拉取最新代码
cd /home/etherpad/app
sudo -u etherpad git pull origin master

# 安装依赖
sudo -u etherpad pnpm install

# 重新构建
sudo -u etherpad pnpm run build:etherpad

# 重启服务
sudo systemctl restart etherpad-test
```

#### 4.2 更新生产环境
```bash
# 1. 先在测试环境验证
# 2. 通知用户维护时间
# 3. 备份数据库和代码

# 备份当前版本
cd /home/etherpad
sudo -u etherpad cp -r app-prod app-prod.backup.$(date +%Y%m%d)

# 拉取最新代码
cd /home/etherpad/app-prod
sudo -u etherpad git pull origin master

# 安装依赖
sudo -u etherpad pnpm install --prod

# 重新构建
sudo -u etherpad pnpm run build:etherpad

# 重启服务
sudo systemctl restart etherpad-prod

# 验证服务
curl -I https://etherpad.alicedu.net
sudo systemctl status etherpad-prod
```

### 5. 监控和告警

#### 5.1 设置资源监控
安装监控工具（可选）：
```bash
# 安装htop
sudo apt install htop

# 安装glances（更强大的监控工具）
sudo apt install glances
```

#### 5.2 检查磁盘空间
```bash
# 查看磁盘使用情况
df -h

# 查看Etherpad目录大小
du -sh /home/etherpad/*

# 清理旧日志（可选）
find /home/etherpad/logs -name "*.log" -mtime +90 -delete
```

### 6. 故障排查

#### 6.1 服务无法启动
```bash
# 查看详细错误信息
sudo journalctl -u etherpad-prod -n 100 --no-pager

# 检查配置文件语法
cd /home/etherpad/app-prod
sudo -u etherpad node src/node/server.ts --settings settings.prod.json --checkconfig

# 检查端口占用
sudo netstat -tlnp | grep 9002
```

#### 6.2 数据库连接问题
```bash
# 测试数据库连接
mysql -h <DB_HOST> -u <DB_USER> -p<DB_PASS> -e "SELECT 1"

# 检查数据库表
mysql -h <DB_HOST> -u <DB_USER> -p<DB_PASS> etherpad_prod -e "SHOW TABLES"
```

#### 6.3 Nginx问题
```bash
# 测试Nginx配置
sudo nginx -t

# 查看Nginx错误日志
sudo tail -f /var/log/nginx/error.log

# 重启Nginx
sudo systemctl restart nginx
```

### 7. 性能优化建议

1. **数据库优化**
   - 定期执行 `OPTIMIZE TABLE` 优化表
   - 配置数据库连接池
   - 添加必要的索引

2. **应用优化**
   - 启用 minify 压缩资源
   - 配置合适的 maxAge 缓存时间
   - 调整 Socket.IO 配置

3. **Nginx优化**
   - 启用 gzip 压缩
   - 配置静态资源缓存
   - 调整 worker_processes 和 worker_connections

4. **服务器优化**
   - 增加文件描述符限制
   - 配置 swap 交换空间
   - 定期清理临时文件

---

## 四、安全加固

### 1. 防火墙配置
```bash
# 只允许必要的端口
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### 2. 数据库安全
- 使用强密码
- 限制数据库访问IP
- 定期更新数据库补丁
- 启用SSL连接（如支持）

### 3. 应用安全
- 定期更新 Node.js 和依赖包
- 配置 rate limiting
- 启用 HTTPS only
- 配置 CORS 策略
- 禁用不必要的插件

### 4. 系统安全
- 禁用 root SSH 登录
- 使用 SSH 密钥认证
- 定期更新系统补丁
- 配置 fail2ban 防止暴力破解

---

## 五、常见问题FAQ

### Q1: Etherpad启动失败怎么办？
**A:** 
1. 检查日志：`sudo journalctl -u etherpad-prod -n 100`
2. 验证配置文件：检查 `settings.prod.json` 语法
3. 检查数据库连接
4. 检查端口是否被占用
5. 确认文件权限正确

### Q2: 如何迁移已有的Etherpad数据？
**A:**
1. 导出源数据库：`mysqldump -h <源HOST> -u <用户> -p <数据库> > etherpad_export.sql`
2. 导入到新数据库：`mysql -h <新HOST> -u <用户> -p <数据库> < etherpad_export.sql`
3. 更新配置文件中的数据库连接信息
4. 重启服务

### Q3: 如何增加Etherpad性能？
**A:**
1. 升级服务器配置（CPU、内存）
2. 使用 Redis 作为会话存储
3. 启用 CDN 加速静态资源
4. 优化数据库查询和索引
5. 使用负载均衡（多实例部署）

### Q4: WebSocket连接失败怎么办？
**A:**
1. 确认 Nginx 配置了 WebSocket 支持
2. 检查防火墙规则
3. 验证 SSL 证书配置
4. 检查浏览器控制台错误信息

### Q5: 如何升级Etherpad版本？
**A:**
1. 在测试环境先测试
2. 备份生产环境数据和代码
3. 查看升级日志（CHANGELOG.md）
4. 拉取新版本代码
5. 执行数据库迁移（如需要）
6. 重新安装依赖和构建
7. 重启服务并验证

---

## 六、联系方式和支持

- **项目仓库**: https://github.com/Ruotong2025/alic-etherpad-lite
- **官方文档**: https://github.com/ether/etherpad-lite/wiki
- **问题反馈**: 通过 GitHub Issues 提交

---

**最后更新时间**: 2025年12月8日


