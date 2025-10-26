#!/usr/bin/env node

/**
 * 将 pad_version_snapshots.deletions_json 解析并存储到 pad_version_changes 表
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
   * 创建 pad_version_changes 表
   */
  async createChangesTable() {
    // 先删除旧表（如果存在）
    await this.connection.execute('DROP TABLE IF EXISTS pad_version_changes');
    
    const createTableSQL = `
      CREATE TABLE pad_version_changes (
        id BIGINT AUTO_INCREMENT,
        pad_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Pad ID',
        seq_order INT NOT NULL COMMENT '操作顺序（从1开始）',
        behavior VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '操作类型：add 或 deleted',
        author VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '作者ID',
        start_time VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '开始时间（香港时间）',
        end_time VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '结束时间（香港时间）',
        content LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '操作内容',
        PRIMARY KEY (id) USING BTREE,
        INDEX idx_pad_id(pad_id ASC) USING BTREE
      ) COMMENT='Pad版本变更详细记录表（仅保存最新版本）' ROW_FORMAT=Dynamic;
    `;

    await this.connection.execute(createTableSQL);
    console.log('✅ pad_version_changes 表创建完成');
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
   * 清空指定 pad 的变更记录
   */
  async clearChanges(padId) {
    await this.connection.execute(
      'DELETE FROM pad_version_changes WHERE pad_id = ?',
      [padId]
    );
    console.log('🗑️  清理旧的变更记录');
  }

  /**
   * 批量插入变更记录
   */
  async insertChanges(changes) {
    if (changes.length === 0) return;

    console.log(`💾 开始保存 ${changes.length} 条变更记录...`);
    
    const query = `
      INSERT INTO pad_version_changes 
      (pad_id, seq_order, behavior, author, start_time, end_time, content)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    let successCount = 0;
    
    for (const change of changes) {
      try {
        await this.connection.execute(query, [
          change.pad_id,
          change.change_order,
          change.behavior,
          change.author,
          change.start_time,
          change.end_time,
          change.content
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
      await this.db.createChangesTable();

      console.log(`\n📖 读取最新版本快照...`);
      const latestSnapshot = await this.db.getLatestSnapshot(padId);
      
      if (!latestSnapshot) {
        console.log(`❌ 未找到 Pad ${padId} 的快照数据`);
        return;
      }

      console.log(`✅ 读取到最新版本: ${latestSnapshot.revision}\n`);

      await this.db.clearChanges(padId);

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
          start_time: operation.start_time,
          end_time: operation.end_time,
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

