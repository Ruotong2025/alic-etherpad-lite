# Etherpad 定时任务调度器

## 概述

Etherpad现在支持内置的Node.js定时任务调度器，无需依赖系统cron。定时任务会在Etherpad主服务启动时自动运行。

## 架构

```
Etherpad Server (src/node/server.ts)
    ↓
TaskScheduler (src/node/scheduler/TaskScheduler.ts)
    ↓
├─ Task 1: 作者信息同步 (04:00)
├─ Task 2: Pad信息提取 (04:30)
└─ Task 3: Pad版本处理 (05:00)
```

## 配置文件

### 位置：`src/node/scheduler/cron-config.json`

```json
{
  "enabled": true,           // 是否启用定时任务
  "timezone": "Asia/Shanghai", // 时区设置
  "task_schedules": {
    "author_data_sync": {
      "enabled": true,       // 是否启用此任务
      "cron": "0 4 * * *",   // Cron表达式
      "command": "--process-etherpad_author",
      "description": "作者信息全量更新",
      "target_table": "etherpad_author",
      "priority": 1,
      "estimated_duration": "10-30分钟",
      "log_file": "author-sync.log"
    }
  }
}
```

### Cron表达式格式

```
 ┌────────────── 秒 (可选)
 │ ┌──────────── 分 (0-59)
 │ │ ┌────────── 时 (0-23)
 │ │ │ ┌──────── 日 (1-31)
 │ │ │ │ ┌────── 月 (1-12)
 │ │ │ │ │ ┌──── 周 (0-7, 0和7都表示周日)
 │ │ │ │ │ │
 * * * * * *
```

示例：
- `0 4 * * *` - 每天凌晨4点
- `*/15 * * * *` - 每15分钟
- `0 */6 * * *` - 每6小时
- `0 9-17 * * 1-5` - 工作日9-17点每小时

## 使用方法

### 1. 自动启动（推荐）

定时任务会在Etherpad启动时自动运行：

```bash
# 启动Etherpad
pnpm run dev
# 或
pnpm run prod
```

### 2. 禁用定时任务

在 `cron-config.json` 中设置：

```json
{
  "enabled": false
}
```

或禁用特定任务：

```json
{
  "task_schedules": {
    "author_data_sync": {
      "enabled": false
    }
  }
}
```

### 3. 手动执行任务

通过HTTP API或直接调用：

```typescript
import { taskScheduler } from './node/scheduler';

// 手动执行指定任务
await taskScheduler.runTask('author_data_sync');

// 获取状态
const status = taskScheduler.getStatus();
console.log(status);
```

## 日志查看

定时任务日志保存在 `logs/` 目录：

```bash
# 查看作者同步日志
tail -f logs/author-sync.log

# 查看Pad信息日志
tail -f logs/pad-info.log

# 查看Pad版本日志
tail -f logs/pad-version.log
```

## 监控

### 查看调度器状态

```typescript
const status = taskScheduler.getStatus();
// {
//   isRunning: true,
//   tasks: [
//     { name: 'author_data_sync', nextRun: 'N/A' },
//     { name: 'pad_info_extraction', nextRun: 'N/A' },
//     { name: 'pad_version_incremental', nextRun: 'N/A' }
//   ]
// }
```

### 日志级别

在Etherpad主日志中查看调度器信息：

```bash
tail -f logs/etherpad.log | grep scheduler
```

## 与旧版cron脚本的对比

| 特性 | 旧版 (cron-setup.sh) | 新版 (TaskScheduler) |
|------|---------------------|---------------------|
| 依赖 | 系统cron + jq | 仅Node.js |
| 启动 | 手动运行脚本 | 自动随服务启动 |
| 日志 | 分散的文件 | 集中管理 |
| 监控 | crontab -l | 程序化API |
| 跨平台 | Linux/Mac only | 全平台支持 |
| 热重载 | 需要重新设置 | 支持配置更新 |

## 故障排查

### 问题1：定时任务没有执行

检查：
1. 配置文件中 `enabled` 是否为 `true`
2. Cron表达式是否正确
3. 查看日志文件是否有错误信息

### 问题2：任务执行失败

查看具体任务的日志文件：

```bash
tail -f logs/<task-log-file>.log
```

### 问题3：无法启动调度器

检查：
1. `node-cron` 依赖是否已安装：`pnpm list node-cron`
2. 配置文件 JSON 格式是否正确
3. 检查 Etherpad 主日志

## 开发指南

### 添加新任务

1. 在 `cron-config.json` 中添加任务配置
2. 在 `etherpad-processor.js` 中添加对应的处理逻辑
3. 重启 Etherpad

示例：

```json
{
  "task_schedules": {
    "my_custom_task": {
      "enabled": true,
      "cron": "0 3 * * *",
      "command": "--process-my-table",
      "description": "我的自定义任务",
      "target_table": "my_table",
      "priority": 4,
      "estimated_duration": "5分钟",
      "log_file": "my-task.log"
    }
  }
}
```

### 扩展调度器

编辑 `src/node/scheduler/TaskScheduler.ts`：

```typescript
// 添加自定义方法
public async runTaskImmediately(taskName: string): Promise<void> {
  // 实现逻辑
}

// 添加事件监听
private onTaskComplete(taskName: string, duration: number): void {
  // 实现逻辑
}
```

## 迁移指南

### 从旧版cron迁移

1. **停止旧版cron任务**：
   ```bash
   crontab -l | grep -v "etherpad-processor.js" | crontab -
   ```

2. **更新配置**：
   确保 `cron-config.json` 中的任务配置正确

3. **安装依赖**：
   ```bash
   pnpm install
   ```

4. **启动Etherpad**：
   ```bash
   pnpm run prod
   ```

5. **验证**：
   检查日志确认定时任务正常运行

## 性能优化

### 调整任务时间

根据服务器负载调整任务执行时间，避免高峰期：

```json
{
  "task_schedules": {
    "heavy_task": {
      "cron": "0 2 * * *"  // 凌晨2点，流量低谷
    }
  }
}
```

### 控制并发

任务按优先级顺序执行，避免同时运行过多任务。

## 安全注意事项

1. **日志文件权限**：确保日志目录有适当的访问权限
2. **配置文件保护**：不要在配置文件中存储敏感信息
3. **资源限制**：监控任务执行时的资源使用

## 支持与反馈

如有问题或建议，请：
1. 查看日志文件
2. 检查配置文件
3. 提交Issue到项目仓库

## 更新日志

- **v2.3.2**: 首次集成Node.js定时调度器
  - 支持多个定时任务
  - 自动随服务启动
  - 完整的日志记录
  - 跨平台支持
