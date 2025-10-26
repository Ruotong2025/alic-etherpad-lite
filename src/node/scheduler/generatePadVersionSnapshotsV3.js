#!/usr/bin/env node

/**
 * Pad 版本快照生成器 V3 - 最终版
 * 
 * 核心思路：
 * 1. 不维护快照，只维护"文档片段列表"
 * 2. 每个片段有类型（normal/deleted）和内容
 * 3. 应用变更时，直接操作片段列表
 * 4. 最后渲染成快照文本
 * 
 * 使用方法: node generatePadVersionSnapshotsV3.js <padId>
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
 * 文本差异计算器
 */
class TextDiffCalculator {
  calculateDiff(oldText, newText) {
    if (!oldText && !newText) return [];
    if (!oldText) return [{ type: 'add', content: newText, position: 0 }];
    if (!newText) return [{ type: 'delete', content: oldText, position: 0 }];

    const operations = [];
    const lcs = this._findLCS(oldText, newText);
    
    let oldPos = 0;
    let newPos = 0;
    let lcsPos = 0;
    
    while (oldPos < oldText.length || newPos < newText.length) {
      if (lcsPos < lcs.length) {
        const lcsChar = lcs[lcsPos];
        const oldLcsPos = oldText.indexOf(lcsChar, oldPos);
        const newLcsPos = newText.indexOf(lcsChar, newPos);
        
        if (oldPos < oldLcsPos) {
          operations.push({
            type: 'delete',
            content: oldText.substring(oldPos, oldLcsPos),
            position: newPos
          });
          oldPos = oldLcsPos;
        }
        
        if (newPos < newLcsPos) {
          operations.push({
            type: 'add',
            content: newText.substring(newPos, newLcsPos),
            position: newPos
          });
          newPos = newLcsPos;
        }
        
        oldPos++;
        newPos++;
        lcsPos++;
      } else {
        if (oldPos < oldText.length) {
          operations.push({
            type: 'delete',
            content: oldText.substring(oldPos),
            position: newPos
          });
          oldPos = oldText.length;
        }
        
        if (newPos < newText.length) {
          operations.push({
            type: 'add',
            content: newText.substring(newPos),
            position: newPos
          });
          newPos = newText.length;
        }
      }
    }
    
    return this._postProcessDiffs(operations);
  }

  _findLCS(text1, text2) {
    const m = text1.length;
    const n = text2.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (text1[i - 1] === text2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }
    
    let lcs = '';
    let i = m, j = n;
    while (i > 0 && j > 0) {
      if (text1[i - 1] === text2[j - 1]) {
        lcs = text1[i - 1] + lcs;
        i--;
        j--;
      } else if (dp[i - 1][j] > dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }
    
    return lcs;
  }

  _postProcessDiffs(diffs) {
    if (diffs.length === 0) return [];
    
    const merged = [];
    let current = { ...diffs[0] };
    
    for (let i = 1; i < diffs.length; i++) {
      const next = diffs[i];
      
      if (this._canMerge(current, next)) {
        current.content += next.content;
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    
    merged.push(current);
    return merged;
  }

  _canMerge(current, next) {
    if (current.type !== next.type) return false;
    
    if (current.type === 'add') {
      return next.position === current.position + current.content.length;
    } else {
      return next.position === current.position;
    }
  }
}

/**
 * 文档片段管理器 - 核心类
 */
class DocumentSegmentManager {
  constructor() {
    this.segments = [];  // 文档片段数组
  }

  /**
   * 初始化文档
   */
  initialize(text) {
    this.segments = [{
      type: 'normal',
      content: text,
      version: 0
    }];
  }

  /**
   * 应用变更到文档片段
   */
  applyChanges(diffs, version) {
    // 按位置从后往前排序，避免位置偏移
    const sortedDiffs = [...diffs].sort((a, b) => b.position - a.position);
    
    for (const diff of sortedDiffs) {
      if (diff.type === 'delete') {
        this._applyDeletion(diff.position, diff.content.length, version);
      } else if (diff.type === 'add') {
        this._applyAddition(diff.position, diff.content, version);
      }
    }
  }

  /**
   * 应用删除操作
   */
  _applyDeletion(position, length, version) {
    const location = this._findLocation(position);
    if (!location) return;

    let { segmentIndex, offset } = location;
    let remainingLength = length;

    while (remainingLength > 0 && segmentIndex < this.segments.length) {
      const segment = this.segments[segmentIndex];

      if (segment.type !== 'normal') {
        segmentIndex++;
        continue;
      }

      const availableLength = segment.content.length - offset;
      const deleteLength = Math.min(remainingLength, availableLength);

      if (offset === 0 && deleteLength === segment.content.length) {
        // 删除整个片段
        segment.type = 'deleted';
        segment.deletedAt = version;
        segmentIndex++;
      } else if (offset === 0) {
        // 删除片段开头部分
        const deletedPart = segment.content.substring(0, deleteLength);
        const remainingPart = segment.content.substring(deleteLength);

        this.segments.splice(segmentIndex, 1,
          { type: 'deleted', content: deletedPart, version: segment.version, deletedAt: version },
          { type: 'normal', content: remainingPart, version: segment.version }
        );
        segmentIndex += 2;
      } else if (offset + deleteLength === segment.content.length) {
        // 删除片段末尾部分
        const keepPart = segment.content.substring(0, offset);
        const deletedPart = segment.content.substring(offset);

        this.segments.splice(segmentIndex, 1,
          { type: 'normal', content: keepPart, version: segment.version },
          { type: 'deleted', content: deletedPart, version: segment.version, deletedAt: version }
        );
        segmentIndex += 2;
      } else {
        // 删除片段中间部分
        const beforePart = segment.content.substring(0, offset);
        const deletedPart = segment.content.substring(offset, offset + deleteLength);
        const afterPart = segment.content.substring(offset + deleteLength);

        this.segments.splice(segmentIndex, 1,
          { type: 'normal', content: beforePart, version: segment.version },
          { type: 'deleted', content: deletedPart, version: segment.version, deletedAt: version },
          { type: 'normal', content: afterPart, version: segment.version }
        );
        segmentIndex += 3;
      }

      remainingLength -= deleteLength;
      offset = 0;  // 后续片段从头开始
    }
  }

  /**
   * 应用添加操作
   */
  _applyAddition(position, content, version) {
    const location = this._findLocation(position);
    
    if (!location) {
      // 位置在末尾，追加
      this.segments.push({
        type: 'normal',
        content: content,
        version: version
      });
      return;
    }

    const { segmentIndex, offset } = location;
    const segment = this.segments[segmentIndex];

    if (offset === 0) {
      // 在片段开头插入
      this.segments.splice(segmentIndex, 0, {
        type: 'normal',
        content: content,
        version: version
      });
    } else if (offset === segment.content.length) {
      // 在片段末尾插入
      this.segments.splice(segmentIndex + 1, 0, {
        type: 'normal',
        content: content,
        version: version
      });
    } else {
      // 在片段中间插入，需要分割
      const beforePart = segment.content.substring(0, offset);
      const afterPart = segment.content.substring(offset);

      this.segments.splice(segmentIndex, 1,
        { type: 'normal', content: beforePart, version: segment.version },
        { type: 'normal', content: content, version: version },
        { type: 'normal', content: afterPart, version: segment.version }
      );
    }
  }

  /**
   * 查找位置对应的片段和偏移
   */
  _findLocation(position) {
    let currentPos = 0;

    for (let i = 0; i < this.segments.length; i++) {
      const segment = this.segments[i];

      if (segment.type === 'normal') {
        if (currentPos + segment.content.length > position) {
          return {
            segmentIndex: i,
            offset: position - currentPos
          };
        }
        currentPos += segment.content.length;
      }
    }

    // 位置在末尾
    if (currentPos === position) {
      return {
        segmentIndex: this.segments.length,
        offset: 0
      };
    }

    return null;
  }

  /**
   * 渲染为快照文本
   */
  renderSnapshot() {
    let result = '';
    
    for (const segment of this.segments) {
      if (segment.type === 'normal') {
        result += segment.content;
      } else if (segment.type === 'deleted') {
        result += `[deleted:${segment.content}]`;
      }
    }
    
    return result;
  }

  /**
   * 提取纯净文本
   */
  extractPureText() {
    let result = '';
    
    for (const segment of this.segments) {
      if (segment.type === 'normal') {
        result += segment.content;
      }
    }
    
    return result;
  }

  /**
   * 获取删除记录
   */
  getDeletions() {
    const deletions = [];
    
    for (const segment of this.segments) {
      if (segment.type === 'deleted') {
        deletions.push({
          content: segment.content,
          version: segment.version,
          deletedAt: segment.deletedAt
        });
      }
    }
    
    return deletions;
  }
}

/**
 * 快照构建器 V3
 */
class SnapshotBuilderV3 {
  constructor() {
    this.diffCalculator = new TextDiffCalculator();
    this.docManager = new DocumentSegmentManager();
  }

  /**
   * 初始化第一个版本
   */
  initialize(text) {
    this.docManager.initialize(text);
  }

  /**
   * 应用版本变更
   */
  applyVersion(prevContent, currContent, version) {
    const diffs = this.diffCalculator.calculateDiff(prevContent, currContent);
    
    if (diffs.length > 0) {
      this.docManager.applyChanges(diffs, version);
    }
  }

  /**
   * 获取当前快照
   */
  getSnapshot() {
    return {
      snapshot: this.docManager.renderSnapshot(),
      pureText: this.docManager.extractPureText(),
      deletions: this.docManager.getDeletions()
    };
  }
}

/**
 * 数据库管理器
 */
class DatabaseManager {
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

  async createSnapshotTable() {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS pad_version_snapshots (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        pad_id VARCHAR(255) NOT NULL,
        revision INT NOT NULL,
        snapshot_text LONGTEXT NOT NULL,
        pure_text LONGTEXT NOT NULL,
        author_id VARCHAR(255) DEFAULT '',
        timestamp BIGINT NOT NULL,
        deletion_count INT DEFAULT 0,
        deletions_json JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        UNIQUE KEY unique_pad_revision (pad_id, revision),
        INDEX idx_pad_id (pad_id),
        INDEX idx_revision (revision)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `;

    await this.connection.execute(createTableSQL);
    console.log('✅ 快照表检查/创建完成');
  }

  async getPadVersions(padId) {
    const query = `
      SELECT pad_id, revision, content, author_id, timestamp
      FROM pad_version_contents_merge
      WHERE pad_id = ?
      ORDER BY revision ASC
    `;
    
    const [rows] = await this.connection.execute(query, [padId]);
    return rows;
  }

  async clearPadSnapshots(padId) {
    await this.connection.execute(
      'DELETE FROM pad_version_snapshots WHERE pad_id = ?',
      [padId]
    );
    console.log('🗑️  清理旧的快照数据');
  }

  async insertSnapshot(snapshot) {
    const query = `
      INSERT INTO pad_version_snapshots 
      (pad_id, revision, snapshot_text, pure_text, author_id, timestamp, deletion_count, deletions_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    await this.connection.execute(query, [
      snapshot.pad_id,
      snapshot.revision,
      snapshot.snapshot_text,
      snapshot.pure_text,
      snapshot.author_id,
      snapshot.timestamp,
      snapshot.deletion_count,
      JSON.stringify(snapshot.deletions)
    ]);
  }

  async insertSnapshots(snapshots) {
    if (snapshots.length === 0) return;

    console.log(`💾 开始保存 ${snapshots.length} 个快照...`);
    
    let successCount = 0;

    for (const snapshot of snapshots) {
      try {
        await this.insertSnapshot(snapshot);
        successCount++;
        
        if (successCount % 10 === 0) {
          console.log(`   进度: ${successCount}/${snapshots.length}`);
        }
      } catch (error) {
        console.error(`   ❌ 保存版本 ${snapshot.revision} 失败:`, error.message);
      }
    }

    console.log(`✅ 保存完成: 成功 ${successCount}`);
  }
}

/**
 * 主生成器类
 */
class PadSnapshotGeneratorV3 {
  constructor() {
    this.db = new DatabaseManager();
    this.snapshotBuilder = new SnapshotBuilderV3();
  }

  async generateSnapshots(padId) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🚀 Pad 版本快照生成工具 V3 - 文档片段法`);
    console.log(`${'='.repeat(70)}`);
    console.log(`📝 目标 Pad: ${padId}`);
    console.log(`⏰ 开始时间: ${new Date().toLocaleString('zh-CN')}`);
    console.log(`${'='.repeat(70)}\n`);

    try {
      await this.db.connect();
      
      console.log('🔧 检查/创建快照表...');
      await this.db.createSnapshotTable();

      console.log(`\n📖 从 pad_version_contents_merge 读取版本数据...`);
      const versions = await this.db.getPadVersions(padId);
      
      if (versions.length === 0) {
        console.log(`❌ 未找到 Pad ${padId} 的版本数据`);
        return;
      }

      console.log(`✅ 读取到 ${versions.length} 个版本\n`);

      await this.db.clearPadSnapshots(padId);

      console.log('📸 开始构建版本快照...');
      console.log(`   总版本数: ${versions.length}`);
      
      const snapshots = [];

      // 初始化第一个版本
      this.snapshotBuilder.initialize(versions[0].content || '');
      
      const firstSnapshot = this.snapshotBuilder.getSnapshot();
      snapshots.push({
        pad_id: padId,
        revision: versions[0].revision,
        snapshot_text: firstSnapshot.snapshot,
        pure_text: firstSnapshot.pureText,
        author_id: versions[0].author_id || '',
        timestamp: versions[0].timestamp || Date.now(),
        deletion_count: 0,
        deletions: []
      });

      // 逐版本处理
      for (let i = 1; i < versions.length; i++) {
        const prevVersion = versions[i - 1];
        const currVersion = versions[i];

        this.snapshotBuilder.applyVersion(
          prevVersion.content || '',
          currVersion.content || '',
          currVersion.revision
        );

        const result = this.snapshotBuilder.getSnapshot();

        snapshots.push({
          pad_id: padId,
          revision: currVersion.revision,
          snapshot_text: result.snapshot,
          pure_text: result.pureText,
          author_id: currVersion.author_id || '',
          timestamp: currVersion.timestamp || Date.now(),
          deletion_count: result.deletions.length,
          deletions: result.deletions
        });

        if ((i + 1) % 10 === 0 || i === versions.length - 1) {
          console.log(`   ✓ 处理进度: ${i + 1}/${versions.length}`);
        }
      }

      console.log('✅ 快照构建完成\n');

      await this.db.insertSnapshots(snapshots);

      console.log(`\n${'='.repeat(70)}`);
      console.log('📊 快照生成完成');
      console.log(`${'='.repeat(70)}`);
      console.log(`Pad ID: ${padId}`);
      console.log(`总版本数: ${versions.length}`);
      console.log(`累积删除次数: ${snapshots[snapshots.length - 1].deletion_count}`);
      console.log(`${'='.repeat(70)}\n`);

    } catch (error) {
      console.error('\n❌ 生成失败:', error);
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

示例:
  node ${path.basename(__filename)} room-229

说明:
  V3 最终版 - 使用文档片段法
  维护文档片段列表，精确追踪每个删除操作的位置
    `);
    process.exit(0);
  }

  const generator = new PadSnapshotGeneratorV3();
  
  try {
    await generator.generateSnapshots(padId);
    console.log('⏰ 结束时间: ' + new Date().toLocaleString('zh-CN'));
    console.log('✨ 快照生成完成！\n');
  } catch (error) {
    console.error('❌ 执行失败:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { PadSnapshotGeneratorV3, SnapshotBuilderV3, DocumentSegmentManager };

