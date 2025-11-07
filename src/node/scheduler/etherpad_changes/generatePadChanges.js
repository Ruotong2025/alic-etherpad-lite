#!/usr/bin/env node

/**
 * Pad 版本变更记录生成器 - 整合版
 * 
 * 功能：
 * 1. 使用 google-diff-match-patch 进行精确的文本差异计算
 * 2. 构建文档片段，记录每个片段的创建/删除信息
 * 3. 智能合并操作历史（检查 author + 时间 + 句子）
 * 4. 直接输出到 pad_version_changes_compare 表（无中间表）
 * 5. 一步完成，消除冗余
 * 
 * 合并策略：
 * - 合并条件：behavior 相同 + author 相同 + 时间间隔 ≤ 1小时 + 合并后仍是单句话
 * - 逐步判断：每次只尝试合并相邻的两个操作，避免跨句子合并
 * - 时间保留：合并时保留第一个操作的 start_time 和最后一个操作的 end_time
 * 
 * 数据流向：
 * - 数据源：pad_version_contents (原始版本数据)
 * - 目标表：pad_version_changes_compare (变更记录表，对比分析用)
 * 
 * 使用方法: node generatePadChanges.js <padId> [--debug]
 */

const mysql = require('mysql2/promise');
const path = require('path');
const DiffMatchPatch = require('diff-match-patch');

// 数据库配置
const DB_CONFIG = {
  host: process.env.DB_HOST || '112.74.92.135',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '1q2w3e4R',
  database: process.env.DB_NAME || 'alic',
  charset: 'utf8mb4',
  port: process.env.DB_PORT || 3306
};

// 调试模式
let DEBUG_MODE = false;

/**
 * 调试日志
 */
function debugLog(...args) {
  if (DEBUG_MODE) {
    console.log('[DEBUG]', ...args);
  }
}

/**
 * 文本差异计算器 - 使用 google-diff-match-patch
 */
class TextDiffCalculator {
  constructor() {
    this.dmp = new DiffMatchPatch();
    this.dmp.Diff_Timeout = 2.0;
    this.dmp.Diff_EditCost = 4;
  }

  calculateDiff(oldText, newText) {
    if (!oldText && !newText) return [];
    if (!oldText) return [{ type: 'insert', oldPosition: 0, newPosition: 0, content: newText }];
    if (!newText) return [{ type: 'delete', oldPosition: 0, newPosition: 0, length: oldText.length, content: oldText }];

    const diffs = this.dmp.diff_main(oldText, newText);
    this.dmp.diff_cleanupSemantic(diffs);
    
    debugLog(`Diff结果数量: ${diffs.length}`);
    
    const operations = [];
    let oldPos = 0;
    let newPos = 0;
    
    for (const [operation, text] of diffs) {
      if (operation === DiffMatchPatch.DIFF_DELETE) {
        operations.push({
          type: 'delete',
          oldPosition: oldPos,
          newPosition: newPos,
          length: text.length,
          content: text
        });
        debugLog(`删除操作: 旧位置=${oldPos}, 新位置=${newPos}, 长度=${text.length}`);
        oldPos += text.length;
      } else if (operation === DiffMatchPatch.DIFF_INSERT) {
        operations.push({
          type: 'insert',
          oldPosition: oldPos,
          newPosition: newPos,
          content: text
        });
        debugLog(`插入操作: 旧位置=${oldPos}, 新位置=${newPos}, 长度=${text.length}`);
        newPos += text.length;
      } else if (operation === DiffMatchPatch.DIFF_EQUAL) {
        oldPos += text.length;
        newPos += text.length;
      }
    }
    
    return operations;
  }
}

/**
 * 文档片段管理器
 */
class DocumentSegmentManager {
  constructor() {
    this.segments = [];
    this.sentenceSplitter = null;
  }

  initSentenceSplitter() {
    if (!this.sentenceSplitter) {
      const SentenceSplitter = require('./SentenceSplitter');
      this.sentenceSplitter = new SentenceSplitter();
      this.sentenceSplitter.init();
    }
  }

  cleanupSentenceSplitter() {
    if (this.sentenceSplitter) {
      this.sentenceSplitter.close();
      this.sentenceSplitter = null;
    }
  }

  initialize(text, authorId, timestamp) {
    this.segments = [{
      type: 'normal',
      content: text,
      version: 0,
      author: authorId || '',
      timestamp: timestamp || Date.now()
    }];
    debugLog(`文档初始化: ${text.length} 字符`);
  }

  applyChanges(operations, version, authorId, timestamp) {
    debugLog(`\n应用 ${operations.length} 个操作到版本 ${version}`);
    
    const deletes = operations.filter(op => op.type === 'delete' && op.length > 0);
    const inserts = operations.filter(op => op.type === 'insert');
    
    const sortedDeletes = [...deletes].sort((a, b) => b.oldPosition - a.oldPosition);
    for (const op of sortedDeletes) {
      this._applyDeletion(op.oldPosition, op.length, version, authorId, timestamp);
    }
    
    const sortedInserts = [...inserts].sort((a, b) => a.oldPosition - b.oldPosition);
    let cumulativeInsertOffset = 0;
    
    for (const op of sortedInserts) {
      let basePosition = op.oldPosition;
      for (const del of deletes) {
        if (del.oldPosition < op.oldPosition) {
          basePosition -= del.length;
        }
      }
      
      const actualPosition = basePosition + cumulativeInsertOffset;
      this._applyInsertion(actualPosition, op.content, version, authorId, timestamp);
      cumulativeInsertOffset += op.content.length;
    }
    
    debugLog(`片段数量: ${this.segments.length}`);
  }

  _applyDeletion(position, length, version, authorId, timestamp) {
    debugLog(`  执行删除: 位置=${position}, 长度=${length}`);
    
    let currentPos = 0;
    let remainingLength = length;
    let segmentIndex = 0;
    
    while (segmentIndex < this.segments.length && remainingLength > 0) {
      const segment = this.segments[segmentIndex];
      
      if (segment.type !== 'normal') {
        segmentIndex++;
        continue;
      }
      
      const segmentEndPos = currentPos + segment.content.length;
      
      if (position >= segmentEndPos) {
        currentPos = segmentEndPos;
        segmentIndex++;
        continue;
      }
      
      const offsetInSegment = Math.max(0, position - currentPos);
      const deleteInThisSegment = Math.min(remainingLength, segment.content.length - offsetInSegment);
      
      if (offsetInSegment === 0 && deleteInThisSegment === segment.content.length) {
        segment.type = 'deleted';
        segment.deletedAt = version;
        segment.deletedAuthor = authorId;
        segment.deletedTimestamp = timestamp;
      } else if (offsetInSegment === 0) {
        const deletedPart = segment.content.substring(0, deleteInThisSegment);
        const remainingPart = segment.content.substring(deleteInThisSegment);
        
        this.segments.splice(segmentIndex, 1,
          { 
            type: 'deleted', 
            content: deletedPart, 
            version: segment.version, 
            author: segment.author,
            timestamp: segment.timestamp,
            deletedAt: version,
            deletedAuthor: authorId,
            deletedTimestamp: timestamp
          },
          { 
            type: 'normal', 
            content: remainingPart, 
            version: segment.version,
            author: segment.author,
            timestamp: segment.timestamp
          }
        );
      } else if (offsetInSegment + deleteInThisSegment === segment.content.length) {
        const keepPart = segment.content.substring(0, offsetInSegment);
        const deletedPart = segment.content.substring(offsetInSegment);
        
        this.segments.splice(segmentIndex, 1,
          { 
            type: 'normal', 
            content: keepPart, 
            version: segment.version,
            author: segment.author,
            timestamp: segment.timestamp
          },
          { 
            type: 'deleted', 
            content: deletedPart, 
            version: segment.version,
            author: segment.author,
            timestamp: segment.timestamp,
            deletedAt: version,
            deletedAuthor: authorId,
            deletedTimestamp: timestamp
          }
        );
      } else {
        const beforePart = segment.content.substring(0, offsetInSegment);
        const deletedPart = segment.content.substring(offsetInSegment, offsetInSegment + deleteInThisSegment);
        const afterPart = segment.content.substring(offsetInSegment + deleteInThisSegment);
        
        this.segments.splice(segmentIndex, 1,
          { 
            type: 'normal', 
            content: beforePart, 
            version: segment.version,
            author: segment.author,
            timestamp: segment.timestamp
          },
          { 
            type: 'deleted', 
            content: deletedPart, 
            version: segment.version,
            author: segment.author,
            timestamp: segment.timestamp,
            deletedAt: version,
            deletedAuthor: authorId,
            deletedTimestamp: timestamp
          },
          { 
            type: 'normal', 
            content: afterPart, 
            version: segment.version,
            author: segment.author,
            timestamp: segment.timestamp
          }
        );
      }
      
      remainingLength -= deleteInThisSegment;
      currentPos += segment.content.length;
      segmentIndex++;
    }
    
    if (remainingLength > 0) {
      console.warn(`⚠️ 警告: 删除操作未完全执行，剩余 ${remainingLength} 字符`);
    }
  }

  _applyInsertion(position, content, version, authorId, timestamp) {
    debugLog(`  执行插入: 位置=${position}, 内容长度=${content.length}`);
    
    let currentPos = 0;
    let totalNormalLength = 0;
    
    for (let i = 0; i < this.segments.length; i++) {
      if (this.segments[i].type === 'normal') {
        totalNormalLength += this.segments[i].content.length;
      }
    }
    
    if (position === totalNormalLength) {
      this.segments.push({
        type: 'normal',
        content: content,
        version: version,
        author: authorId,
        timestamp: timestamp
      });
      debugLog(`    追加到文档末尾`);
      return;
    }
    
    currentPos = 0;
    for (let i = 0; i < this.segments.length; i++) {
      const segment = this.segments[i];
      
      if (segment.type !== 'normal') {
        continue;
      }
      
      const segmentEndPos = currentPos + segment.content.length;
      
      if (position === currentPos) {
        this.segments.splice(i, 0, {
          type: 'normal',
          content: content,
          version: version,
          author: authorId,
          timestamp: timestamp
        });
        debugLog(`    在片段 ${i} 前插入`);
        return;
      } else if (position > currentPos && position < segmentEndPos) {
        const offset = position - currentPos;
        const beforePart = segment.content.substring(0, offset);
        const afterPart = segment.content.substring(offset);
        
        this.segments.splice(i, 1,
          { 
            type: 'normal', 
            content: beforePart, 
            version: segment.version,
            author: segment.author,
            timestamp: segment.timestamp
          },
          { 
            type: 'normal', 
            content: content, 
            version: version,
            author: authorId,
            timestamp: timestamp
          },
          { 
            type: 'normal', 
            content: afterPart, 
            version: segment.version,
            author: segment.author,
            timestamp: segment.timestamp
          }
        );
        debugLog(`    在片段 ${i} 中间插入`);
        return;
      }
      
      currentPos = segmentEndPos;
    }
    
    this.segments.push({
      type: 'normal',
      content: content,
      version: version,
      author: authorId,
      timestamp: timestamp
    });
    debugLog(`    追加到末尾（兜底）`);
  }

  formatHKTime(timestamp) {
    if (!timestamp) return '';
    
    const date = new Date(timestamp);
    const hkTimeStr = date.toLocaleString('zh-CN', {
      timeZone: 'Asia/Hong_Kong',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    
    return hkTimeStr.replace(/\//g, '-').replace(',', '');
  }

  async buildAndMergeOperationHistory() {
    if (this.segments.length === 0) return [];
    
    this.initSentenceSplitter();
    
    // ✅ 按照原始逻辑：按文档位置顺序遍历 segments 并合并
    // 这与 generatePadVersionSnapshots.js 的逻辑一致
    const TIME_THRESHOLD = 3600000;  // 1小时
    const mergedHistory = [];
    let current = null;
    
    for (const segment of this.segments) {
      // 1. 构建当前片段的操作对象
      let operation = null;
      
      if (segment.type === 'normal') {
        operation = {
          behavior: 'add',
          author: segment.author || '',
          start_time: this.formatHKTime(segment.timestamp),
          end_time: this.formatHKTime(segment.timestamp),
          start_timestamp: segment.timestamp,
          end_timestamp: segment.timestamp,
          content: segment.content
        };
      } else if (segment.type === 'deleted') {
        operation = {
          behavior: 'deleted',
          author: segment.deletedAuthor || segment.author || '',
          start_time: this.formatHKTime(segment.timestamp),
          end_time: this.formatHKTime(segment.deletedTimestamp),
          start_timestamp: segment.timestamp,
          end_timestamp: segment.deletedTimestamp,
          content: segment.content
        };
      }
      
      if (!operation) continue;
      
      // 2. 如果是第一个操作，直接设为 current
      if (!current) {
        current = operation;
        continue;
      }
      
      // 3. 检查基本合并条件
      const timeGap = operation.start_timestamp - current.end_timestamp;
      const canMergeBasic = (
        current.behavior === operation.behavior && 
        current.author === operation.author &&
        timeGap >= 0 && 
        timeGap <= TIME_THRESHOLD
      );
      
      if (!canMergeBasic) {
        // 基本条件不满足，不合并
        if (timeGap > TIME_THRESHOLD) {
          debugLog(`[Skip] Time gap too large: ${(timeGap / 1000 / 60).toFixed(1)} minutes`);
        } else {
          debugLog(`[Skip] Different behavior or author`);
        }
        mergedHistory.push(this._cleanupOperation(current));
        current = operation;
        continue;
      }
      
      // 4. 基本条件满足，检查句子级别约束
      const mergedContent = current.content + operation.content;
      
      try {
        const sentenceCount = await this.sentenceSplitter.countSentences(mergedContent);
        
        debugLog(`[Merge Check] Content: "${mergedContent.substring(0, 50)}...", Sentences: ${sentenceCount}, Time gap: ${(timeGap / 1000).toFixed(1)}s`);
        
        if (sentenceCount <= 1) {
          // 可以合并
          current.content = mergedContent;
          current.end_time = operation.end_time;
          current.end_timestamp = operation.end_timestamp;
          debugLog(`[Merge Success] Merged, total length: ${mergedContent.length}`);
          continue;
        } else {
          // 合并后会产生多个句子，不合并
          debugLog(`[Merge Skip] Would create ${sentenceCount} sentences, keeping separate`);
          mergedHistory.push(this._cleanupOperation(current));
          current = operation;
        }
      } catch (error) {
        console.error(`[Sentence Count Error] ${error.message}, defaulting to no merge`);
        mergedHistory.push(this._cleanupOperation(current));
        current = operation;
      }
    }
    
    // 5. 添加最后一个操作
    if (current) {
      mergedHistory.push(this._cleanupOperation(current));
    }
    
    return mergedHistory;
  }

  _cleanupOperation(operation) {
    const { start_timestamp, end_timestamp, ...cleaned } = operation;
    return cleaned;
  }

  extractPureText() {
    let result = '';
    for (const segment of this.segments) {
      if (segment.type === 'normal') {
        result += segment.content;
      }
    }
    return result;
    }
  }

  /**
 * 变更构建器
 */
class ChangeBuilder {
  constructor() {
    this.diffCalculator = new TextDiffCalculator();
    this.docManager = new DocumentSegmentManager();
  }

  initialize(text, authorId, timestamp) {
    this.docManager.initialize(text, authorId, timestamp);
  }

  applyVersion(prevContent, currContent, version, authorId, timestamp) {
    debugLog(`\n=== 应用版本 ${version} ===`);
    debugLog(`上一版本长度: ${prevContent.length}`);
    debugLog(`当前版本长度: ${currContent.length}`);
    
    const operations = this.diffCalculator.calculateDiff(prevContent, currContent);
    
    if (operations.length > 0) {
      this.docManager.applyChanges(operations, version, authorId, timestamp);
      } else {
      debugLog(`版本 ${version} 无变更`);
    }
  }

  async getChanges() {
    const mergedHistory = await this.docManager.buildAndMergeOperationHistory();
    return {
      changes: mergedHistory,
      pureText: this.docManager.extractPureText()
    };
  }

  validateContent(expectedText) {
    const pureText = this.docManager.extractPureText();
    const isValid = pureText === expectedText;
    
    if (!isValid) {
      console.error(`\n❌ 内容验证失败！`);
      console.error(`期望文本长度: ${expectedText.length}`);
      console.error(`实际文本长度: ${pureText.length}`);
      console.error(`差异字符数: ${Math.abs(expectedText.length - pureText.length)}`);
    }
    
    return {
      isValid,
      expectedLength: expectedText.length,
      actualLength: pureText.length,
      difference: Math.abs(expectedText.length - pureText.length)
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

  async createChangesTable() {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS pad_version_changes_compare (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        pad_id VARCHAR(255) NOT NULL COMMENT 'Pad ID',
        revision INT NOT NULL COMMENT '最终版本号（用于追溯）',
        seq_order INT NOT NULL COMMENT '操作顺序（从1开始）',
        behavior VARCHAR(20) NOT NULL COMMENT '操作类型：add 或 deleted',
        author VARCHAR(255) NOT NULL COMMENT '作者ID',
        start_time VARCHAR(50) NOT NULL COMMENT '开始时间（香港时间）',
        end_time VARCHAR(50) NOT NULL COMMENT '结束时间（香港时间）',
        content LONGTEXT NOT NULL COMMENT '操作内容',
        content_length INT COMMENT '内容长度',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        INDEX idx_pad_id (pad_id),
        INDEX idx_pad_revision (pad_id, revision),
        INDEX idx_behavior (behavior),
        INDEX idx_author (author)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci 
        COMMENT='Pad版本变更详细记录表（对比分析用）'
    `;

    await this.connection.execute(createTableSQL);
    console.log('✅ 变更表检查/创建完成（pad_version_changes_compare）');
  }

  async getPadVersions(padId) {
    // ✅ 从 pad_version_contents_merge 读取合并后的版本
    // 这与 generatePadVersionSnapshots.js 的逻辑一致
    const query = `
      SELECT pad_id, revision, content, author_id, timestamp
      FROM pad_version_contents_merge
      WHERE pad_id = ?
      ORDER BY revision ASC
    `;
    
    const [rows] = await this.connection.execute(query, [padId]);
    return rows;
  }

  async clearPadChanges(padId) {
    await this.connection.execute(
      'DELETE FROM pad_version_changes_compare WHERE pad_id = ?',
      [padId]
    );
    console.log('🗑️  清理旧的变更记录');
  }

  async insertChange(change) {
    const query = `
      INSERT INTO pad_version_changes_compare 
      (pad_id, revision, seq_order, behavior, author, start_time, end_time, content, content_length)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    await this.connection.execute(query, [
      change.pad_id,
      change.revision,
      change.seq_order,
      change.behavior,
      change.author,
      change.start_time,
      change.end_time,
      change.content,
      change.content.length
    ]);
  }

  async insertChanges(changes) {
    if (changes.length === 0) return;

    console.log(`💾 开始保存 ${changes.length} 条变更记录...`);
    
    let successCount = 0;

    for (const change of changes) {
      try {
      await this.insertChange(change);
        successCount++;
        
        if (successCount % 100 === 0) {
          console.log(`   进度: ${successCount}/${changes.length}`);
        }
      } catch (error) {
        console.error(`   ❌ 保存失败 (Order=${change.seq_order}):`, error.message);
      }
    }

    console.log(`✅ 保存完成: 成功 ${successCount}/${changes.length}`);
  }
}

/**
 * 主生成器类
 */
class PadChangeGenerator {
  constructor() {
    this.db = new DatabaseManager();
    this.changeBuilder = new ChangeBuilder();
    this.validationErrors = [];
  }

  async generateChanges(padId) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🚀 Pad 版本变更记录生成工具 - 整合版`);
    console.log(`${'='.repeat(70)}`);
    console.log(`📝 目标 Pad: ${padId}`);
    console.log(`⏰ 开始时间: ${new Date().toLocaleString('zh-CN')}`);
    console.log(`🔍 调试模式: ${DEBUG_MODE ? '开启' : '关闭'}`);
    console.log(`${'='.repeat(70)}\n`);

    try {
      await this.db.connect();

      console.log('🔧 检查/创建变更表...');
      await this.db.createChangesTable();

      console.log(`\n📖 从 pad_version_contents 读取版本数据...`);
      const versions = await this.db.getPadVersions(padId);
      
      if (versions.length === 0) {
        console.log(`❌ 未找到 Pad ${padId} 的版本数据`);
        return;
      }

      console.log(`✅ 读取到 ${versions.length} 个版本\n`);

      await this.db.clearPadChanges(padId);

      console.log('🔄 开始构建变更记录...');
      console.log(`   总版本数: ${versions.length}\n`);

      // 初始化第一个版本
      const firstContent = versions[0].content || '';
      const firstAuthorId = versions[0].author_id || '';
      const firstTimestamp = versions[0].timestamp || Date.now();
      
      this.changeBuilder.initialize(firstContent, firstAuthorId, firstTimestamp);

      // 逐版本处理
      for (let i = 1; i < versions.length; i++) {
        const prevVersion = versions[i - 1];
        const currVersion = versions[i];
        
        if (i % 10 === 0 || i === versions.length - 1) {
          console.log(`处理版本 ${currVersion.revision} (${i + 1}/${versions.length})...`);
        }

        this.changeBuilder.applyVersion(
          prevVersion.content || '',
          currVersion.content || '',
          currVersion.revision,
          currVersion.author_id || '',
          currVersion.timestamp || Date.now()
        );

        // 验证内容
        const validation = this.changeBuilder.validateContent(currVersion.content || '');
        if (!validation.isValid) {
          this.validationErrors.push({ revision: currVersion.revision, ...validation });
          console.error(`❌ 版本 ${currVersion.revision} 验证失败`);
        }
      }

      console.log('\n✅ 变更记录构建完成\n');

      // ✅ 关键改动：只从最后一个版本获取操作历史
      // 这样可以确保操作历史的顺序与文档片段的顺序一致
      console.log('🔄 合并操作历史...');
      const result = await this.changeBuilder.getChanges();
      
      // 清理句子分割器资源
      this.changeBuilder.docManager.cleanupSentenceSplitter();

      console.log(`✅ 合并完成: 共 ${result.changes.length} 条变更记录\n`);

      // 准备插入数据库的变更记录
      // ✅ seq_order 按照操作历史数组的顺序（index + 1）
      // 这个顺序反映了文档片段在文档中的位置顺序
      const changes = result.changes.map((change, index) => ({
          pad_id: padId,
        revision: versions[versions.length - 1].revision,  // 最终版本号
        seq_order: index + 1,  // 操作顺序从1开始
        behavior: change.behavior,
        author: change.author,
        start_time: change.start_time,
        end_time: change.end_time,
        content: change.content
      }));

      // 保存到数据库
      await this.db.insertChanges(changes);

      console.log(`\n${'='.repeat(70)}`);
      console.log('📊 变更记录生成完成');
      console.log(`${'='.repeat(70)}`);
      console.log(`Pad ID: ${padId}`);
      console.log(`总版本数: ${versions.length}`);
      console.log(`最终版本号: ${versions[versions.length - 1].revision}`);
      console.log(`变更记录数: ${changes.length}`);
      console.log(`添加操作: ${changes.filter(c => c.behavior === 'add').length}`);
      console.log(`删除操作: ${changes.filter(c => c.behavior === 'deleted').length}`);
      console.log(`验证错误数: ${this.validationErrors.length}`);
      
      if (this.validationErrors.length > 0) {
        console.log(`\n⚠️ 警告: 发现 ${this.validationErrors.length} 个版本验证失败`);
        console.log('失败的版本:');
        this.validationErrors.forEach(err => {
          console.log(`  - 版本 ${err.revision}: 期望长度=${err.expectedLength}, 实际长度=${err.actualLength}, 差异=${err.difference}`);
        });
      }
      
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
  const args = process.argv.slice(2);
  const padId = args.find(arg => !arg.startsWith('--'));
  DEBUG_MODE = args.includes('--debug') || args.includes('-d');
  
  if (!padId || args.includes('--help') || args.includes('-h')) {
    console.log(`
使用方法: node ${path.basename(__filename)} <padId> [选项]

参数:
  <padId>        要生成变更记录的 Pad ID

选项:
  --debug, -d    开启调试模式，显示详细日志
  --help, -h     显示帮助信息

示例:
  node ${path.basename(__filename)} room-229
  node ${path.basename(__filename)} room-229 --debug

说明:
  整合版变更记录生成工具
  - 一步完成：从版本内容直接生成变更记录
  - 消除冗余：不保存中间快照，直接输出变更表
  - 智能合并：支持 author + 时间 + 句子级别的合并判断
  - 数据源：pad_version_contents
  - 目标表：pad_version_changes_compare
    `);
    process.exit(0);
  }

  const generator = new PadChangeGenerator();
  
  try {
    await generator.generateChanges(padId);
    console.log('⏰ 结束时间: ' + new Date().toLocaleString('zh-CN'));
    console.log('✨ 变更记录生成完成！\n');
  } catch (error) {
    console.error('❌ 执行失败:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { PadChangeGenerator, ChangeBuilder, DocumentSegmentManager };
