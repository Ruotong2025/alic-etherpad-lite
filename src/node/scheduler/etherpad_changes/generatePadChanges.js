#!/usr/bin/env node

/**
 * Pad 版本变更记录生成工具（合并版 - 使用临时表）
 * 
 * 功能流程：
 * 1. 从 pad_version_contents 读取版本数据
 * 2. 生成版本快照到临时表 pad_version_snapshots_temp
 * 3. 解析临时表的 deletions_json 并导出到 pad_version_changes_compare
 * 4. 删除临时表
 * 
 * 核心改进：
 * - 使用 google-diff-match-patch 库进行精确的文本差异计算
 * - 增加快照验证机制，确保删除标记后与当前版本一致
 * - 添加详细的调试日志
 * - 集成 NLTK 句子级别合并判断
 * - 统一合并逻辑：移除片段级合并，只在构建操作历史时合并一次
 * 
 * 使用方法: node generatePadChanges.js <padId> [--debug]
 * 
 * 示例:
 *   node generatePadChanges.js room-229
 *   node generatePadChanges.js room-229 --debug
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
      } else {
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
      
      debugLog(`    插入调整: 旧位置=${op.oldPosition}, 基础位置=${basePosition}, 累积偏移=${cumulativeInsertOffset}, 实际位置=${actualPosition}`);
      
      this._applyInsertion(actualPosition, op.content, version, authorId, timestamp);
      
      cumulativeInsertOffset += op.content.length;
    }
    
    debugLog(`片段数量: ${this.segments.length}`);
  }

  _applyDeletion(position, length, version, authorId, timestamp) {
    debugLog(`  执行删除: 起始位置=${position}, 长度=${length}`);
    
    if (length <= 0) {
      debugLog(`  ⚠️ 删除长度为0，跳过`);
      return;
    }
    
    const deleteStart = position;
    const deleteEnd = position + length;
    let currentPos = 0;
    let segmentIndex = 0;
    
    debugLog(`  删除范围: [${deleteStart}, ${deleteEnd})`);
    
    while (segmentIndex < this.segments.length) {
      const segment = this.segments[segmentIndex];
      
      if (segment.type !== 'normal') {
        segmentIndex++;
        continue;
      }
      
      const segmentStart = currentPos;
      const segmentEnd = currentPos + segment.content.length;
      
      debugLog(`    检查片段 [${segmentIndex}]: 范围[${segmentStart}, ${segmentEnd}), 内容="${segment.content}"`);
      
      if (deleteEnd <= segmentStart) {
        debugLog(`    删除范围在片段之前，结束`);
        break;
      }
      
      if (deleteStart >= segmentEnd) {
        debugLog(`    删除范围在片段之后，继续`);
        currentPos = segmentEnd;
        segmentIndex++;
        continue;
      }
      
      const overlapStart = Math.max(deleteStart, segmentStart);
      const overlapEnd = Math.min(deleteEnd, segmentEnd);
      const overlapStartInSegment = overlapStart - segmentStart;
      const overlapEndInSegment = overlapEnd - segmentStart;
      const overlapLength = overlapEndInSegment - overlapStartInSegment;
      
      debugLog(`    交集: 片段内[${overlapStartInSegment}, ${overlapEndInSegment}), 长度=${overlapLength}`);
      
      if (overlapStartInSegment === 0 && overlapEndInSegment === segment.content.length) {
        segment.type = 'deleted';
        segment.deletedAt = version;
        segment.deletedAuthor = authorId;
        segment.deletedTimestamp = timestamp;
        debugLog(`    → 删除整个片段 "${segment.content}"`);
        currentPos = segmentEnd;
        segmentIndex++;
      } else if (overlapStartInSegment === 0) {
        const deletedPart = segment.content.substring(0, overlapEndInSegment);
        const keepPart = segment.content.substring(overlapEndInSegment);
        
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
            content: keepPart, 
            version: segment.version,
            author: segment.author,
            timestamp: segment.timestamp
          }
        );
        debugLog(`    → 删除开头 "${deletedPart}"，保留 "${keepPart}"`);
        currentPos = segmentEnd;
        segmentIndex += 2;
      } else if (overlapEndInSegment === segment.content.length) {
        const keepPart = segment.content.substring(0, overlapStartInSegment);
        const deletedPart = segment.content.substring(overlapStartInSegment);
        
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
        debugLog(`    → 保留开头 "${keepPart}"，删除末尾 "${deletedPart}"`);
        currentPos = segmentEnd;
        segmentIndex += 2;
      } else {
        const beforePart = segment.content.substring(0, overlapStartInSegment);
        const deletedPart = segment.content.substring(overlapStartInSegment, overlapEndInSegment);
        const afterPart = segment.content.substring(overlapEndInSegment);
        
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
        debugLog(`    → 保留前 "${beforePart}"，删除中间 "${deletedPart}"，保留后 "${afterPart}"`);
        currentPos = segmentEnd;
        segmentIndex += 3;
      }
    }
    
    debugLog(`  删除完成`);
  }

  _applyInsertion(position, content, version, authorId, timestamp) {
    debugLog(`  执行插入: 位置=${position}, 内容长度=${content.length}`);
    
    let currentPos = 0;
    let lastNormalSegmentIndex = -1;
    let totalNormalLength = 0;
    
    for (let i = 0; i < this.segments.length; i++) {
      if (this.segments[i].type === 'normal') {
        totalNormalLength += this.segments[i].content.length;
        lastNormalSegmentIndex = i;
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
      debugLog(`    追加到文档末尾（位置 ${position} = 总 normal 长度 ${totalNormalLength}）`);
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
        debugLog(`    在片段 ${i} 中间插入（偏移 ${offset}）`);
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

  renderSnapshot() {
    let result = '';
    
    for (const segment of this.segments) {
      if (segment.type === 'normal') {
        result += segment.content;
      }
    }
    
    return result;
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

  getDebugInfo() {
    return {
      totalSegments: this.segments.length,
      normalSegments: this.segments.filter(s => s.type === 'normal').length,
      deletedSegments: this.segments.filter(s => s.type === 'deleted').length,
      totalLength: this.segments.reduce((sum, s) => sum + s.content.length, 0),
      pureTextLength: this.extractPureText().length
    };
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
    
    const milliseconds = date.getMilliseconds().toString().padStart(3, '0');
    
    const formattedTime = hkTimeStr.replace(/\//g, '-').replace(',', '');
    
    return `${formattedTime}.${milliseconds}`;
  }

  async buildAndMergeOperationHistory() {
    if (this.segments.length === 0) return [];
    
    this.initSentenceSplitter();
    
    const TIME_THRESHOLD = 600000;  // 10分钟
    const mergedHistory = [];
    let current = null;
    
    for (const segment of this.segments) {
      let operation = null;
      
      if (segment.type === 'normal') {
        operation = {
          behavior: 'add',
          author: segment.author || '',
          add_start_time: this.formatHKTime(segment.timestamp),
          add_end_time: this.formatHKTime(segment.timestamp),
          delete_start_time: null,
          delete_end_time: null,
          content: segment.content
        };
      } else if (segment.type === 'deleted') {
        operation = {
          behavior: 'deleted',
          author: segment.deletedAuthor || segment.author || '',
          add_start_time: this.formatHKTime(segment.timestamp),
          add_end_time: this.formatHKTime(segment.timestamp),
          delete_start_time: this.formatHKTime(segment.deletedTimestamp),
          delete_end_time: this.formatHKTime(segment.deletedTimestamp),
          content: segment.content
        };
      }
      
      if (!operation) continue;
      
      if (!current) {
        current = operation;
        continue;
      }
      
      let canMergeTime = false;
      let timeGap = 0;
      
      if (current.behavior === 'add') {
        const currentStartTime = new Date(current.add_start_time).getTime();
        const operationEndTime = new Date(operation.add_end_time).getTime();
        timeGap = Math.abs(operationEndTime - currentStartTime);
        canMergeTime = currentStartTime <= operationEndTime && timeGap <= TIME_THRESHOLD;
      } else {
        const currentEndTime = new Date(current.delete_end_time).getTime();
        const operationStartTime = new Date(operation.delete_start_time).getTime();
        timeGap = Math.abs(operationStartTime - currentEndTime);
        canMergeTime = operationStartTime <= currentEndTime && timeGap <= TIME_THRESHOLD;
      }
      
      const canMergeBasic = (
        current.behavior === operation.behavior && 
        current.author === operation.author &&
        canMergeTime
      );
      
      if (!canMergeBasic) {
        if (!canMergeTime) {
          debugLog(`[Skip] Time condition not met: gap = ${(timeGap / 1000 / 60).toFixed(1)} minutes`);
        } else {
          debugLog(`[Skip] Different behavior or author`);
        }
        mergedHistory.push(current);
        current = operation;
        continue;
      }
      
      const mergedContent = current.content + operation.content;
      
      try {
        const sentenceCount = await this.sentenceSplitter.countSentences(mergedContent);
        
        debugLog(`[Merge Check] Content: "${mergedContent.substring(0, 50)}...", Sentences: ${sentenceCount}, Time gap: ${(timeGap / 1000).toFixed(1)}s`);
        
        if (sentenceCount <= 1) {
          current.content = mergedContent;
          
          if (current.behavior === 'add') {
            const currentStartMs = new Date(current.add_start_time).getTime();
            const currentEndMs = new Date(current.add_end_time).getTime();
            const opStartMs = new Date(operation.add_start_time).getTime();
            const opEndMs = new Date(operation.add_end_time).getTime();
            
            const minStartMs = Math.min(currentStartMs, opStartMs);
            const maxEndMs = Math.max(currentEndMs, opEndMs);
            
            current.add_start_time = this.formatHKTime(minStartMs);
            current.add_end_time = this.formatHKTime(maxEndMs);
          } else {
            const currentDelStartMs = new Date(current.delete_start_time).getTime();
            const currentDelEndMs = new Date(current.delete_end_time).getTime();
            const opDelStartMs = new Date(operation.delete_start_time).getTime();
            const opDelEndMs = new Date(operation.delete_end_time).getTime();
            
            const currentAddStartMs = new Date(current.add_start_time).getTime();
            const currentAddEndMs = new Date(current.add_end_time).getTime();
            const opAddStartMs = new Date(operation.add_start_time).getTime();
            const opAddEndMs = new Date(operation.add_end_time).getTime();
            
            const minDelStartMs = Math.min(currentDelStartMs, opDelStartMs);
            const maxDelEndMs = Math.max(currentDelEndMs, opDelEndMs);
            const minAddStartMs = Math.min(currentAddStartMs, opAddStartMs);
            const maxAddEndMs = Math.max(currentAddEndMs, opAddEndMs);
            
            current.delete_start_time = this.formatHKTime(minDelStartMs);
            current.delete_end_time = this.formatHKTime(maxDelEndMs);
            current.add_start_time = this.formatHKTime(minAddStartMs);
            current.add_end_time = this.formatHKTime(maxAddEndMs);
          }
          
          debugLog(`[Merge Success] Merged, total length: ${mergedContent.length}`);
          continue;
        } else {
          debugLog(`[Merge Skip] Would create ${sentenceCount} sentences, keeping separate`);
          mergedHistory.push(current);
          current = operation;
        }
      } catch (error) {
        console.error(`[Sentence Count Error] ${error.message}, defaulting to no merge`);
        mergedHistory.push(current);
        current = operation;
      }
    }
    
    if (current) {
      mergedHistory.push(current);
    }
    
    return mergedHistory;
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

  async getSnapshot() {
    const mergedHistory = await this.docManager.buildAndMergeOperationHistory();
    
    return {
      snapshot: this.docManager.renderSnapshot(),
      pureText: this.docManager.extractPureText(),
      deletions: this.docManager.getDeletions(),
      operationHistory: mergedHistory,
      debugInfo: this.docManager.getDebugInfo()
    };
  }

  validateSnapshot(expectedText) {
    const pureText = this.docManager.extractPureText();
    const isValid = pureText === expectedText;
    
    if (!isValid) {
      console.error(`\n❌ 快照验证失败！`);
      console.error(`期望文本长度: ${expectedText.length}`);
      console.error(`实际文本长度: ${pureText.length}`);
      console.error(`差异字符数: ${Math.abs(expectedText.length - pureText.length)}`);
      
      console.error(`\n期望文本（前100字符）: "${expectedText.substring(0, 100)}"`);
      console.error(`实际文本（前100字符）: "${pureText.substring(0, 100)}"`);
      
      for (let i = 0; i < Math.min(expectedText.length, pureText.length); i++) {
        if (expectedText[i] !== pureText[i]) {
          console.error(`\n第一个差异位置: ${i}`);
          console.error(`期望字符: '${expectedText[i]}' (${expectedText.charCodeAt(i)})`);
          console.error(`实际字符: '${pureText[i]}' (${pureText.charCodeAt(i)})`);
          console.error(`上下文: "${expectedText.substring(Math.max(0, i-10), i+10)}"`);
          break;
        }
      }
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

  formatHKTime(timestamp) {
    if (!timestamp) return '';
    
    const date = new Date(timestamp);
    const pad = (n) => String(n).padStart(2, '0');
    const padMs = (n) => String(n).padStart(3, '0');
    
    const hkDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    
    return `${hkDate.getUTCFullYear()}-${pad(hkDate.getUTCMonth() + 1)}-${pad(hkDate.getUTCDate())} ` +
      `${pad(hkDate.getUTCHours())}:${pad(hkDate.getUTCMinutes())}:${pad(hkDate.getUTCSeconds())}.${padMs(hkDate.getUTCMilliseconds())}`;
  }

  /**
   * 创建临时快照表
   */
  async createTempSnapshotTable() {
    const createTableSQL = `
      CREATE TEMPORARY TABLE IF NOT EXISTS pad_version_snapshots_temp (
        pad_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
        revision INT NOT NULL,
        formatted_timestamp VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '格式化时间戳（香港时区）',
        deletions_json JSON COMMENT '操作历史JSON',
        PRIMARY KEY (pad_id, revision)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `;

    await this.connection.execute(createTableSQL);
    console.log('✅ 临时快照表 pad_version_snapshots_temp 已创建');
  }

  /**
   * 删除临时快照表
   */
  async dropTempSnapshotTable() {
    await this.connection.execute('DROP TEMPORARY TABLE IF EXISTS pad_version_snapshots_temp');
    console.log('🗑️  临时快照表 pad_version_snapshots_temp 已删除');
  }

  /**
   * 从 pad_version_contents 读取版本数据
   */
  async getPadVersions(padId) {
    const query = `
      SELECT pad_id, revision, content, author_id, timestamp
      FROM pad_version_contents
      WHERE pad_id = ?
      ORDER BY revision ASC
    `;
    
    const [rows] = await this.connection.execute(query, [padId]);
    return rows;
  }

  /**
   * 插入快照到临时表
   */
  async insertTempSnapshot(snapshot) {
    const query = `
      INSERT INTO pad_version_snapshots_temp 
      (pad_id, revision, formatted_timestamp, deletions_json)
      VALUES (?, ?, ?, ?)
    `;
    
    await this.connection.execute(query, [
      snapshot.pad_id,
      snapshot.revision,
      snapshot.formatted_timestamp,
      JSON.stringify(snapshot.operation_history)
    ]);
  }

  /**
   * 批量插入快照到临时表
   */
  async insertTempSnapshots(snapshots) {
    if (snapshots.length === 0) return;

    console.log(`💾 开始保存 ${snapshots.length} 个快照到临时表...`);
    
    let successCount = 0;

    for (const snapshot of snapshots) {
      try {
        await this.insertTempSnapshot(snapshot);
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

  /**
   * 创建对比变更表
   */
  async ensureChangesCompareTable() {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS pad_version_changes_compare (
        id BIGINT AUTO_INCREMENT,
        pad_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Pad ID',
        seq_order INT NOT NULL COMMENT '操作顺序（从1开始）',
        behavior VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '操作类型：add 或 deleted',
        author VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '作者ID',
        content LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '操作内容',
        add_start_time VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '内容添加开始时间（精确到毫秒）',
        add_end_time VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '内容添加结束时间（精确到毫秒）',
        delete_start_time VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '内容删除开始时间（精确到毫秒）',
        delete_end_time VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '内容删除结束时间（精确到毫秒）',
        PRIMARY KEY (id) USING BTREE,
        INDEX idx_pad_id(pad_id ASC) USING BTREE
      ) COMMENT='Pad版本变更详细记录表（对比用）' ROW_FORMAT=Dynamic;
    `;

    await this.connection.execute(createTableSQL);
    console.log('✅ pad_version_changes_compare 表已就绪');
  }

  /**
   * 删除指定 pad 的变更记录
   */
  async deletePadChangesCompare(padId) {
    const [result] = await this.connection.execute(
      'DELETE FROM pad_version_changes_compare WHERE pad_id = ?',
      [padId]
    );
    console.log(`🗑️  删除旧记录: ${result.affectedRows} 条`);
    return result.affectedRows;
  }

  /**
   * 批量插入变更记录到对比表
   */
  async insertChangesCompare(changes) {
    if (changes.length === 0) return;

    console.log(`💾 开始保存 ${changes.length} 条变更记录到对比表...`);
    
    const query = `
      INSERT INTO pad_version_changes_compare 
      (pad_id, seq_order, behavior, author, content, add_start_time, add_end_time, delete_start_time, delete_end_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    let successCount = 0;
    
    for (const change of changes) {
      try {
        await this.connection.execute(query, [
          change.pad_id,
          change.seq_order,
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
        console.error(`   ❌ 保存失败 (Order=${change.seq_order}):`, error.message);
      }
    }

    console.log(`✅ 保存完成: 成功 ${successCount}/${changes.length}`);
  }

  /**
   * 从临时快照表导出到对比表
   */
  async exportSnapshotsToChanges(padId) {
    console.log('\n📤 导出最新快照数据到对比表...');
    
    // 只获取最新版本的快照
    const [snapshots] = await this.connection.execute(
      'SELECT * FROM pad_version_snapshots_temp WHERE pad_id = ? ORDER BY revision DESC LIMIT 1',
      [padId]
    );

    if (snapshots.length === 0) {
      console.log('⚠️ 未找到快照记录');
      return;
    }

    const latestSnapshot = snapshots[0];
    console.log(`✅ 读取到最新版本: ${latestSnapshot.revision}`);

    const deletionsJson = latestSnapshot.deletions_json;
    if (!deletionsJson) {
      console.log('⚠️ 该版本没有 deletions_json 数据');
      return;
    }

    // 解析 deletions_json
    const operations = typeof deletionsJson === 'string' 
      ? JSON.parse(deletionsJson) 
      : deletionsJson;

    console.log(`📝 解析到 ${operations.length} 条操作记录\n`);

    // 转换为变更记录
    const allChanges = operations.map((op, index) => {
      return {
        pad_id: padId,
        seq_order: index + 1,
        behavior: op.behavior,
        author: op.author || '',
        content: op.content || '',
        add_start_time: op.add_start_time || null,
        add_end_time: op.add_end_time || null,
        delete_start_time: op.delete_start_time || null,
        delete_end_time: op.delete_end_time || null
      };
    });

    await this.insertChangesCompare(allChanges);
    console.log(`✅ 成功导出 ${allChanges.length} 条变更记录到 pad_version_changes_compare`);
  }
}

/**
 * 主生成器类
 */
class PadSnapshotGenerator {
  constructor() {
    this.db = new DatabaseManager();
    this.snapshotBuilder = new SnapshotBuilderV3();
    this.validationErrors = [];
  }

  async generateAndExport(padId) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🚀 Pad 版本变更记录生成工具（合并版 - 使用临时表）`);
    console.log(`${'='.repeat(70)}`);
    console.log(`📝 目标 Pad: ${padId}`);
    console.log(`⏰ 开始时间: ${new Date().toLocaleString('zh-CN')}`);
    console.log(`🔍 调试模式: ${DEBUG_MODE ? '开启' : '关闭'}`);
    console.log(`${'='.repeat(70)}\n`);

    try {
      await this.db.connect();
      
      // 步骤1: 创建临时快照表
      console.log('🔧 步骤1: 创建临时快照表...');
      await this.db.createTempSnapshotTable();

      // 步骤2: 读取版本数据
      console.log(`\n📖 步骤2: 从 pad_version_contents 读取版本数据...`);
      const versions = await this.db.getPadVersions(padId);
      
      if (versions.length === 0) {
        console.log(`❌ 未找到 Pad ${padId} 的版本数据`);
        return;
      }

      console.log(`✅ 读取到 ${versions.length} 个版本\n`);

      // 步骤3: 生成快照到临时表
      console.log('📸 步骤3: 开始构建版本快照...');
      console.log(`   总版本数: ${versions.length}\n`);
      
      const snapshots = [];

      // 初始化第一个版本
      const firstContent = versions[0].content || '';
      const firstAuthorId = versions[0].author_id || '';
      const firstTimestamp = versions[0].timestamp || Date.now();
      
      this.snapshotBuilder.initialize(firstContent, firstAuthorId, firstTimestamp);
      
      const firstSnapshot = await this.snapshotBuilder.getSnapshot();
      
      // 验证第一个版本
      const firstValidation = this.snapshotBuilder.validateSnapshot(firstContent);
      if (!firstValidation.isValid) {
        this.validationErrors.push({ revision: versions[0].revision, ...firstValidation });
        console.error(`❌ 版本 ${versions[0].revision} 验证失败`);
      } else {
        console.log(`✅ 版本 ${versions[0].revision} 验证通过`);
      }
      
      snapshots.push({
        pad_id: padId,
        revision: versions[0].revision,
        formatted_timestamp: this.db.formatHKTime(firstTimestamp),
        operation_history: firstSnapshot.operationHistory
      });

      // 逐版本处理
      for (let i = 1; i < versions.length; i++) {
        const prevVersion = versions[i - 1];
        const currVersion = versions[i];
        
        if (i % 20 === 0 || i === versions.length - 1) {
          console.log(`处理版本 ${currVersion.revision} (${i + 1}/${versions.length})...`);
        }

        this.snapshotBuilder.applyVersion(
          prevVersion.content || '',
          currVersion.content || '',
          currVersion.revision,
          currVersion.author_id || '',
          currVersion.timestamp || Date.now()
        );

        const result = await this.snapshotBuilder.getSnapshot();
        
        // 验证快照
        const validation = this.snapshotBuilder.validateSnapshot(currVersion.content || '');
        if (!validation.isValid) {
          this.validationErrors.push({ revision: currVersion.revision, ...validation });
          if (DEBUG_MODE) {
            console.error(`❌ 版本 ${currVersion.revision} 验证失败`);
          }
        } else if (DEBUG_MODE) {
          console.log(`✅ 版本 ${currVersion.revision} 验证通过`);
        }
        
        if (DEBUG_MODE) {
          console.log('调试信息:', result.debugInfo);
          console.log('操作历史数量:', result.operationHistory.length);
        }

        snapshots.push({
          pad_id: padId,
          revision: currVersion.revision,
          formatted_timestamp: this.db.formatHKTime(currVersion.timestamp || Date.now()),
          operation_history: result.operationHistory
        });
      }

      console.log('\n✅ 快照构建完成\n');

      await this.db.insertTempSnapshots(snapshots);

      // 步骤4: 创建对比表
      console.log('\n🔧 步骤4: 检查/创建 pad_version_changes_compare 表...');
      await this.db.ensureChangesCompareTable();

      // 检查是否已存在该 pad 的数据
      const [existing] = await this.db.connection.execute(
        'SELECT COUNT(*) as count FROM pad_version_changes_compare WHERE pad_id = ?',
        [padId]
      );
      
      if (existing[0].count > 0) {
        console.log(`🔍 检测到重复的 pad_id，执行更新操作...`);
        await this.db.deletePadChangesCompare(padId);
      } else {
        console.log(`➕ 新增 pad_id，执行插入操作...`);
      }

      // 步骤5: 导出到对比表
      await this.db.exportSnapshotsToChanges(padId);

      // 步骤6: 删除临时表
      console.log('\n🧹 步骤6: 清理临时表...');
      await this.db.dropTempSnapshotTable();

      console.log(`\n${'='.repeat(70)}`);
      console.log('📊 处理完成');
      console.log(`${'='.repeat(70)}`);
      console.log(`Pad ID: ${padId}`);
      console.log(`总版本数: ${versions.length}`);
      const totalDeletions = snapshots[snapshots.length - 1].operation_history.filter(op => op.behavior === 'deleted').length;
      console.log(`累积删除操作数: ${totalDeletions}`);
      console.log(`验证错误数: ${this.validationErrors.length}`);
      console.log(`输出表: pad_version_changes_compare`);
      
      if (this.validationErrors.length > 0) {
        console.log(`\n⚠️ 警告: 发现 ${this.validationErrors.length} 个版本验证失败`);
        if (DEBUG_MODE) {
          console.log('失败的版本:');
          this.validationErrors.forEach(err => {
            console.log(`  - 版本 ${err.revision}: 期望长度=${err.expectedLength}, 实际长度=${err.actualLength}, 差异=${err.difference}`);
          });
        }
      }
      
      console.log(`${'='.repeat(70)}\n`);

    } catch (error) {
      console.error('\n❌ 生成失败:', error);
      console.error(error.stack);
      throw error;
    } finally {
      // 清理句子分割器资源
      if (this.snapshotBuilder && this.snapshotBuilder.docManager) {
        this.snapshotBuilder.docManager.cleanupSentenceSplitter();
      }
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
  合并版工具 - 使用临时表存储中间数据
  1. 从 pad_version_contents 读取版本数据
  2. 生成快照到临时表 pad_version_snapshots_temp
  3. 导出到对比表 pad_version_changes_compare
  4. 清理临时表
    `);
    process.exit(0);
  }

  const generator = new PadSnapshotGenerator();
  
  try {
    await generator.generateAndExport(padId);
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

module.exports = { PadSnapshotGenerator, SnapshotBuilderV3, DocumentSegmentManager };
