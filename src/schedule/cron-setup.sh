#!/bin/bash

# Etherpad数据处理定时任务设置脚本
# 每天早上5点运行，处理前一天12点到当天12点的数据

echo "设置Etherpad数据处理定时任务..."

# 获取当前脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# 定时任务脚本路径
PROCESSOR_SCRIPT="$SCRIPT_DIR/etherpad-processor.js"

# 创建日志目录
LOG_DIR="$PROJECT_ROOT/logs"
mkdir -p "$LOG_DIR"

# 定时任务命令
CRON_COMMAND="0 5 * * * cd $PROJECT_ROOT && node $PROCESSOR_SCRIPT --run >> $LOG_DIR/etherpad-processor.log 2>&1"

# 检查是否已存在该定时任务
if crontab -l 2>/dev/null | grep -q "etherpad-processor.js"; then
    echo "定时任务已存在，正在更新..."
    # 移除旧的定时任务
    crontab -l 2>/dev/null | grep -v "etherpad-processor.js" | crontab -
fi

# 添加新的定时任务
(crontab -l 2>/dev/null; echo "$CRON_COMMAND") | crontab -

echo "定时任务设置完成！"
echo "任务时间: 每天早上5:00"
echo "日志文件: $LOG_DIR/etherpad-processor.log"
echo ""
echo "当前定时任务列表:"
crontab -l

echo ""
echo "手动测试命令:"
echo "cd $PROJECT_ROOT && node $PROCESSOR_SCRIPT --test"
echo ""
echo "手动运行命令:"
echo "cd $PROJECT_ROOT && node $PROCESSOR_SCRIPT --run" 