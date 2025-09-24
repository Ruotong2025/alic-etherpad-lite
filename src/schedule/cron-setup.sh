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
CONFIG_FILE="$SCRIPT_DIR/cron-config.json"


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

if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ 错误: 配置文件不存在: $CONFIG_FILE"
    exit 1
fi



# 检查 Node.js 是否可用
if ! command -v node &> /dev/null; then
    echo "❌ 错误: Node.js 未安装或不在 PATH 中"
    exit 1
fi

# 检查 jq 是否可用（用于解析JSON配置）
if ! command -v jq &> /dev/null; then
    echo "❌ 错误: jq 未安装，无法解析JSON配置文件"
    echo "   请安装 jq: sudo apt-get install jq (Ubuntu/Debian) 或 brew install jq (macOS)"
    exit 1
fi

echo "✅ Node.js 版本: $(node --version)"
echo "✅ jq 版本: $(jq --version)"

# 从配置文件读取定时任务配置
echo ""
echo "📋 从配置文件读取定时任务设置..."

# 读取配置并生成定时任务
CRON_TASKS=()
CRON_DESCRIPTIONS=()

# 读取每个任务配置
for task in $(jq -r '.task_schedules | keys[]' "$CONFIG_FILE"); do
    cron_time=$(jq -r ".task_schedules.$task.cron" "$CONFIG_FILE")
    command=$(jq -r ".task_schedules.$task.command" "$CONFIG_FILE")
    log_file=$(jq -r ".task_schedules.$task.log_file" "$CONFIG_FILE")
    description=$(jq -r ".task_schedules.$task.description" "$CONFIG_FILE")
    target_table=$(jq -r ".task_schedules.$task.target_table" "$CONFIG_FILE")
    priority=$(jq -r ".task_schedules.$task.priority" "$CONFIG_FILE")
    duration=$(jq -r ".task_schedules.$task.estimated_duration" "$CONFIG_FILE")
    
    # 构建完整的cron命令
    cron_command="$cron_time cd $PROJECT_ROOT && node $PROCESSOR_SCRIPT $command >> $LOG_DIR/$log_file 2>&1"
    
    CRON_TASKS+=("$cron_command")
    CRON_DESCRIPTIONS+=("   🕐 $cron_time - $description")
    CRON_DESCRIPTIONS+=("      ↳ 目标表: $target_table | 优先级: $priority | 预计耗时: $duration")
done

echo "📋 配置的定时任务:"
for desc in "${CRON_DESCRIPTIONS[@]}"; do
    echo "$desc"
done

echo ""

# 移除现有的相关定时任务
echo "🗑️  移除现有定时任务..."
crontab -l 2>/dev/null | grep -v "etherpad-processor.js" | crontab -

# 添加新的定时任务
echo "➕ 添加新的定时任务..."
{
    crontab -l 2>/dev/null
    for task in "${CRON_TASKS[@]}"; do
        echo "$task"
    done

} | crontab -

# 验证任务是否添加成功
if crontab -l 2>/dev/null | grep -q "etherpad-processor.js"; then
    echo "✅ 定时任务设置完成！"
    echo ""
    echo "📋 已设置的定时任务:"
    crontab -l 2>/dev/null | grep "etherpad-processor.js" | sed 's/^/   /'
    echo ""
    echo "📝 日志文件:"
    for task in $(jq -r '.task_schedules | keys[]' "$CONFIG_FILE"); do
        log_file=$(jq -r ".task_schedules.$task.log_file" "$CONFIG_FILE")
        description=$(jq -r ".task_schedules.$task.description" "$CONFIG_FILE")
        echo "   $description: $LOG_DIR/$log_file"
    done
    echo ""
    echo "🔍 查看日志命令:"
    for task in $(jq -r '.task_schedules | keys[]' "$CONFIG_FILE"); do
        log_file=$(jq -r ".task_schedules.$task.log_file" "$CONFIG_FILE")
        echo "   tail -f $LOG_DIR/$log_file"
    done
    echo ""
    echo "🧪 手动测试命令:"
    echo "   测试运行: cd $PROJECT_ROOT && node $PROCESSOR_SCRIPT --test"
    echo ""
    echo "🚀 手动运行命令:"
    echo "   处理前一天: cd $PROJECT_ROOT && node $PROCESSOR_SCRIPT --run"
    echo "   处理所有数据: cd $PROJECT_ROOT && node $PROCESSOR_SCRIPT --process-all"
    echo "   处理pad基础信息: cd $PROJECT_ROOT && node $PROCESSOR_SCRIPT --process-pad-info"
    echo ""
    echo "✅ 设置完成! 定时任务已按配置文件设置："
    echo "   📄 配置文件: $CONFIG_FILE"
    timezone=$(jq -r '.timezone' "$CONFIG_FILE")
    echo "   🌏 时区: $timezone"
    echo ""
    echo "📋 任务调度详情:"
    
    # 显示执行流程
    echo "   🔄 执行顺序:"
    for i in $(jq -r '.execution_flow.sequence | keys[]' "$CONFIG_FILE"); do
        step=$(jq -r ".execution_flow.sequence[$i].step" "$CONFIG_FILE")
        time=$(jq -r ".execution_flow.sequence[$i].time" "$CONFIG_FILE")
        task_name=$(jq -r ".execution_flow.sequence[$i].task" "$CONFIG_FILE")
        purpose=$(jq -r ".execution_flow.sequence[$i].purpose" "$CONFIG_FILE")
        echo "      步骤$step: $time - $task_name"
        echo "              $purpose"
    done
    
    echo "   📊 数据表处理:"
    for task in $(jq -r '.task_schedules | keys[]' "$CONFIG_FILE"); do
        target_table=$(jq -r ".task_schedules.$task.target_table" "$CONFIG_FILE")
        description=$(jq -r ".task_schedules.$task.description" "$CONFIG_FILE")
        echo "      • $target_table ← $description"
    done
else
    echo "❌ 定时任务设置失败"
    exit 1
fi 