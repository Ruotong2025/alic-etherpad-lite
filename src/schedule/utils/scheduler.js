/**
 * 定时任务工具
 */

// 计算时间范围 - 处理目标日期的整天数据
function calculateTimeRange(targetDate) {
  const date = new Date(targetDate);
  
  // 目标日期的0点
  const startTime = new Date(date);
  startTime.setHours(0, 0, 0, 0);
  
  // 目标日期的23:59:59
  const endTime = new Date(date);
  endTime.setHours(23, 59, 59, 999);
  
  return {
    startTime: startTime.getTime(),
    endTime: endTime.getTime(),
    startDate: startTime,
    endDate: endTime
  };
}

// 获取昨天的日期
function getYesterday() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday;
}

// 格式化时间用于日志
function formatTime(timestamp) {
  return new Date(timestamp).toISOString();
}

// 检查是否在运行时间内（用于防止重复运行）
function isRunningTime() {
  const now = new Date();
  const hour = now.getHours();
  
  // 只在5点执行
  return hour === 5;
}

// 生成任务ID
function generateTaskId() {
  const now = new Date();
  return `task_${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`;
}

module.exports = {
  calculateTimeRange,
  getYesterday,
  formatTime,
  isRunningTime,
  generateTaskId
}; 