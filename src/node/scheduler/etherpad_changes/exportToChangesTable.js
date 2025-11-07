#!/usr/bin/env node

/**
 * 将 pad_version_snapshots.deletions_json 解析并存储到 pad_version_changes 表
 * 
 * 增量更新逻辑：
 * - 如果 pad_id 不存在，直接插入所有记录
 * - 如果 pad_id 已存在，先删除该 pad 的旧记录，再插入新记录
 * - seq_order 按照 deletions_json 数组的顺序排列（从1开始）
 */

const mysql = require('mysql2/promise');
const path = require('path');

// 数据库配置
const DB_CONFIG = {
  host: process.env.DB_HOST || '112.74.92.135',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '1q2w3e4R',
  database: process.env.DB_NAME || 'alic',
  charset: 'utf8mb4',
  port: process.env.DB_PORT || 3306
};

/**
 * 数据库管理器
 */
class ChangeTableManager {
  constructor() {
    this.connection = null;
  }

  async connect() {
    this.connection = await mysql.createConnection(DB_CONFIG);
    console.log('✅ 数据库连接成功');
  }

  async close() {
    if (this.connection) {
      await this.connection.end();
      console.log('🔌 数据库连接已关闭');
    }
  }

  /**
   * 创建 pad_version_changes 表（如果不存在）
   */
  async ensureChangesTable() {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS pad_version_changes (
        id BIGINT AUTO_INCREMENT,
        pad_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Pad ID',
        seq_order INT NOT NULL COMMENT '操作顺序（从1开始）',
        behavior VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '操作类型：add 或 deleted',
        author VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '作者ID',
        content LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '操作内容',
        add_start_time VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '内容添加开始时间',
        add_end_time VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '内容添加结束时间',
        delete_start_time VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '内容删除开始时间',
        delete_end_time VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '内容删除结束时间',
        PRIMARY KEY (id) USING BTREE,
        INDEX idx_pad_id(pad_id ASC) USING BTREE
      ) COMMENT='Pad版本变更详细记录表（增量更新）' ROW_FORMAT=Dynamic;
    `;

    await this.connection.execute(createTableSQL);
    console.log('✅ pad_version_changes 表已就绪');
  }

  /**
   * 获取指定 pad 的最新版本快照
   */
  async getLatestSnapshot(padId) {
    const query = `
      SELECT pad_id, revision, deletions_json
      FROM pad_version_snapshots
      WHERE pad_id = ?
      ORDER BY revision DESC
      LIMIT 1
    `;
    
    const [rows] = await this.connection.execute(query, [padId]);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * 检查指定 pad 是否存在变更记录
   */
  async padExists(padId) {
    const [rows] = await this.connection.execute(
      'SELECT COUNT(*) as count FROM pad_version_changes WHERE pad_id = ?',
      [padId]
    );
    return rows[0].count > 0;
  }

  /**
   * 删除指定 pad 的所有变更记录
   */
  async deletePadChanges(padId) {
    const [result] = await this.connection.execute(
      'DELETE FROM pad_version_changes WHERE pad_id = ?',
      [padId]
    );
    console.log(`🗑️  删除旧记录: ${result.affectedRows} 条`);
    return result.affectedRows;
  }

  /**
   * 批量插入变更记录
   */
  async insertChanges(changes) {
    if (changes.length === 0) return;

    console.log(`💾 开始保存 ${changes.length} 条变更记录...`);
    
    const query = `
      INSERT INTO pad_version_changes 
      (pad_id, seq_order, behavior, author, content, add_start_time, add_end_time, delete_start_time, delete_end_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    let successCount = 0;
    
    for (const change of changes) {
      try {
        await this.connection.execute(query, [
          change.pad_id,
          change.change_order,
          change.behavior,
          change.author,
          change.content,
          change.add_start_time,
          change.add_end_time,
          change.delete_start_time,
          change.delete_end_time
        ]);
        successCount++;
        
        if (successCount % 100 === 0) {
          console.log(`   进度: ${successCount}/${changes.length}`);
        }
      } catch (error) {
        console.error(`   ❌ 保存失败 (Pad=${change.pad_id}, Order=${change.change_order}):`, error.message);
      }
    }

    console.log(`✅ 保存完成: 成功 ${successCount}/${changes.length}`);
  }
}

/**
 * 主导出类
 */
class ChangeExporter {
  constructor() {
    this.db = new ChangeTableManager();
  }

  async exportChanges(padId) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`📤 导出 Pad 变更记录到 pad_version_changes 表`);
    console.log(`${'='.repeat(70)}`);
    console.log(`📝 目标 Pad: ${padId || '全部'}`);
    console.log(`⏰ 开始时间: ${new Date().toLocaleString('zh-CN')}`);
    console.log(`${'='.repeat(70)}\n`);

    try {
      await this.db.connect();
      
      console.log('🔧 检查/创建 pad_version_changes 表...');
      await this.db.ensureChangesTable();

      console.log(`\n📖 读取最新版本快照...`);
      const latestSnapshot = await this.db.getLatestSnapshot(padId);
      
      if (!latestSnapshot) {
        console.log(`❌ 未找到 Pad ${padId} 的快照数据`);
        return;
      }

      console.log(`✅ 读取到最新版本: ${latestSnapshot.revision}\n`);

      // 检查是否已存在该 pad 的数据
      const exists = await this.db.padExists(padId);
      
      if (exists) {
        console.log(`🔍 检测到重复的 pad_id，执行更新操作...`);
        await this.db.deletePadChanges(padId);
      } else {
        console.log(`➕ 新增 pad_id，执行插入操作...`);
      }

      console.log('🔄 开始解析 JSON 并转换...');
      
      const allChanges = [];
      let operationHistory = [];
      
      // 解析 deletions_json
      try {
        if (typeof latestSnapshot.deletions_json === 'object') {
          operationHistory = latestSnapshot.deletions_json;
        } else if (typeof latestSnapshot.deletions_json === 'string') {
          operationHistory = JSON.parse(latestSnapshot.deletions_json);
        }
      } catch (e) {
        console.error(`   ⚠️ JSON 解析失败:`, e.message);
        return;
      }

      // 将每个操作转换为变更记录
      operationHistory.forEach((operation, index) => {
        allChanges.push({
          pad_id: latestSnapshot.pad_id,
          change_order: index + 1,  // 从1开始
          behavior: operation.behavior,
          author: operation.author,
          add_start_time: operation.add_start_time,
          add_end_time: operation.add_end_time,
          delete_start_time: operation.delete_start_time,
          delete_end_time: operation.delete_end_time,
          content: operation.content
        });
      });

      console.log(`✅ 解析完成: 共 ${allChanges.length} 条操作记录\n`);

      await this.db.insertChanges(allChanges);

      console.log(`\n${'='.repeat(70)}`);
      console.log('📊 导出完成');
      console.log(`${'='.repeat(70)}`);
      console.log(`Pad ID: ${padId}`);
      console.log(`最新版本号: ${latestSnapshot.revision}`);
      console.log(`变更记录数: ${allChanges.length}`);
      console.log(`${'='.repeat(70)}\n`);

    } catch (error) {
      console.error('\n❌ 导出失败:', error);
      console.error(error.stack);
      throw error;
    } finally {
      await this.db.close();
    }
  }
}

/**
 * 主函数
 */
async function main() {
  const padId = process.argv[2];
  
  if (!padId || padId === '--help' || padId === '-h') {
    console.log(`
使用方法: node ${path.basename(__filename)} <padId>

参数:
  <padId>        要导出的 Pad ID

示例:
  node ${path.basename(__filename)} room-229

说明:
  将 pad_version_snapshots 表中的 deletions_json 字段解析并存储到 
  pad_version_changes 表中，每条操作记录作为一行数据。

增量更新策略:
  - 如果 pad_id 在表中已存在 → 删除旧记录，插入新记录
  - 如果 pad_id 在表中不存在 → 直接插入新记录
  - seq_order 按照 deletions_json 数组的顺序（从1开始）
    `);
    process.exit(0);
  }

  const exporter = new ChangeExporter();
  
  try {
    await exporter.exportChanges(padId);
    console.log('⏰ 结束时间: ' + new Date().toLocaleString('zh-CN'));
    console.log('✨ 导出完成！\n');
  } catch (error) {
    console.error('❌ 执行失败:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { ChangeExporter };

