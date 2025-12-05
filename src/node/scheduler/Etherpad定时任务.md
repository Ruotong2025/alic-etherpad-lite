# 🚀 Etherpad定时任务 - 快速开始

## 已完成改造 ✅

您的定时任务已经从独立的Shell脚本改造成集成到Etherpad的Node.js调度器！

### 主要变化

| 项目 | 旧版 | 新版 |
|------|------|------|
| 运行方式 | 独立cron脚本 | 集成到Etherpad |
| 依赖 | 系统cron + jq | 仅Node.js |
| 跨平台 | ❌ 仅Linux/Mac | ✅ 全平台 |
| 启动 | 手动运行sh脚本 | 自动启动 |
| 配置 | crontab | JSON配置文件 |

## 立即使用

### 1️⃣ 安装依赖（如未安装）

```bash
pnpm install
```

### 2️⃣ 启动Etherpad

```bash
# 开发模式
pnpm run dev

# 或生产模式
pnpm run prod
```

**就这么简单！** 定时任务会自动启动。

### 3️⃣ 查看运行状态

在启动日志中会看到：

```
[INFO] scheduler - 🚀 初始化Etherpad定时任务调度器...
[INFO] scheduler - ✅ 注册任务: author_data_sync
   ├─ 描述: 作者信息全量更新
   ├─ Cron: 0 4 * * *
   ├─ 目标表: etherpad_author
   ├─ 优先级: 1
   └─ 预计耗时: 10-30分钟
[INFO] scheduler - ✅ 注册任务: pad_info_extraction
[INFO] scheduler - ✅ 注册任务: pad_version_incremental
[INFO] scheduler - ✅ 已启动 3 个定时任务
```

## 配置文件

### 位置

`src/node/scheduler/cron-config.json`

### 全局开关

```json
{
  "enabled": true,  // false = 禁用所有定时任务
  "timezone": "Asia/Shanghai",
  "task_schedules": {
    // ...任务配置
  }
}
```

### 单个任务开关

```json
{
  "task_schedules": {
    "author_data_sync": {
      "enabled": true,  // false = 仅禁用此任务
      "cron": "0 4 * * *",
      // ...
    }
  }
}
```

## 默认任务清单

| 任务名 | 执行时间 | 描述 | 日志文件 |
|--------|----------|------|----------|
| author_data_sync | 04:00 | 作者信息全量更新 | logs/author-sync.log |
| pad_info_extraction | 04:30 | Pad基础信息提取 | logs/pad-info.log |
| pad_version_incremental | 05:00 | Pad版本增量处理 | logs/pad-version.log |

## 查看日志

### 实时查看任务日志

```bash
# 作者同步
tail -f logs/author-sync.log

# Pad信息
tail -f logs/pad-info.log

# Pad版本
tail -f logs/pad-version.log
```

### 查看调度器日志

```bash
tail -f logs/etherpad.log | grep scheduler
```

## 常用操作

### 修改执行时间

编辑 `src/node/scheduler/cron-config.json`:

```json
{
  "task_schedules": {
    "author_data_sync": {
      "cron": "0 2 * * *"  // 改为凌晨2点
    }
  }
}
```

重启Etherpad生效。

### 临时禁用任务

```json
{
  "task_schedules": {
    "author_data_sync": {
      "enabled": false  // 禁用
    }
  }
}
```

### 完全禁用调度器

```json
{
  "enabled": false  // 所有任务都不运行
}
```

## 旧版cron清理（如果之前使用过）

如果之前使用了系统 cron 来运行定时任务，可以清理：

```bash
# 查看现有cron任务
crontab -l

# 删除Etherpad相关任务
crontab -l | grep -v "etherpad-processor.js" | crontab -
```

**注意**: `cron-setup.sh` 脚本已被移除，现在统一使用内置的 Node.js 调度器。

## 常见问题

### Q: 如何知道任务是否在运行？

**A**: 查看日志文件：
```bash
ls -lh logs/*.log
```
如果文件在增长，说明任务在运行。

### Q: 可以手动触发任务吗？

**A**: 可以！保留了原来的手动执行方式：
```bash
cd D:\ALIC\alic-etherpad-lite
```

### Q: Windows上也能用吗？

**A**: ✅ 是的！这就是新版的优势，跨平台支持。

### Q: 会影响Etherpad性能吗？

**A**: 不会。调度器本身开销很小，只在任务执行时才占用资源。

### Q: 可以添加自定义任务吗？

**A**: 可以！编辑配置文件添加新任务即可。

## 对比总结

### 旧版方式（已废弃）
旧版使用系统 cron + `cron-setup.sh` 脚本：
- ❌ 需要安装 jq 工具
- ❌ 需要手动运行设置脚本
- ❌ 仅支持 Linux/Mac
- ❌ 修改配置需要重新运行脚本
- ❌ 与 Etherpad 主进程分离

### 新版方式（当前推荐）
使用内置 Node.js 调度器：
- ✅ 无需额外依赖
- ✅ 自动随 Etherpad 启动
- ✅ 跨平台支持（Windows/Linux/Mac）
- ✅ 修改配置只需重启 Etherpad
- ✅ 与 Etherpad 主进程集成

## 技术栈

- **调度库**: node-cron (纯JavaScript，跨平台)
- **集成点**: src/node/server.ts
- **核心代码**: src/node/scheduler/TaskScheduler.ts
- **配置文件**: src/node/scheduler/cron-config.json

## 架构图

```
Etherpad启动
    ↓
server.ts初始化
    ↓
TaskScheduler.initialize()
    ↓
加载cron-config.json
    ↓
注册所有任务到node-cron
    ↓
启动定时调度
    ↓
[定时执行] → fork子进程 → etherpad-processor.js → 写入日志
```

## 更多帮助

- 📖 [详细文档](README.md)
- 📋 [集成指南](SCHEDULER_INTEGRATION_GUIDE.md)
- 🔧 [配置文件](cron-config.json)

---

**🎉 享受自动化的定时任务！有问题随时查看日志文件。**



PS D:\ALIC\alic-etherpad-lite\src>
node node\scheduler\etherpad-processor.js --process-etherpad_author
node node\scheduler\etherpad-processor.js --process-etherpad_pad_info
