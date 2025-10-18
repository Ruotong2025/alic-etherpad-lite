const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

// 读取数据库配置
function getDatabaseConfig() {
  const settingsPath = path.join(__dirname, '../../../settings.json');
  if (!fs.existsSync(settingsPath)) {
    throw new Error('settings.json not found');
  }
  
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  return settings.dbSettings;
}

// 创建数据库连接
async function createConnection() {
  const dbConfig = getDatabaseConfig();
  return await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    charset: dbConfig.charset || 'utf8mb4'
  });
}

// 验证合并结果
async function verifyMergeResults(padId) {
  let connection;
  
  try {
    console.log(`验证 pad: ${padId} 的合并结果`);
    
    // 创建数据库连接
    connection = await createConnection();
    console.log('数据库连接成功');
    
    // 查询原始数据统计
    const [originalStats] = await connection.execute(
      'SELECT COUNT(*) as count, MIN(revision) as min_rev, MAX(revision) as max_rev FROM pad_version_contents WHERE pad_id = ?',
      [padId]
    );
    
    // 查询合并后数据统计
    const [mergedStats] = await connection.execute(
      'SELECT COUNT(*) as count, MIN(revision) as min_rev, MAX(revision) as max_rev FROM pad_version_contents_merge WHERE pad_id = ?',
      [padId]
    );
    
    console.log('\n=== 数据统计对比 ===');
    console.log(`原始数据: ${originalStats[0].count} 条记录 (版本 ${originalStats[0].min_rev} - ${originalStats[0].max_rev})`);
    console.log(`合并数据: ${mergedStats[0].count} 条记录 (版本 ${mergedStats[0].min_rev} - ${mergedStats[0].max_rev})`);
    console.log(`压缩率: ${((1 - mergedStats[0].count / originalStats[0].count) * 100).toFixed(1)}%`);
    
    // 查询合并后的详细数据
    const [mergedData] = await connection.execute(
      'SELECT revision, LENGTH(content) as content_length, author_id, FROM_UNIXTIME(timestamp/1000) as created_time FROM pad_version_contents_merge WHERE pad_id = ? ORDER BY revision',
      [padId]
    );
    
    console.log('\n=== 合并后的版本详情 ===');
    mergedData.forEach((row, index) => {
      console.log(`${index + 1}. 版本 ${row.revision}: 长度=${row.content_length}, 作者=${row.author_id}, 时间=${row.created_time}`);
    });
    
    // 验证关键转折点
    console.log('\n=== 验证转折点逻辑 ===');
    for (let i = 1; i < mergedData.length - 1; i++) {
      const prev = mergedData[i - 1];
      const current = mergedData[i];
      const next = mergedData[i + 1];
      
      const prevTrend = current.content_length - prev.content_length;
      const nextTrend = next.content_length - current.content_length;
      
      let reason = '';
      if (prevTrend < 0 && nextTrend > 0) {
        reason = '减→增转折点';
      } else if (prevTrend > 0 && nextTrend < 0) {
        reason = '增→减转折点';
      } else if (current.author_id !== prev.author_id || current.author_id !== next.author_id) {
        reason = '作者变更';
      } else {
        reason = '其他原因';
      }
      
      console.log(`版本 ${current.revision}: ${reason} (${prev.content_length} -> ${current.content_length} -> ${next.content_length})`);
    }
    
  } catch (error) {
    console.error('验证过程中发生错误:', error);
    throw error;
  } finally {
    if (connection) {
      await connection.end();
      console.log('\n数据库连接已关闭');
    }
  }
}

// 命令行参数处理
if (require.main === module) {
  const padId = process.argv[2];
  
  if (!padId) {
    console.error('使用方法: node verifyMergeResults.js <pad_id>');
    console.error('示例: node verifyMergeResults.js room-229');
    process.exit(1);
  }
  
  verifyMergeResults(padId)
    .then(() => {
      console.log('验证完成');
      process.exit(0);
    })
    .catch((error) => {
      console.error('验证失败:', error);
      process.exit(1);
    });
}

module.exports = { verifyMergeResults };
