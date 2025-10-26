const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

// 读取数据库配置
function getDatabaseConfig() {
  const settingsPath = path.join(__dirname, '../../../../settings.json');
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

// 创建合并表
async function createMergeTable(connection) {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS pad_version_contents_merge (
      pad_id VARCHAR(255) NOT NULL,
      revision INT NOT NULL,
      content LONGTEXT NOT NULL,
      author_id VARCHAR(255) DEFAULT '',
      timestamp BIGINT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (pad_id, revision)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  
  // 先删除表（如果存在）
  await connection.execute('DROP TABLE IF EXISTS pad_version_contents_merge');
  console.log('已删除旧的 pad_version_contents_merge 表');
  
  // 创建新表
  await connection.execute(createTableSQL);
  console.log('已创建 pad_version_contents_merge 表');
}

// 获取pad的所有版本数据
async function getPadVersions(connection, padId) {
  const [rows] = await connection.execute(
    'SELECT * FROM pad_version_contents WHERE pad_id = ? ORDER BY revision ASC',
    [padId]
  );
  return rows;
}

// 应用精简规则
function applyMergeRules(versions) {
  if (versions.length <= 1) {
    return versions; // 如果只有一个或没有版本，直接返回
  }

  const mergedVersions = [];
  let i = 0;

  while (i < versions.length) {
    const current = versions[i];
    const next = versions[i + 1];
    const prev = versions[i - 1];

    // 总是保留第一个版本
    if (i === 0) {
      mergedVersions.push(current);
      i++;
      continue;
    }

    // 总是保留最后一个版本
    if (i === versions.length - 1) {
      mergedVersions.push(current);
      i++;
      continue;
    }

    // 去重规则：如果当前版本与前一个版本的内容和作者都相同，跳过当前版本
    if (prev && 
        current.content === prev.content && 
        current.author_id === prev.author_id) {
      console.log(`版本 ${current.revision}: 跳过 (与版本${prev.revision}重复 - 内容和作者相同)`);
      i++;
      continue;
    }

    // 换行符变化检测：如果两个版本只是换行符不同，跳过当前版本
    if (prev && current.author_id === prev.author_id) {
      const prevContentNormalized = prev.content ? prev.content.replace(/\r\n|\r|\n/g, '\n').replace(/\s+/g, ' ').trim() : '';
      const currentContentNormalized = current.content ? current.content.replace(/\r\n|\r|\n/g, '\n').replace(/\s+/g, ' ').trim() : '';
      
      // 如果标准化后的内容相同，且作者相同，则跳过当前版本
      if (prevContentNormalized === currentContentNormalized) {
        console.log(`版本 ${current.revision}: 跳过 (与版本${prev.revision}只有换行符/空格差异)`);
        i++;
        continue;
      }
    }

    // 规则3：作者变更 - 检查作者是否发生变化
    if (prev && next && 
        (current.author_id !== prev.author_id || current.author_id !== next.author_id)) {
      console.log(`版本 ${current.revision}: 作者变更 (${prev?.author_id} -> ${current.author_id} -> ${next?.author_id})`);
      mergedVersions.push(current);
      i++;
      continue;
    }

    // 规则1和规则2：内容长度变化趋势检查 - 精确实现转折点逻辑
    if (prev && next) {
      const prevLength = prev.content ? prev.content.length : 0;
      const currentLength = current.content ? current.content.length : 0;
      const nextLength = next.content ? next.content.length : 0;

      const prevChange = currentLength - prevLength; // 前一个变化量
      const nextChange = nextLength - currentLength; // 下一个变化量

      // 设置变化阈值，只有变化足够大才认为是有意义的转折点
      const CHANGE_THRESHOLD = 2; // 至少2个字符的变化才算有意义
      
      // 规则1：减→增 转折点 
      // 版本N-1: 减少了X字符, 版本N: 减少了Y字符 ← 保留这条, 版本N+1: 增加了Z字符
      // 条件：前面是减少(prevChange < 0)，后面是增加(nextChange > 0)，且变化幅度足够大
      if (prevChange < 0 && nextChange > 0 && 
          (Math.abs(prevChange) >= CHANGE_THRESHOLD || Math.abs(nextChange) >= CHANGE_THRESHOLD)) {
        console.log(`版本 ${current.revision}: 减→增转折点 (${prevLength} -> ${currentLength} -> ${nextLength}, 变化: ${prevChange} -> +${nextChange})`);
        mergedVersions.push(current);
        i++;
        continue;
      }

      // 规则2：增→减 转折点
      // 版本N-1: 增加了X字符, 版本N: 增加了Y字符 ← 保留这条, 版本N+1: 减少了Z字符
      // 条件：前面是增加(prevChange > 0)，后面是减少(nextChange < 0)，且变化幅度足够大
      if (prevChange > 0 && nextChange < 0 && 
          (Math.abs(prevChange) >= CHANGE_THRESHOLD || Math.abs(nextChange) >= CHANGE_THRESHOLD)) {
        console.log(`版本 ${current.revision}: 增→减转折点 (${prevLength} -> ${currentLength} -> ${nextLength}, 变化: +${prevChange} -> ${nextChange})`);
        mergedVersions.push(current);
        i++;
        continue;
      }
    }

    // 如果不符合任何保留规则，跳过此版本
    console.log(`版本 ${current.revision}: 跳过 (无关键变化)`);
    i++;
  }

  return mergedVersions;
}

// 插入合并后的数据
async function insertMergedData(connection, mergedVersions) {
  if (mergedVersions.length === 0) {
    console.log('没有数据需要插入');
    return;
  }

  const insertSQL = `
    INSERT INTO pad_version_contents_merge 
    (pad_id, revision, content, author_id, timestamp) 
    VALUES (?, ?, ?, ?, ?)
  `;

  for (const version of mergedVersions) {
    await connection.execute(insertSQL, [
      version.pad_id,
      version.revision,
      version.content || '',
      version.author_id || '',
      version.timestamp || 0
    ]);
  }

  console.log(`已插入 ${mergedVersions.length} 条合并后的记录`);
}

// 主函数
async function processPadMerge(padId) {
  let connection;
  
  try {
    console.log(`开始处理 pad: ${padId}`);
    
    // 创建数据库连接
    connection = await createConnection();
    console.log('数据库连接成功');
    
    // 创建合并表
    await createMergeTable(connection);
    
    // 获取pad的所有版本
    const versions = await getPadVersions(connection, padId);
    console.log(`找到 ${versions.length} 个版本`);
    
    if (versions.length === 0) {
      console.log('没有找到版本数据');
      return;
    }

    // 显示原始数据概览
    console.log('\n=== 原始版本数据概览 ===');
    versions.forEach((version, index) => {
      const contentLength = version.content ? version.content.length : 0;
      const prevLength = index > 0 ? (versions[index-1].content ? versions[index-1].content.length : 0) : 0;
      const change = index > 0 ? contentLength - prevLength : 0;
      const changeStr = index > 0 ? (change >= 0 ? `+${change}` : `${change}`) : '';
      console.log(`版本 ${version.revision}: 长度=${contentLength}${changeStr}, 作者=${version.author_id}, 时间=${new Date(version.timestamp).toLocaleString()}`);
    });

    // 应用合并规则
    console.log('\n=== 应用合并规则 ===');
    const mergedVersions = applyMergeRules(versions);
    
    // 显示合并后数据概览
    console.log('\n=== 合并后版本数据概览 ===');
    mergedVersions.forEach((version, index) => {
      const contentLength = version.content ? version.content.length : 0;
      console.log(`保留版本 ${version.revision}: 长度=${contentLength}, 作者=${version.author_id}, 时间=${new Date(version.timestamp).toLocaleString()}`);
    });

    // 插入合并后的数据
    await insertMergedData(connection, mergedVersions);
    
    console.log(`\n处理完成！原始版本数: ${versions.length}, 合并后版本数: ${mergedVersions.length}, 压缩率: ${((1 - mergedVersions.length / versions.length) * 100).toFixed(1)}%`);
    
  } catch (error) {
    console.error('处理过程中发生错误:', error);
    throw error;
  } finally {
    if (connection) {
      await connection.end();
      console.log('数据库连接已关闭');
    }
  }
}

// 命令行参数处理
if (require.main === module) {
  const padId = process.argv[2];
  
  if (!padId) {
    console.error('使用方法: node PadContentMerge.js <pad_id>');
    console.error('示例: node PadContentMerge.js room-229');
    process.exit(1);
  }
  
  processPadMerge(padId)
    .then(() => {
      console.log('脚本执行完成');
      process.exit(0);
    })
    .catch((error) => {
      console.error('脚本执行失败:', error);
      process.exit(1);
    });
}

module.exports = { processPadMerge };
