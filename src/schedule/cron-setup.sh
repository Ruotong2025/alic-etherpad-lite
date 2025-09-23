#!/bin/bash

# Etherpad数据处理定时任务设置脚本
# 设置每天5点的数据处理和作者同步定时任务

echo "🔧 设置Etherpad数据处理和作者同步定时任务"
echo "═══════════════════════════════════════════════════"

# 获取当前脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# 定时任务脚本路径
PROCESSOR_SCRIPT="$SCRIPT_DIR/etherpad-processor.js"

# 创建日志目录
LOG_DIR="$PROJECT_ROOT/logs"
mkdir -p "$LOG_DIR"

echo "📂 项目根目录: $PROJECT_ROOT"
echo "📂 脚本目录: $SCRIPT_DIR"
echo "📂 日志目录: $LOG_DIR"

# 检查必要文件是否存在
if [ ! -f "$PROCESSOR_SCRIPT" ]; then
    echo "❌ 错误: 处理脚本不存在: $PROCESSOR_SCRIPT"
    exit 1
fi

# 检查 Node.js 是否可用
if ! command -v node &> /dev/null; then
    echo "❌ 错误: Node.js 未安装或不在 PATH 中"
    exit 1
fi

echo "✅ Node.js 版本: $(node --version)"

# 定时任务配置
echo ""
echo "📋 配置定时任务:"

# 数据处理任务（每天5:00）- 包含pad数据处理、内容重建和作者同步
DATA_CRON="0 5 * * * cd $PROJECT_ROOT && node $PROCESSOR_SCRIPT --process-all >> $LOG_DIR/etherpad-processor.log 2>&1"
echo "   🕐 05:00 - 完整数据处理任务 (处理pad数据、内容重建、作者同步)"

echo ""

# 移除现有的相关定时任务
echo "🗑️  移除现有定时任务..."
crontab -l 2>/dev/null | grep -v "etherpad-processor.js" | crontab -

# 添加新的定时任务
echo "➕ 添加新的定时任务..."
(crontab -l 2>/dev/null; echo "$DATA_CRON") | crontab -

# 验证任务是否添加成功
if crontab -l 2>/dev/null | grep -q "etherpad-processor.js"; then
    echo "✅ 定时任务设置完成！"
    echo ""
    echo "📋 已设置的定时任务:"
    crontab -l 2>/dev/null | grep "etherpad-processor.js" | sed 's/^/   /'
    echo ""
    echo "📝 日志文件:"
    echo "   完整处理日志: $LOG_DIR/etherpad-processor.log"
    echo ""
    echo "🔍 查看日志命令:"
    echo "   tail -f $LOG_DIR/etherpad-processor.log"
    echo ""
    echo "🧪 手动测试命令:"
    echo "   测试运行: cd $PROJECT_ROOT && node $PROCESSOR_SCRIPT --test"
    echo ""
    echo "🚀 手动运行命令:"
    echo "   处理前一天: cd $PROJECT_ROOT && node $PROCESSOR_SCRIPT --run"
    echo "   处理所有数据: cd $PROJECT_ROOT && node $PROCESSOR_SCRIPT --process-all"
    echo ""
    echo "✅ 设置完成! 系统将在每天05:00自动执行完整数据处理任务"
else
    echo "❌ 定时任务设置失败"
    exit 1
fi 