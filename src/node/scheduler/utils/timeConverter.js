/**
 * 时间转换工具模块
 * 提供统一的时间戳转换功能，避免代码重复
 */

/**
 * 将时间戳转换为北京时区的 datetime 格式
 * @param {number|string} timestamp - 时间戳（毫秒）
 * @returns {string|null} - 北京时区的 datetime 字符串，格式：YYYY-MM-DD HH:mm:ss
 */
function convertTimestampToBeijingTime(timestamp) {
  if (!timestamp) return null;
  
  try {
    const date = new Date(parseInt(timestamp));
    
    // 检查日期是否有效
    if (isNaN(date.getTime())) {
      return null;
    }
    
    // 手动计算北京时间（UTC+8）
    const beijingDate = new Date(date.getTime() + (8 * 60 * 60 * 1000));
    return beijingDate.toISOString().slice(0, 19).replace('T', ' ');
  } catch (error) {
    console.error('时间戳转换失败:', error);
    return null;
  }
}

/**
 * 获取当前北京时间的 datetime 字符串
 * @returns {string} - 当前北京时间，格式：YYYY-MM-DD HH:mm:ss
 */
function getCurrentBeijingTime() {
  const now = new Date();
  const beijingNow = new Date(now.getTime() + (8 * 60 * 60 * 1000));
  return beijingNow.toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = {
  convertTimestampToBeijingTime,
  getCurrentBeijingTime
}; 