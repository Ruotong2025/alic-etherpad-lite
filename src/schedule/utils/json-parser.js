/**
 * JSON解析工具
 * 专门处理store表中的JSON数据解析
 */

/**
 * 解析store表中的value字段
 * @param {string} jsonString - JSON字符串
 * @returns {Object} 解析后的对象，包含changeset和meta信息
 */
function parseStoreValue(jsonString) {
  try {
    const parsed = JSON.parse(jsonString);
    
    // 验证必要字段
    if (!parsed.changeset) {
      throw new Error('缺少changeset字段');
    }
    
    if (!parsed.meta) {
      throw new Error('缺少meta字段');
    }
    
    return {
      changeset: parsed.changeset,
      meta: {
        author: parsed.meta.author || null,
        timestamp: parsed.meta.timestamp || null
      },
      raw: parsed
    };
    
  } catch (error) {
    return {
      error: error.message,
      originalData: jsonString
    };
  }
}

/**
 * 批量解析store记录
 * @param {Array} storeRecords - store表记录数组
 * @returns {Array} 解析结果数组
 */
function parseStoreRecords(storeRecords) {
  const results = [];
  
  storeRecords.forEach((record, index) => {
    const parsed = parseStoreValue(record.value);
    
    results.push({
      key: record.key,
      index: index,
      ...parsed,
      originalRecord: record
    });
  });
  
  return results;
}

/**
 * 提取pad信息并解析JSON
 * @param {Array} storeRecords - store表记录
 * @returns {Object} 按pad_id分组的解析结果
 */
function parseAndGroupByPad(storeRecords) {
  const grouped = {};
  const errors = [];
  
  storeRecords.forEach((record, index) => {
    try {
      // 提取pad信息
      const padMatch = record.key.match(/^pad:(room-\d+):revs:(\d+)$/);
      if (!padMatch) {
        errors.push({
          index,
          key: record.key,
          error: '无效的key格式'
        });
        return;
      }
      
      const padId = padMatch[1];
      const revision = parseInt(padMatch[2]);
      
      // 解析JSON
      const parsed = parseStoreValue(record.value);
      if (parsed.error) {
        errors.push({
          index,
          key: record.key,
          error: parsed.error
        });
        return;
      }
      
      // 按pad分组
      if (!grouped[padId]) {
        grouped[padId] = {
          padId: padId,
          revisions: [],
          totalRevisions: 0
        };
      }
      
      grouped[padId].revisions.push({
        revision: revision,
        changeset: parsed.changeset,
        author: parsed.meta.author,
        timestamp: parsed.meta.timestamp,
        key: record.key
      });
      
      grouped[padId].totalRevisions++;
      
    } catch (error) {
      errors.push({
        index,
        key: record.key,
        error: error.message
      });
    }
  });
  
  // 对每个pad的版本进行排序
  Object.values(grouped).forEach(pad => {
    pad.revisions.sort((a, b) => a.revision - b.revision);
  });
  
  return {
    grouped,
    errors,
    totalPads: Object.keys(grouped).length,
    totalRecords: storeRecords.length,
    errorCount: errors.length
  };
}

/**
 * 验证changeset序列的连续性
 * @param {Array} revisions - 版本列表
 * @returns {Object} 验证结果
 */
function validateRevisionSequence(revisions) {
  const validation = {
    isSequential: true,
    missingRevisions: [],
    duplicateRevisions: [],
    totalRevisions: revisions.length,
    expectedCount: 0
  };
  
  if (revisions.length === 0) {
    return validation;
  }
  
  const sortedRevisions = [...revisions].sort((a, b) => a.revision - b.revision);
  const firstRev = sortedRevisions[0].revision;
  const lastRev = sortedRevisions[sortedRevisions.length - 1].revision;
  
  validation.expectedCount = lastRev - firstRev + 1;
  validation.range = `${firstRev}-${lastRev}`;
  
  // 检查连续性
  const revisionNumbers = new Set();
  const duplicates = new Set();
  
  revisions.forEach(rev => {
    if (revisionNumbers.has(rev.revision)) {
      duplicates.add(rev.revision);
    } else {
      revisionNumbers.add(rev.revision);
    }
  });
  
  validation.duplicateRevisions = Array.from(duplicates);
  
  // 检查缺失的版本
  for (let i = firstRev; i <= lastRev; i++) {
    if (!revisionNumbers.has(i)) {
      validation.missingRevisions.push(i);
    }
  }
  
  validation.isSequential = validation.missingRevisions.length === 0 && validation.duplicateRevisions.length === 0;
  
  return validation;
}

/**
 * 格式化解析结果为可读报告
 * @param {Object} parseResult - 解析结果
 * @returns {string} 格式化的报告
 */
function formatParseReport(parseResult) {
  const { grouped, errors, totalPads, totalRecords, errorCount } = parseResult;
  
  let report = `📊 Store数据解析报告\n`;
  report += `═`.repeat(50) + '\n';
  report += `总记录数: ${totalRecords}\n`;
  report += `解析成功: ${totalRecords - errorCount}\n`;
  report += `解析失败: ${errorCount}\n`;
  report += `Pad数量: ${totalPads}\n\n`;
  
  if (errors.length > 0) {
    report += `❌ 解析错误:\n`;
    errors.slice(0, 5).forEach(error => {
      report += `   ${error.key}: ${error.error}\n`;
    });
    if (errors.length > 5) {
      report += `   ... 还有 ${errors.length - 5} 个错误\n`;
    }
    report += '\n';
  }
  
  report += `📋 Pad详情:\n`;
  Object.values(grouped).slice(0, 5).forEach(pad => {
    const validation = validateRevisionSequence(pad.revisions);
    report += `   ${pad.padId}: ${pad.totalRevisions}个版本`;
    if (!validation.isSequential) {
      report += ` (序列不完整)`;
    }
    report += '\n';
  });
  
  return report;
}

module.exports = {
  parseStoreValue,
  parseStoreRecords,
  parseAndGroupByPad,
  validateRevisionSequence,
  formatParseReport
}; 