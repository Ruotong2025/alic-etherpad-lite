# Etherpad 数据处理和作者同步

## 功能说明

本工具提供两个主要功能：
1. **数据处理**：处理 Etherpad 的 pad 数据，分析 changeset 并重建内容
2. **作者同步**：将 `globalAuthor` 数据从 store 表同步到 `etherpad_author` 表

## 快速开始

### 1. 设置定时任务

```bash
# 设置每天5点的自动任务
bash cron-setup.sh
```

这将设置一个定时任务：
- **05:00** - 完整数据处理任务（处理所有pad数据、内容重建、作者同步）

### 2. 手动执行

```bash
node etherpad-processor.js --run         # 处理前一天数据
node etherpad-processor.js --process-all # 处理所有数据（包含作者同步）
node etherpad-processor.js --test        # 测试运行
```

## 数据库表结构

### etherpad_author 表

```sql
DROP TABLE IF EXISTS `etherpad_author`;
CREATE TABLE `etherpad_author`  (
  `author_id` varchar(255) NOT NULL COMMENT '作者 ID，去掉 globalAuthor: 前缀',
  `author_name` varchar(255) NULL COMMENT '作者名称',
  `color_id` varchar(50) NULL COMMENT '作者颜色',
  `timestamp` datetime NULL COMMENT '修改时间',
  `created_time` datetime NULL COMMENT '创建时间，从JSON timestamp转换',
  `padIDs` json NULL COMMENT '参与的pad，JSON格式',
  PRIMARY KEY (`author_id`)
) COMMENT = 'Etherpad 作者信息表';
```

## 日志查看

```bash
# 查看完整处理日志（包含数据处理和作者同步）
tail -f ../../logs/etherpad-processor.log
```

## 功能特性

- **全量同步**：作者数据每次都是全量更新，确保数据一致性
- **时间转换**：自动将毫秒时间戳转换为北京时区的DATETIME格式
- **数据处理**：智能处理各种格式的padIDs数据
- **错误处理**：完善的错误捕获和日志记录
- **自动化**：支持cron定时任务，无需人工干预

## 故障排查

1. **检查cron任务**：`crontab -l | grep etherpad-processor`
2. **查看日志**：检查对应的日志文件
3. **手动测试**：使用 `--test` 参数进行测试
4. **数据库连接**：确认 `settings.json` 中的数据库配置正确

## 文件结构

```
src/schedule/
├── etherpad-processor.js    # 主处理器（包含所有功能）
├── cron-setup.sh           # 定时任务设置脚本
├── utils/
│   ├── database.js         # 数据库操作（已扩展作者表操作）
│   ├── json-parser.js      # JSON解析工具
│   └── parser.js           # 内容解析工具
└── README.md              # 本文档
``` 