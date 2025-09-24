# Etherpad 数据处理系统

## 🕐 时间配置

| 时间  | 任务                    | 命令                                         | 耗时      |
|-------|-------------------------|----------------------------------------------|-----------|
| 04:00 | 作者信息更新            | `--process-etherpad_author`                 | 10-30分钟 |
| 04:30 | Pad基础信息提取         | `--process-etherpad_pad_info`               | 10-20分钟 |
| 05:00 | Pad版本增量处理         | `--process-incremental-etherpad_pad_version` | 30-60分钟 |
| 手动  | 版本数据全量同步        | `--process-full-etherpad_pad_version`        | 2-4小时   |
| 手动  | 三表组合处理            | `--process-all-tables`                       | 30-60分钟 |

## 📋 执行命令

### 自动任务 (Cron)
```bash
# 设置定时任务
bash cron-setup.sh

# 查看定时任务
crontab -l
```

### 手动执行
```bash
# etherpad_author作者全量
node etherpad-processor.js --process-etherpad_author

# etherpad_pad_info基本数据全量
node etherpad-processor.js --process-etherpad_pad_info

# etherpad_pad_version增量
node etherpad-processor.js --process-incremental-etherpad_pad_version

# etherpad_pad_version全量
node etherpad-processor.js --process-full-etherpad_pad_version

# 三表组合处理 (etherpad_pad_version增量 etherpad_author、etherpad_pad_info 全量)
node etherpad-processor.js --process-all-tables
```

## 🔄 数据流程图

```
┌─────────────┐
│   store     │  源数据表
│             │
│ Key模式:    │
│ ├─ pad:room-│  → etherpad_pad_info
│ ├─ pad:...  │
│ │  :revs:xxx│  → etherpad_pad_version
│ └─ global   │
│    Author:xx│  → etherpad_author
└─────────────┘
      │
      ▼
┌─────────────┐
│ 任务调度器   │  04:00 → 04:30 → 05:00
│ cron-config │
└─────────────┘
      │
      ▼
┌─────────────┬─────────────┬─────────────┐
│etherpad_    │etherpad_    │etherpad_    │
│author       │pad_info     │pad_version  │
│             │             │             │
│全量更新      │全量更新      │增量处理      │
│04:00        │04:30        │05:00        │
└─────────────┴─────────────┴─────────────┘
```

## 📊 数据表结构

### etherpad_author


### etherpad_pad_version


### etherpad_pad_info


## ⚙️ 配置文件

- **cron-config.json**: 时间配置和任务定义
- **cron-setup.sh**: 自动配置cron任务
- **etherpad-processor.js**: 主处理程序

## 🔍 监控要点

- **任务执行时间**: 超时告警
- **错误率**: 超过5%告警
- **磁盘空间**: 低于15%告警
- **数据完整性**: 版本连续性检查

## 📝 使用建议

1. **日常维护**: 使用 `--process-all-tables` 命令
2. **故障恢复**: 按需执行单个表处理命令
3. **初始化**: 先执行全量处理再切换到增量模式
4. **监控**: 关注任务执行时间和错误率
5. **备份**: 重要操作前备份数据表
