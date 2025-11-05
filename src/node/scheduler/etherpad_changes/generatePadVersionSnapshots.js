#!/usr/bin/env node

/**
 * Pad 版本快照生成器 V3 - 修复版
 * 
 * 核心改进：
 * 1. 使用 google-diff-match-patch 库进行精确的文本差异计算
 * 2. 增加快照验证机制，确保删除标记后与当前版本一致
 * 3. 添加详细的调试日志
 * 4. 改进文档片段管理逻辑
 * 
 * 使用方法: node generatePadVersionSnapshotsV3.js <padId> [--debug]
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
    // 设置超时时间（秒）
    this.dmp.Diff_Timeout = 2.0;
    // 设置编辑代价阈值
    this.dmp.Diff_EditCost = 4;
  }

  /**
   * 计算两个文本之间的差异
   * 返回标准化的操作列表，按照旧文本的位置排序
   */
  calculateDiff(oldText, newText) {
    if (!oldText && !newText) return [];
    if (!oldText) return [{ type: 'insert', position: 0, content: newText }];
    if (!newText) return [{ type: 'delete', position: 0, length: oldText.length, content: oldText }];

    // 使用 diff-match-patch 计算差异
    const diffs = this.dmp.diff_main(oldText, newText);
    
    // 优化差异结果，使其更符合语义
    this.dmp.diff_cleanupSemantic(diffs);
    
    debugLog(`Diff结果数量: ${diffs.length}`);
    
    // 转换为操作列表，以旧文本的位置为基准
    const operations = [];
    let oldPos = 0;  // 在旧文本中的位置
    let newPos = 0;  // 在新文本中的位置
    
    for (const [operation, text] of diffs) {
      if (operation === DiffMatchPatch.DIFF_DELETE) {
        // 删除操作：记录在旧文本中的位置
        operations.push({
          type: 'delete',
          oldPosition: oldPos,
          newPosition: newPos,
          length: text.length,
          content: text
        });
        debugLog(`删除操作: 旧位置=${oldPos}, 新位置=${newPos}, 长度=${text.length}, 内容="${text.substring(0, 20)}..."`);
        oldPos += text.length;
      } else if (operation === DiffMatchPatch.DIFF_INSERT) {
        // 插入操作：记录在新文本中的位置
        operations.push({
          type: 'insert',
          oldPosition: oldPos,
          newPosition: newPos,
          content: text
        });
        debugLog(`插入操作: 旧位置=${oldPos}, 新位置=${newPos}, 长度=${text.length}, 内容="${text.substring(0, 20)}..."`);
        newPos += text.length;
      } else if (operation === DiffMatchPatch.DIFF_EQUAL) {
        // 未改变的部分
        oldPos += text.length;
        newPos += text.length;
      }
    }
    
    return operations;
  }
}

/**
 * 文档片段管理器 - 改进版
 */
class DocumentSegmentManager {
  constructor() {
    this.segments = [];  // 文档片段数组
    this.sentenceSplitter = null;  // 句子分割器实例
  }

  /**
   * 初始化句子分割器
   */
  initSentenceSplitter() {
    if (!this.sentenceSplitter) {
      const SentenceSplitter = require('./SentenceSplitter');
      this.sentenceSplitter = new SentenceSplitter();
      this.sentenceSplitter.init();
    }
  }

  /**
   * 清理句子分割器资源
   */
  cleanupSentenceSplitter() {
    if (this.sentenceSplitter) {
      this.sentenceSplitter.close();
      this.sentenceSplitter = null;
    }
  }

  /**
   * 初始化文档
   */
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

  /**
   * 应用变更到文档片段
   */
  applyChanges(operations, version, authorId, timestamp) {
    debugLog(`\n应用 ${operations.length} 个操作到版本 ${version}`);
    
    // 分离删除和插入操作
    const deletes = operations.filter(op => op.type === 'delete' && op.length > 0);
    const inserts = operations.filter(op => op.type === 'insert');
    
    // 先应用所有删除操作（从后往前，避免位置偏移）
    // 使用 oldPosition（在旧文本中的位置）
    const sortedDeletes = [...deletes].sort((a, b) => b.oldPosition - a.oldPosition);
    for (const op of sortedDeletes) {
      this._applyDeletion(op.oldPosition, op.length, version, authorId, timestamp);
    }
    
    // 再应用插入操作（从前往后）
    // 注意：删除后，文档变短了，需要重新映射插入位置
    // 同时，每次插入后，后续的插入位置也需要调整
    const sortedInserts = [...inserts].sort((a, b) => a.oldPosition - b.oldPosition);
    let cumulativeInsertOffset = 0;  // 累积的插入偏移量
    
    for (const op of sortedInserts) {
      // 1. 计算在应用删除后的基础位置
      let basePosition = op.oldPosition;
      for (const del of deletes) {
        if (del.oldPosition < op.oldPosition) {
          // 这个删除在当前插入之前，需要减去删除的长度
          basePosition -= del.length;
        }
      }
      
      // 2. 加上之前插入操作的累积偏移
      const actualPosition = basePosition + cumulativeInsertOffset;
      
      debugLog(`    插入调整: 旧位置=${op.oldPosition}, 基础位置=${basePosition}, 累积偏移=${cumulativeInsertOffset}, 实际位置=${actualPosition}`);
      
      this._applyInsertion(actualPosition, op.content, version, authorId, timestamp);
      
      // 3. 更新累积偏移
      cumulativeInsertOffset += op.content.length;
    }
    
    // 合并相邻的同类型片段
    this._mergeAdjacentSegments();
    
    debugLog(`片段数量: ${this.segments.length}`);
  }

  /**
   * 应用删除操作
   */
  _applyDeletion(position, length, version, authorId, timestamp) {
    debugLog(`  执行删除: 位置=${position}, 长度=${length}`);
    
    // 找到删除的起始位置
    let currentPos = 0;
    let remainingLength = length;
    let segmentIndex = 0;
    
    // 定位到起始片段
    while (segmentIndex < this.segments.length && remainingLength > 0) {
      const segment = this.segments[segmentIndex];
      
      if (segment.type !== 'normal') {
        segmentIndex++;
        continue;
      }
      
      const segmentEndPos = currentPos + segment.content.length;
      
      if (position >= segmentEndPos) {
        // 删除位置在这个片段之后
        currentPos = segmentEndPos;
        segmentIndex++;
        continue;
      }
      
      // 删除位置在当前片段内或之前
      const offsetInSegment = Math.max(0, position - currentPos);
      const deleteInThisSegment = Math.min(remainingLength, segment.content.length - offsetInSegment);
      
      debugLog(`    片段 ${segmentIndex}: 偏移=${offsetInSegment}, 删除=${deleteInThisSegment}`);
      
      if (offsetInSegment === 0 && deleteInThisSegment === segment.content.length) {
        // 删除整个片段
        segment.type = 'deleted';
        segment.deletedAt = version;
        segment.deletedAuthor = authorId;
        segment.deletedTimestamp = timestamp;
        debugLog(`    标记整个片段为删除`);
      } else if (offsetInSegment === 0) {
        // 删除片段开头部分
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
        debugLog(`    分割片段: 删除开头 ${deleteInThisSegment} 字符`);
      } else if (offsetInSegment + deleteInThisSegment === segment.content.length) {
        // 删除片段末尾部分
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
        debugLog(`    分割片段: 删除末尾 ${deleteInThisSegment} 字符`);
      } else {
        // 删除片段中间部分
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
        debugLog(`    分割片段: 删除中间 ${deleteInThisSegment} 字符`);
      }
      
      remainingLength -= deleteInThisSegment;
      currentPos += segment.content.length;
      segmentIndex++;
    }
    
    if (remainingLength > 0) {
      console.warn(`⚠️ 警告: 删除操作未完全执行，剩余 ${remainingLength} 字符`);
    }
  }

  /**
   * 应用插入操作
   */
  _applyInsertion(position, content, version, authorId, timestamp) {
    debugLog(`  执行插入: 位置=${position}, 内容长度=${content.length}`);
    
    let currentPos = 0;
    let lastNormalSegmentIndex = -1;
    let totalNormalLength = 0;
    
    // 首先计算所有 normal 片段的总长度和最后一个 normal 片段的索引
    for (let i = 0; i < this.segments.length; i++) {
      if (this.segments[i].type === 'normal') {
        totalNormalLength += this.segments[i].content.length;
        lastNormalSegmentIndex = i;
      }
    }
    
    // 如果插入位置等于所有 normal 文本的总长度，追加到文档末尾
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
    
    // 否则，查找具体的插入位置
    currentPos = 0;
    for (let i = 0; i < this.segments.length; i++) {
      const segment = this.segments[i];
      
      if (segment.type !== 'normal') {
        continue;
      }
      
      const segmentEndPos = currentPos + segment.content.length;
      
      if (position === currentPos) {
        // 在片段开头插入
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
        // 在片段中间插入，需要分割
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
    
    // 如果到这里还没插入，追加到最后（兜底）
    this.segments.push({
      type: 'normal',
      content: content,
      version: version,
      author: authorId,
      timestamp: timestamp
    });
    debugLog(`    追加到末尾（兜底）`);
  }

  /**
   * 合并相邻的同类型片段
   */
  _mergeAdjacentSegments() {
    if (this.segments.length <= 1) return;
    
    const merged = [this.segments[0]];
    
    for (let i = 1; i < this.segments.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = this.segments[i];
      
      // 合并条件：类型相同，版本相同
      if (prev.type === curr.type && 
          prev.type === 'normal' && 
          prev.version === curr.version) {
        prev.content += curr.content;
        debugLog(`    合并片段: ${i-1} 和 ${i}`);
      } else if (prev.type === curr.type && 
                 prev.type === 'deleted' && 
                 prev.deletedAt === curr.deletedAt) {
        prev.content += curr.content;
        debugLog(`    合并删除片段: ${i-1} 和 ${i}`);
      } else {
        merged.push(curr);
      }
    }
    
    this.segments = merged;
  }

  /**
   * 渲染为快照文本（只包含 normal 片段，不再使用 [deleted:...] 标记）
   */
  renderSnapshot() {
    let result = '';
    
    for (const segment of this.segments) {
      if (segment.type === 'normal') {
        result += segment.content;
      }
      // 不再渲染删除标记
    }
    
    return result;
  }

  /**
   * 提取纯净文本（只包含 normal 片段）
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

  /**
   * 获取调试信息
   */
  getDebugInfo() {
    return {
      totalSegments: this.segments.length,
      normalSegments: this.segments.filter(s => s.type === 'normal').length,
      deletedSegments: this.segments.filter(s => s.type === 'deleted').length,
      totalLength: this.segments.reduce((sum, s) => sum + s.content.length, 0),
      pureTextLength: this.extractPureText().length
    };
  }

  /**
   * 将时间戳转换为香港时间格式
   */
  formatHKTime(timestamp) {
    if (!timestamp) return '';
    
    const date = new Date(timestamp);
    
    // 转换为香港时间字符串（UTC+8）
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
    
    // 格式化为 YYYY-MM-DD HH:mm:ss
    // toLocaleString 返回格式可能是 "2025/10/26 20:30:00" 或 "2025-10-26 20:30:00"
    return hkTimeStr.replace(/\//g, '-').replace(',', '');
  }

  /**
   * 构建操作历史数组
   */
  buildOperationHistory() {
    const history = [];
    
    for (const segment of this.segments) {
      if (segment.type === 'normal') {
        // 添加操作
        history.push({
          behavior: 'add',
          author: segment.author || '',
          start_time: this.formatHKTime(segment.timestamp),
          end_time: this.formatHKTime(segment.timestamp),
          content: segment.content
        });
      } else if (segment.type === 'deleted') {
        // 删除操作
        history.push({
          behavior: 'deleted',
          author: segment.deletedAuthor || segment.author || '',
          start_time: this.formatHKTime(segment.timestamp),
          end_time: this.formatHKTime(segment.deletedTimestamp),
          content: segment.content
        });
      }
    }
    
    return history;
  }

  /**
   * 合并连续的相同操作
   * 只合并 behavior 和 author 都相同的连续操作
   * 增加句子级别约束：如果合并后内容包含多句话，则不合并
   */
  async mergeOperations(history) {
    if (history.length === 0) return [];
    
    // 初始化句子分割器
    this.initSentenceSplitter();
    
    const merged = [];
    let current = { ...history[0] };
    
    for (let i = 1; i < history.length; i++) {
      const next = history[i];
      
      // 如果 behavior 和 author 都相同，尝试合并
      if (current.behavior === next.behavior && 
          current.author === next.author) {
        
        // 尝试合并内容
        const mergedContent = current.content + next.content;
        
        try {
          // 使用 NLTK 检查句子数量
          const sentenceCount = await this.sentenceSplitter.countSentences(mergedContent);
          
          debugLog(`[Merge Check] Content: "${mergedContent.substring(0, 50)}...", Sentences: ${sentenceCount}`);
          
          // 只有在合并后仍是单句（或无句）时才允许合并
          if (sentenceCount <= 1) {
            // 拼接内容
            current.content = mergedContent;
            // 更新 end_time 为最新的
            current.end_time = next.end_time;
            debugLog(`[Merge Success] Merged operation, total length: ${mergedContent.length}`);
          } else {
            // 句子数量 >= 2，不合并
            debugLog(`[Merge Skip] Content would create ${sentenceCount} sentences, keeping separate`);
            merged.push(current);
            current = { ...next };
          }
        } catch (error) {
          console.error(`[Sentence Count Error] ${error.message}, defaulting to no merge`);
          // 出错时默认不合并，保持安全
          merged.push(current);
          current = { ...next };
        }
      } else {
        // behavior 或 author 不同，保存当前的，开始新的
        merged.push(current);
        current = { ...next };
      }
    }
    
    // 添加最后一个
    merged.push(current);
    
    return merged;
  }
}

/**
 * 快照构建器 V3 - 改进版
 */
class SnapshotBuilderV3 {
  constructor() {
    this.diffCalculator = new TextDiffCalculator();
    this.docManager = new DocumentSegmentManager();
  }

  /**
   * 初始化第一个版本
   */
  initialize(text, authorId, timestamp) {
    this.docManager.initialize(text, authorId, timestamp);
  }

  /**
   * 应用版本变更
   */
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

  /**
   * 获取当前快照（异步）
   */
  async getSnapshot() {
    // 构建操作历史
    const rawHistory = this.docManager.buildOperationHistory();
    const mergedHistory = await this.docManager.mergeOperations(rawHistory);
    
    return {
      snapshot: this.docManager.renderSnapshot(),
      pureText: this.docManager.extractPureText(),
      deletions: this.docManager.getDeletions(),
      operationHistory: mergedHistory,  // 新增：操作历史数组
      debugInfo: this.docManager.getDebugInfo()
    };
  }

  /**
   * 验证快照正确性
   * 确保删除 [deleted:*] 标记后的文本与期望的文本一致
   */
  validateSnapshot(expectedText) {
    const pureText = this.docManager.extractPureText();
    const isValid = pureText === expectedText;
    
    if (!isValid) {
      console.error(`\n❌ 快照验证失败！`);
      console.error(`期望文本长度: ${expectedText.length}`);
      console.error(`实际文本长度: ${pureText.length}`);
      console.error(`差异字符数: ${Math.abs(expectedText.length - pureText.length)}`);
      
      // 显示前100个字符的对比
      console.error(`\n期望文本（前100字符）: "${expectedText.substring(0, 100)}"`);
      console.error(`实际文本（前100字符）: "${pureText.substring(0, 100)}"`);
      
      // 找出第一个不同的位置
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
      JSON.stringify(snapshot.operation_history)  // 使用 operation_history 替代 deletions
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
    this.validationErrors = [];
  }

  async generateSnapshots(padId) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🚀 Pad 版本快照生成工具 V3 - 改进版`);
    console.log(`${'='.repeat(70)}`);
    console.log(`📝 目标 Pad: ${padId}`);
    console.log(`⏰ 开始时间: ${new Date().toLocaleString('zh-CN')}`);
    console.log(`🔍 调试模式: ${DEBUG_MODE ? '开启' : '关闭'}`);
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
        snapshot_text: firstSnapshot.snapshot,
        pure_text: firstSnapshot.pureText,
        author_id: firstAuthorId,
        timestamp: firstTimestamp,
        deletion_count: firstSnapshot.operationHistory.filter(op => op.behavior === 'deleted').length,
        operation_history: firstSnapshot.operationHistory
      });

      // 逐版本处理
      for (let i = 1; i < versions.length; i++) {
        const prevVersion = versions[i - 1];
        const currVersion = versions[i];
        
        console.log(`\n处理版本 ${currVersion.revision} (${i + 1}/${versions.length})...`);

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
          console.error(`❌ 版本 ${currVersion.revision} 验证失败`);
        } else {
          console.log(`✅ 版本 ${currVersion.revision} 验证通过`);
        }
        
        if (DEBUG_MODE) {
          console.log('调试信息:', result.debugInfo);
          console.log('操作历史数量:', result.operationHistory.length);
        }

        snapshots.push({
          pad_id: padId,
          revision: currVersion.revision,
          snapshot_text: result.snapshot,
          pure_text: result.pureText,
          author_id: currVersion.author_id || '',
          timestamp: currVersion.timestamp || Date.now(),
          deletion_count: result.operationHistory.filter(op => op.behavior === 'deleted').length,
          operation_history: result.operationHistory
        });
      }

      console.log('\n✅ 快照构建完成\n');
      
      // 清理句子分割器资源
      console.log('🧹 清理句子分割器资源...');
      this.snapshotBuilder.docManager.cleanupSentenceSplitter();

      await this.db.insertSnapshots(snapshots);

      console.log(`\n${'='.repeat(70)}`);
      console.log('📊 快照生成完成');
      console.log(`${'='.repeat(70)}`);
      console.log(`Pad ID: ${padId}`);
      console.log(`总版本数: ${versions.length}`);
      console.log(`累积删除次数: ${snapshots[snapshots.length - 1].deletion_count}`);
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
  <padId>        要生成快照的 Pad ID

选项:
  --debug, -d    开启调试模式，显示详细日志
  --help, -h     显示帮助信息

示例:
  node ${path.basename(__filename)} room-229
  node ${path.basename(__filename)} room-229 --debug

说明:
  V3 改进版 - 使用 google-diff-match-patch 进行精确差异计算
  支持快照验证，确保生成的快照正确性
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
