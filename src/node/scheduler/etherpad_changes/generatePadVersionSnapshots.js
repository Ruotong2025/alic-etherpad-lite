#!/usr/bin/env node

/**
 * Pad 版本快照生成器 - 优化版
 * 
 * 核心改进 V4：
 * 1. 使用 google-diff-match-patch 库进行精确的文本差异计算
 * 2. 增加快照验证机制，确保删除标记后与当前版本一致
 * 3. 添加详细的调试日志
 * 4. 改进文档片段管理逻辑
 * 5. 集成 NLTK 句子级别合并判断
 * 6. ✅ 统一合并逻辑：移除片段级合并，只在构建操作历史时合并一次
 * 7. ✅ 逐步合并策略：边遍历边判断，不丢失可合并的片段
 * 8. ✅ 保留完整时间信息：记录每个操作的 start_time 和 end_time
 * 
 * 合并策略：
 * - 合并条件：behavior 相同 + author 相同 + 时间间隔 ≤ 1小时 + 合并后仍是单句话
 * - 逐步判断：每次只尝试合并相邻的两个操作，避免跨句子合并
 * - 时间保留：合并时保留第一个操作的 start_time 和最后一个操作的 end_time
 * 
 * 数据流向：
 * - 数据源：pad_version_contents (未合并的原始版本数据)
 * - 目标表：pad_version_snapshots (正式表)
 * 
 * 使用方法: node generatePadVersionSnapshots.js <padId> [--debug]
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
    if (!oldText) return [{ type: 'insert', oldPosition: 0, newPosition: 0, content: newText }];
    if (!newText) return [{ type: 'delete', oldPosition: 0, newPosition: 0, length: oldText.length, content: oldText }];

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
    
    // ✅ 移除片段级合并，只在构建操作历史时合并
    // this._mergeAdjacentSegments();
    
    debugLog(`片段数量: ${this.segments.length}`);
  }

  /**
   * 应用删除操作
   * 
   * 关键：删除操作从指定位置开始，持续删除指定长度的字符
   * - position: 在 normal 文本中的起始位置（不包括 deleted 片段）
   * - length: 要删除的字符数
   * 
   * 算法：
   * 1. 遍历所有 normal 片段
   * 2. 找到删除范围[position, position+length)覆盖的所有片段
   * 3. 对每个片段进行相应的删除或分割操作
   */
  _applyDeletion(position, length, version, authorId, timestamp) {
    debugLog(`  执行删除: 起始位置=${position}, 长度=${length}`);
    
    if (length <= 0) {
      debugLog(`  ⚠️ 删除长度为0，跳过`);
      return;
    }
    
    const deleteStart = position;  // 删除起始位置（固定）
    const deleteEnd = position + length;  // 删除结束位置（固定）
    let currentPos = 0;  // 当前扫描到的 normal 文本位置
    let segmentIndex = 0;
    
    debugLog(`  删除范围: [${deleteStart}, ${deleteEnd})`);
    
    // 遍历所有片段
    while (segmentIndex < this.segments.length) {
      const segment = this.segments[segmentIndex];
      
      // 跳过已删除的片段（不计入位置）
      if (segment.type !== 'normal') {
        segmentIndex++;
        continue;
      }
      
      const segmentStart = currentPos;
      const segmentEnd = currentPos + segment.content.length;
      
      debugLog(`    检查片段 [${segmentIndex}]: 范围[${segmentStart}, ${segmentEnd}), 内容="${segment.content}"`);
      
      // 如果删除范围完全在当前片段之前，结束
      if (deleteEnd <= segmentStart) {
        debugLog(`    删除范围在片段之前，结束`);
        break;
      }
      
      // 如果删除范围完全在当前片段之后，继续
      if (deleteStart >= segmentEnd) {
        debugLog(`    删除范围在片段之后，继续`);
        currentPos = segmentEnd;
        segmentIndex++;
        continue;
      }
      
      // 删除范围与当前片段有交集，计算交集
      const overlapStart = Math.max(deleteStart, segmentStart);
      const overlapEnd = Math.min(deleteEnd, segmentEnd);
      const overlapStartInSegment = overlapStart - segmentStart;
      const overlapEndInSegment = overlapEnd - segmentStart;
      const overlapLength = overlapEndInSegment - overlapStartInSegment;
      
      debugLog(`    交集: 片段内[${overlapStartInSegment}, ${overlapEndInSegment}), 长度=${overlapLength}`);
      
      if (overlapStartInSegment === 0 && overlapEndInSegment === segment.content.length) {
        // 情况1: 删除整个片段
        segment.type = 'deleted';
        segment.deletedAt = version;
        segment.deletedAuthor = authorId;
        segment.deletedTimestamp = timestamp;
        debugLog(`    → 删除整个片段 "${segment.content}"`);
        currentPos = segmentEnd;
        segmentIndex++;
      } else if (overlapStartInSegment === 0) {
        // 情况2: 删除片段开头部分
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
        // 情况3: 删除片段末尾部分
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
        // 情况4: 删除片段中间部分
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

  /**
   * 应用插入操作
   */
  _applyInsertion(position, content, version, authorId, timestamp) {
    debugLog(`  执行插入: 位置=${position}, 内容长度=${content.length}`);
    
    // 添加详细的 segments 结构调试
    if (DEBUG_MODE && content.includes('Tourists')) {
      debugLog(`  [TOURISTS DEBUG] 当前 segments 结构:`);
      this.segments.forEach((seg, idx) => {
        debugLog(`    [${idx}] ${seg.type}: "${seg.content.substring(0, 50)}..."`);
      });
    }
    
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
        // 直接在当前位置前插入，deleted 片段会自动保持在正确位置
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
   * ❌ 已废弃：移除片段级合并，改为在构建操作历史时合并
   * 保留此函数仅作为参考，不再使用
   */
  _mergeAdjacentSegments_DEPRECATED() {
    // 此函数已被 buildAndMergeOperationHistory() 替代
    console.warn('⚠️ _mergeAdjacentSegments 已废弃，请使用 buildAndMergeOperationHistory');
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
   * 将时间戳转换为香港时间格式（保留毫秒）
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
    
    // 获取毫秒部分（3位）
    const milliseconds = date.getMilliseconds().toString().padStart(3, '0');
    
    // 格式化为 YYYY-MM-DD HH:mm:ss.SSS
    // toLocaleString 返回格式可能是 "2025/10/26 20:30:00" 或 "2025-10-26 20:30:00"
    const formattedTime = hkTimeStr.replace(/\//g, '-').replace(',', '');
    
    return `${formattedTime}.${milliseconds}`;
  }

  /**
   * 构建操作历史并智能合并（一步完成）
   * 
   * 合并条件：
   * 1. behavior 相同（都是 add 或 deleted）
   * 2. author 相同
   * 3. 时间条件（时间单位：毫秒）：
   *    - deleted 操作：后一条的 delete_start_time ≤ 前一条的 delete_end_time，且时间差 ≤ 10分钟
   *    - add 操作：前一条的 add_start_time ≤ 后一条的 add_end_time，且时间差 ≤ 10分钟
   * 4. 合并后仍是单句话（≤ 1句）
   * 
   * 合并后的时间处理：
   * - deleted 操作：取最小值为 delete_start_time，最大值为 delete_end_time
   * - add 操作：取最小值为 add_start_time，最大值为 add_end_time
   * 
   * 采用逐步合并策略：
   * - 每次只尝试合并当前操作和下一个操作
   * - 如果可以合并，继续尝试下一个
   * - 如果不能合并，保存当前操作，开始新的合并
   * - 这样可以保留完整的时间信息，不会丢失可合并的片段
   */
  async buildAndMergeOperationHistory() {
    if (this.segments.length === 0) return [];
    
    // 初始化句子分割器
    this.initSentenceSplitter();
    
    const TIME_THRESHOLD = 600000;  // 10分钟 = 600000毫秒
    const mergedHistory = [];
    let current = null;
    
    for (const segment of this.segments) {
      // 1. 构建当前片段的操作对象
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
      
      // 2. 如果是第一个操作，直接设为 current
      if (!current) {
        current = operation;
        continue;
      }
      
      // 3. 检查基本合并条件
      let canMergeTime = false;
      let timeGap = 0;
      
      if (current.behavior === 'add') {
        // add 操作：前一条的 add_start_time ≤ 后一条的 add_end_time
        const currentStartTime = new Date(current.add_start_time).getTime();
        const operationEndTime = new Date(operation.add_end_time).getTime();
        timeGap = Math.abs(operationEndTime - currentStartTime);
        canMergeTime = currentStartTime <= operationEndTime && timeGap <= TIME_THRESHOLD;
      } else {
        // deleted 操作：后一条的 delete_start_time ≤ 前一条的 delete_end_time
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
        // 基本条件不满足，不合并
        if (!canMergeTime) {
          debugLog(`[Skip] Time condition not met: gap = ${(timeGap / 1000 / 60).toFixed(1)} minutes`);
        } else {
          debugLog(`[Skip] Different behavior or author`);
        }
        mergedHistory.push(current);
        current = operation;
        continue;
      }
      
      // 4. 基本条件满足，检查句子级别约束
      const mergedContent = current.content + operation.content;
      
      try {
        const sentenceCount = await this.sentenceSplitter.countSentences(mergedContent);
        
        debugLog(`[Merge Check] Content: "${mergedContent.substring(0, 50)}...", Sentences: ${sentenceCount}, Time gap: ${(timeGap / 1000).toFixed(1)}s`);
        
        if (sentenceCount <= 1) {
          // ✅ 可以合并：仍然是单句话
          current.content = mergedContent;
          
          if (current.behavior === 'add') {
            // add 操作：取最小值和最大值
            const currentStartMs = new Date(current.add_start_time).getTime();
            const currentEndMs = new Date(current.add_end_time).getTime();
            const opStartMs = new Date(operation.add_start_time).getTime();
            const opEndMs = new Date(operation.add_end_time).getTime();
            
            const minStartMs = Math.min(currentStartMs, opStartMs);
            const maxEndMs = Math.max(currentEndMs, opEndMs);
            
            current.add_start_time = this.formatHKTime(minStartMs);
            current.add_end_time = this.formatHKTime(maxEndMs);
          } else {
            // deleted 操作：取最小值和最大值
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
          continue;  // 继续尝试合并下一个片段
        } else {
          // ❌ 不能合并：会变成多句话
          debugLog(`[Merge Skip] Would create ${sentenceCount} sentences, keeping separate`);
          mergedHistory.push(current);
          current = operation;
        }
      } catch (error) {
        // 句子分割器出错，保守处理：不合并
        console.error(`[Sentence Count Error] ${error.message}, defaulting to no merge`);
        mergedHistory.push(current);
        current = operation;
      }
    }
    
    // 5. 添加最后一个操作
    if (current) {
      mergedHistory.push(current);
    }
    
    return mergedHistory;
  }

  /**
   * ❌ 已废弃：旧的两步式合并方法
   * 保留仅作为参考
   */
  buildOperationHistory_DEPRECATED() {
    console.warn('⚠️ buildOperationHistory 已废弃，请使用 buildAndMergeOperationHistory');
    return [];
  }

  /**
   * ❌ 已废弃：旧的两步式合并方法
   * 保留仅作为参考
   */
  async mergeOperations_DEPRECATED(history) {
    console.warn('⚠️ mergeOperations 已废弃，请使用 buildAndMergeOperationHistory');
    return history;
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
    // ✅ 一步完成：构建并合并操作历史
    const mergedHistory = await this.docManager.buildAndMergeOperationHistory();
    
    return {
      snapshot: this.docManager.renderSnapshot(),
      pureText: this.docManager.extractPureText(),
      deletions: this.docManager.getDeletions(),
      operationHistory: mergedHistory,  // 操作历史数组（已合并）
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
    console.log('✅ 快照表检查/创建完成（pad_version_snapshots）');
  }

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

  async clearPadSnapshots(padId) {
    await this.connection.execute(
      'DELETE FROM pad_version_snapshots WHERE pad_id = ?',
      [padId]
    );
    console.log('🗑️  清理旧的快照对比数据');
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

      console.log(`\n📖 从 pad_version_contents 读取版本数据（对比模式）...`);
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
