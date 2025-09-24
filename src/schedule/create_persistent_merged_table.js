/**
 * 创建持久表并存储合并后的连续操作数据
 * 整合了所有必要的合并功能
 */

const Database = require('./utils/database.js');

class ConsecutiveOperationsMerger {
  constructor() {
    this.db = new Database();
  }

  async connect() {
    await this.db.connect();
  }

  async disconnect() {
    await this.db.disconnect();
  }

  /**
   * 获取所有需要处理的记录，按pad_id、revision和author排序
   */
  async getAllRecords() {
    const query = `
      SELECT pad_id, revision, content, change_behavior, change_content,
             change_position, author, timestamp, changeset, create_time
      FROM etherpad_pad_version 
      WHERE change_behavior IS NOT NULL
      ORDER BY pad_id, revision, author
    `;
    
    const [rows] = await this.db.connection.execute(query);
    return rows;
  }

  /**
   * 按pad_id分组记录
   */
  groupRecordsByPad(records) {
    const grouped = {};
    
    records.forEach(record => {
      if (!grouped[record.pad_id]) {
        grouped[record.pad_id] = [];
      }
      grouped[record.pad_id].push(record);
    });
    
    return grouped;
  }

  /**
   * 合并单个pad的连续操作（考虑作者）
   */
  mergeConsecutiveOperations(records) {
    if (records.length === 0) return [];
    
    const merged = [];
    let currentGroup = {
      records: [records[0]],
      behavior: records[0].change_behavior,
      author: records[0].author
    };
    
    for (let i = 1; i < records.length; i++) {
      const record = records[i];
      
      // 如果操作类型相同且作者相同，加入当前组
      if (record.change_behavior === currentGroup.behavior && 
          record.author === currentGroup.author) {
        currentGroup.records.push(record);
      } else {
        // 操作类型不同或作者不同，处理当前组并开始新组
        merged.push(this.createMergedRecord(currentGroup.records));
        
        currentGroup = {
          records: [record],
          behavior: record.change_behavior,
          author: record.author
        };
      }
    }
    
    // 处理最后一个组
    merged.push(this.createMergedRecord(currentGroup.records));
    
    return merged;
  }

  /**
   * 创建合并后的记录
   */
  createMergedRecord(records) {
    if (records.length === 0) return null;
    
    const firstRecord = records[0];
    const lastRecord = records[records.length - 1];
    
    // 叠加 change_content
    const mergedChangeContent = records
      .map(r => r.change_content || '')
      .join('');
    
    // 合并所有 changeset 为简单数组，只保留 changeset 值
    const mergedChangesets = records.map(r => r.changeset);
    
    return {
      pad_id: firstRecord.pad_id,
      revision: firstRecord.revision, // 使用第一条记录的revision
      content: lastRecord.content, // 使用最后一条记录的content
      change_behavior: firstRecord.change_behavior, // 同组内behavior相同
      change_content: mergedChangeContent, // 叠加所有change_content
      change_position: firstRecord.change_position, // 使用第一条记录的position
      author: firstRecord.author, // 使用第一条记录的author
      timestamp: lastRecord.timestamp, // 使用最后一条记录的timestamp
      changeset: JSON.stringify(mergedChangesets), // 合并为JSON数组
      create_time: lastRecord.create_time, // 使用最后一条记录的create_time
      original_count: records.length // 记录原始记录数量
    };
  }
}

async function createPersistentMergedTable() {
  console.log('🔄 开始创建持久表并存储合并数据...');
  
  const merger = new ConsecutiveOperationsMerger();
  
  try {
    // 初始化数据库连接
    await merger.connect();
    console.log('✅ 数据库连接成功');
    
    // 删除已存在的表（如果有）
    try {
      await merger.db.connection.execute('DROP TABLE IF EXISTS etherpad_pad_version_merged');
      console.log('🗑️ 删除已存在的合并表');
    } catch (error) {
      // 忽略删除错误
    }
    
    // 创建持久表
    const createTableQuery = `
      CREATE TABLE etherpad_pad_version_merged (
        id bigint NOT NULL AUTO_INCREMENT,
        pad_id varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Pad ID',
        revision int NOT NULL COMMENT '版本号',
        content longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL COMMENT '文本内容',
        change_behavior varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL COMMENT '变更操作 add/delete',
        change_content text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL COMMENT '变更具体内容(合并后)',
        change_position varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL COMMENT '变更位置',
        author varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL COMMENT '作者ID',
        timestamp bigint NULL DEFAULT NULL COMMENT '时间戳',
        changeset longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL COMMENT '变更集JSON数组',
        create_time datetime NULL DEFAULT CURRENT_TIMESTAMP COMMENT '数据创建时间',
        original_count int NOT NULL DEFAULT 1 COMMENT '原始记录数量',
        PRIMARY KEY (id) USING BTREE,
        UNIQUE INDEX uk_pad_revision_author (pad_id ASC, revision ASC, author ASC) USING BTREE,
        INDEX idx_pad_id (pad_id) USING BTREE,
        INDEX idx_behavior (change_behavior) USING BTREE
      ) ENGINE = InnoDB CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT = 'Pad版本合并持久表' ROW_FORMAT = DYNAMIC;
    `;
    
    await merger.db.connection.execute(createTableQuery);
    console.log('✅ 持久表创建成功: etherpad_pad_version_merged');
    
    // 获取所有记录并执行合并
    console.log('🔄 开始执行连续操作合并...');
    const records = await merger.getAllRecords();
    console.log(`📊 获取到 ${records.length} 条记录`);
    
    const groupedRecords = merger.groupRecordsByPad(records);
    console.log(`📊 涉及 ${Object.keys(groupedRecords).length} 个pad`);
    
    let totalMerged = 0;
    let totalOriginal = 0;
    
    // 处理每个pad的记录
    for (const [padId, padRecords] of Object.entries(groupedRecords)) {
      const mergedRecords = merger.mergeConsecutiveOperations(padRecords);
      
      console.log(`📝 ${padId}: ${padRecords.length} -> ${mergedRecords.length} 条记录`);
      
      totalOriginal += padRecords.length;
      totalMerged += mergedRecords.length;
      
      // 插入合并后的记录到持久表
      for (const mergedRecord of mergedRecords) {
        const insertQuery = `
          INSERT INTO etherpad_pad_version_merged 
          (pad_id, revision, content, change_behavior, change_content, change_position, 
           author, timestamp, changeset, create_time, original_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        await merger.db.connection.execute(insertQuery, [
          mergedRecord.pad_id,
          mergedRecord.revision,
          mergedRecord.content,
          mergedRecord.change_behavior,
          mergedRecord.change_content,
          mergedRecord.change_position,
          mergedRecord.author,
          mergedRecord.timestamp,
          mergedRecord.changeset,
          mergedRecord.create_time,
          mergedRecord.original_count
        ]);
      }
    }
    
    // 显示统计信息
    console.log('\n📊 合并统计:');
    console.log(`   原始记录数: ${totalOriginal}`);
    console.log(`   合并后记录数: ${totalMerged}`);
    console.log(`   减少记录数: ${totalOriginal - totalMerged}`);
    console.log(`   压缩率: ${((totalOriginal - totalMerged) / totalOriginal * 100).toFixed(1)}%`);
    
    // 显示持久表中的数据样例
    console.log('\n🔍 持久表数据预览:');
    const previewQuery = `
      SELECT pad_id, revision, change_behavior, author, 
             LENGTH(change_content) as content_length, 
             change_position, original_count
      FROM etherpad_pad_version_merged 
      ORDER BY pad_id, revision 
      LIMIT 10
    `;
    
    const [previewRows] = await merger.db.connection.execute(previewQuery);
    previewRows.forEach((row, index) => {
      console.log(`   ${index + 1}. ${row.pad_id} rev${row.revision} ${row.change_behavior} by ${row.author} (合并了${row.original_count}条)`);
      console.log(`      内容长度: ${row.content_length}, 位置: ${row.change_position || '无'}`);
    });
    
    // 验证持久表记录数
    const [countResult] = await merger.db.connection.execute(
      'SELECT COUNT(*) as total FROM etherpad_pad_version_merged'
    );
    console.log(`\n✅ 持久表总记录数: ${countResult[0].total}`);
    
    // 按pad统计
    const [padStatsResult] = await merger.db.connection.execute(`
      SELECT 
        pad_id,
        COUNT(*) as merged_count,
        SUM(original_count) as original_count,
        ROUND((1 - COUNT(*)/SUM(original_count)) * 100, 1) as compression_rate
      FROM etherpad_pad_version_merged
      GROUP BY pad_id
      ORDER BY pad_id
    `);
    
    console.log('\n📋 按Pad统计:');
    padStatsResult.forEach(stat => {
      console.log(`   ${stat.pad_id}: ${stat.original_count} -> ${stat.merged_count} 条 (压缩率: ${stat.compression_rate}%)`);
    });
    
    console.log('\n📋 持久表信息:');
    console.log('   表名: etherpad_pad_version_merged');
    console.log('   类型: 持久表 (不会自动删除)');
    console.log('   用途: 存储合并后的数据，可用于分析和备份');
    console.log('   changeset格式: 简化字符串数组 ["changeset1", "changeset2", ...]');
    
    console.log('\n💡 使用建议:');
    console.log('   1. 查看所有合并数据: SELECT * FROM etherpad_pad_version_merged;');
    console.log('   2. 按pad统计: SELECT pad_id, COUNT(*), SUM(original_count) FROM etherpad_pad_version_merged GROUP BY pad_id;');
    console.log('   3. 按操作类型统计: SELECT change_behavior, COUNT(*), SUM(original_count) FROM etherpad_pad_version_merged GROUP BY change_behavior;');
    console.log('   4. 查看特定pad: SELECT * FROM etherpad_pad_version_merged WHERE pad_id = "room-229" ORDER BY revision;');
    console.log('   5. 解析changeset数组: JSON_PARSE(changeset) 或在JavaScript中 JSON.parse(record.changeset);');
    console.log('   6. 删除表: DROP TABLE etherpad_pad_version_merged;');
    
  } catch (error) {
    console.error('❌ 创建持久表失败:', error);
    throw error;
  } finally {
    if (merger.db && merger.db.connection) {
      await merger.disconnect();
      console.log('\n🔌 数据库连接已关闭');
    }
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  createPersistentMergedTable().catch(error => {
    console.error('❌ 执行过程中发生错误:', error);
    process.exit(1);
  });
}

module.exports = { createPersistentMergedTable }; 