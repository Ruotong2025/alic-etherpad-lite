# Etherpad数据处理系统

## 📁 核心文件

### 主要功能文件
- **`etherpad-processor.js`** - 主数据处理器，包含定时任务、changeset解析和数据更新功能

### 工具模块
- **`utils/database.js`** - 数据库连接和操作工具
- **`utils/parser.js`** - Changeset解析工具  
- **`utils/scheduler.js`** - 定时任务工具

### 配置文件
- **`database-schema.sql`** - 数据库表结构定义
- **`package.json`** - 项目依赖配置
- **`cron-setup.sh`** - 定时任务设置脚本

## 🚀 使用方法

### 1. 安装依赖
```bash
npm install
```

### 2. 配置数据库
在项目根目录的 `settings.json` 中配置MySQL数据库：
```json
{
  "dbType": "mysql",
  "dbSettings": {
    "user": "root",
    "host": "112.74.92.135",
    "port": 3306,
    "password": "1q2w3e4R",
    "database": "alic",
    "charset": "utf8mb4",
    "ssl": false
  }
}
```

系统会自动从 `settings.json` 读取数据库配置。

### 3. 创建数据库表
```bash
mysql -u root -p alic < database-schema.sql
```

### 4. 运行数据处理
```bash
# 测试运行
node etherpad-processor.js --test

# 手动运行定时任务
node etherpad-processor.js --run

# 处理所有现有数据
node etherpad-processor.js --process-all
```

### 5. 设置定时任务
```bash
chmod +x cron-setup.sh
./cron-setup.sh
```

## 📊 数据结构

处理后的数据直接以正确格式存储在 `etherpad_pad_version` 表中：
- `change_description` - 变更内容（如："增加 '周末'"）
- `change_position` - 变更位置（如："第1行第1个词"）

插入时即为最终格式，无需后续更新。

## ⏰ 定时任务

系统每天早上5点自动运行，处理前一天整天(00:00-23:59)的数据。 