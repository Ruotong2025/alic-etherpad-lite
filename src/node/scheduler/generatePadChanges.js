#!/usr/bin/env node

/**
 * Pad版本变更数据生成器 - 简化版
 * 
 * 功能：分析 pad_version_contents_merge 表中相邻版本的文本变化
 * 生成 pad_version_changes 表的变更记录
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
 * 优化的文本差异计算器
 * 使用改进的Myers算法，减少过度分割
 */
class TextDiffCalculator {
  /**
   * 计算两个文本之间的差异
   * @param {string} oldText - 旧版本文本
   * @param {string} newText - 新版本文本
   * @returns {Array} 差异操作数组
   */
  calculateDiff(oldText, newText) {
    if (!oldText && !newText) return [];
    if (!oldText) return [{ type: 'add', content: newText, position: 0 }];
    if (!newText) return [{ type: 'delete', content: oldText, position: 0 }];

    // 使用改进的差异算法
    const diffs = this._computeOptimizedDiff(oldText, newText);
    
    // 后处理：合并相邻的相同类型操作
    return this._postProcessDiffs(diffs);
  }

  /**
   * 计算优化的差异 - 忽略换行符，专注于文本内容变化
   * @private
   */
  _computeOptimizedDiff(oldText, newText) {
    // 使用改进的字符级差异算法，专注于实际内容变化
    return this._computeContentFocusedDiff(oldText, newText);
  }

  /**
   * 计算内容聚焦的差异 - 专注于识别纯添加操作
   * @private
   */
  _computeContentFocusedDiff(oldText, newText) {
    // 使用专门的嵌入式添加检测算法
    return this._detectEmbeddedAdditions(oldText, newText);
  }

  /**
   * 检测嵌入式添加 - 在原文基础上插入的新内容
   * @private
   */
  _detectEmbeddedAdditions(oldText, newText) {
    const additions = [];
    
    // 使用更精确的匹配算法
    const alignments = this._createAlignment(oldText, newText);
    
    let currentPosition = 0;
    for (const alignment of alignments) {
      if (alignment.type === 'add') {
        additions.push({
          type: 'add',
          content: alignment.content,
          position: currentPosition
        });
      } else if (alignment.type === 'delete') {
        additions.push({
          type: 'delete',
          content: alignment.content,
          position: currentPosition
        });
        currentPosition += alignment.content.length;
      } else if (alignment.type === 'match') {
        currentPosition += alignment.content.length;
      }
    }
    
    return additions;
  }

  /**
   * 创建文本对齐，识别匹配、添加和删除的部分
   * @private
   */
  _createAlignment(oldText, newText) {
    const alignments = [];
    let oldPos = 0;
    let newPos = 0;
    
    while (oldPos < oldText.length || newPos < newText.length) {
      // 寻找下一个匹配的锚点
      const anchor = this._findNextAnchor(oldText, newText, oldPos, newPos);
      
      if (anchor) {
        // 处理锚点之前的内容
        if (oldPos < anchor.oldStart || newPos < anchor.newStart) {
          // 有差异内容
          const oldSegment = oldText.substring(oldPos, anchor.oldStart);
          const newSegment = newText.substring(newPos, anchor.newStart);
          
          // 分析这个差异段
          const segmentAlignments = this._analyzeSegment(oldSegment, newSegment);
          alignments.push(...segmentAlignments);
        }
        
        // 添加匹配的锚点
        alignments.push({
          type: 'match',
          content: oldText.substring(anchor.oldStart, anchor.oldStart + anchor.length)
        });
        
        // 移动位置
        oldPos = anchor.oldStart + anchor.length;
        newPos = anchor.newStart + anchor.length;
      } else {
        // 没有更多锚点，处理剩余内容
        const remainingOld = oldText.substring(oldPos);
        const remainingNew = newText.substring(newPos);
        
        const segmentAlignments = this._analyzeSegment(remainingOld, remainingNew);
        alignments.push(...segmentAlignments);
        break;
      }
    }
    
    return alignments;
  }

  /**
   * 寻找下一个锚点（稳定的匹配点）
   * @private
   */
  _findNextAnchor(oldText, newText, oldStart, newStart) {
    const minAnchorLength = 5; // 锚点最小长度
    const maxSearchDistance = 100; // 最大搜索距离
    
    let bestAnchor = null;
    
    // 在合理范围内寻找锚点
    for (let oldPos = oldStart; oldPos <= Math.min(oldStart + maxSearchDistance, oldText.length - minAnchorLength); oldPos++) {
      for (let len = minAnchorLength; len <= Math.min(30, oldText.length - oldPos); len++) {
        const pattern = oldText.substring(oldPos, oldPos + len);
        const newIndex = newText.indexOf(pattern, newStart);
        
        if (newIndex !== -1 && newIndex <= newStart + maxSearchDistance) {
          const anchor = {
            oldStart: oldPos,
            newStart: newIndex,
            length: len
          };
          
          // 选择最长且最早出现的锚点
          if (!bestAnchor || len > bestAnchor.length || 
              (len === bestAnchor.length && oldPos < bestAnchor.oldStart)) {
            bestAnchor = anchor;
          }
        }
      }
    }
    
    return bestAnchor;
  }

  /**
   * 分析差异段落
   * @private
   */
  _analyzeSegment(oldSegment, newSegment) {
    const alignments = [];
    
    if (!oldSegment && newSegment) {
      // 纯添加
      alignments.push({ type: 'add', content: newSegment });
    } else if (oldSegment && !newSegment) {
      // 纯删除
      alignments.push({ type: 'delete', content: oldSegment });
    } else if (oldSegment && newSegment) {
      // 混合情况，检查是否为简单的前缀/后缀操作
      if (newSegment.startsWith(oldSegment)) {
        // 新文本包含旧文本作为前缀，是纯添加
        const addedContent = newSegment.substring(oldSegment.length);
        alignments.push({ type: 'match', content: oldSegment });
        alignments.push({ type: 'add', content: addedContent });
      } else if (oldSegment.startsWith(newSegment)) {
        // 旧文本包含新文本作为前缀，是纯删除
        const deletedContent = oldSegment.substring(newSegment.length);
        alignments.push({ type: 'match', content: newSegment });
        alignments.push({ type: 'delete', content: deletedContent });
      } else {
        // 尝试找到嵌入的添加
        const embeddedAdds = this._extractEmbeddedAdditions(oldSegment, newSegment);
        if (embeddedAdds.length > 0 && this._isValidEmbeddedAddition(embeddedAdds, oldSegment, newSegment)) {
          alignments.push(...embeddedAdds);
        } else {
          // 作为替换处理
          alignments.push({ type: 'delete', content: oldSegment });
          alignments.push({ type: 'add', content: newSegment });
        }
      }
    }
    
    return alignments;
  }

  /**
   * 验证嵌入式添加是否有效
   * @private
   */
  _isValidEmbeddedAddition(alignments, oldSegment, newSegment) {
    // 重构内容，检查是否能正确还原
    let reconstructedOld = '';
    let reconstructedNew = '';
    
    for (const alignment of alignments) {
      if (alignment.type === 'match') {
        reconstructedOld += alignment.content;
        reconstructedNew += alignment.content;
      } else if (alignment.type === 'add') {
        reconstructedNew += alignment.content;
      } else if (alignment.type === 'delete') {
        reconstructedOld += alignment.content;
      }
    }
    
    return reconstructedOld === oldSegment && reconstructedNew === newSegment;
  }

  /**
   * 提取嵌入的添加内容
   * @private
   */
  _extractEmbeddedAdditions(oldSegment, newSegment) {
    const alignments = [];
    
    // 检查新段落是否包含旧段落的所有内容
    let oldPos = 0;
    let newPos = 0;
    
    while (oldPos < oldSegment.length) {
      const char = oldSegment[oldPos];
      const nextIndex = newSegment.indexOf(char, newPos);
      
      if (nextIndex !== -1) {
        // 找到字符，检查之前是否有添加的内容
        if (nextIndex > newPos) {
          const addedContent = newSegment.substring(newPos, nextIndex);
          alignments.push({ type: 'add', content: addedContent });
        }
        
        // 匹配的字符
        alignments.push({ type: 'match', content: char });
        
        oldPos++;
        newPos = nextIndex + 1;
      } else {
        // 字符在新文本中不存在，可能被删除
        return []; // 返回空数组，表示不是简单的嵌入添加
      }
    }
    
    // 处理末尾的添加内容
    if (newPos < newSegment.length) {
      const addedContent = newSegment.substring(newPos);
      alignments.push({ type: 'add', content: addedContent });
    }
    
    return alignments;
  }



  /**
   * 计算字符级差异
   * @private
   */
  _computeCharLevelDiff(oldText, newText) {
    const diffs = [];
    let oldPos = 0;
    let newPos = 0;

    while (oldPos < oldText.length || newPos < newText.length) {
      // 找到下一个公共子串
      const match = this._findLongestCommonSubstring(
        oldText.substring(oldPos),
        newText.substring(newPos)
      );

      if (match && match.length >= 3) { // 只考虑长度>=3的公共子串
        // 处理公共子串之前的差异
        const oldPrefix = oldText.substring(oldPos, oldPos + match.oldStart);
        const newPrefix = newText.substring(newPos, newPos + match.newStart);

        if (oldPrefix || newPrefix) {
          this._addDifference(diffs, oldPrefix, newPrefix, oldPos);
        }

        // 跳过公共部分
        oldPos += match.oldStart + match.length;
        newPos += match.newStart + match.length;
      } else {
        // 没有找到足够长的公共子串，处理剩余部分
        const remainingOld = oldText.substring(oldPos);
        const remainingNew = newText.substring(newPos);
        
        if (remainingOld || remainingNew) {
          this._addDifference(diffs, remainingOld, remainingNew, oldPos);
        }
        break;
      }
    }

    return diffs;
  }

  /**
   * 找到最长公共子串
   * @private
   */
  _findLongestCommonSubstring(str1, str2) {
    if (!str1 || !str2) return null;

    let maxLength = 0;
    let oldStart = 0;
    let newStart = 0;

    // 动态规划找最长公共子串
    const dp = Array(str1.length + 1).fill(null).map(() => Array(str2.length + 1).fill(0));

    for (let i = 1; i <= str1.length; i++) {
      for (let j = 1; j <= str2.length; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
          if (dp[i][j] > maxLength) {
            maxLength = dp[i][j];
            oldStart = i - maxLength;
            newStart = j - maxLength;
          }
        }
      }
    }

    return maxLength > 0 ? { length: maxLength, oldStart, newStart } : null;
  }

  /**
   * 添加差异记录
   * @private
   */
  _addDifference(diffs, oldText, newText, position) {
    if (oldText && newText) {
      // 替换操作：先删除再添加
      if (oldText.length > 0) {
        diffs.push({
          type: 'delete',
          content: oldText,
          position: position
        });
      }
      if (newText.length > 0) {
        diffs.push({
          type: 'add',
          content: newText,
          position: position
        });
      }
    } else if (oldText) {
      // 纯删除
      diffs.push({
        type: 'delete',
        content: oldText,
        position: position
      });
    } else if (newText) {
      // 纯添加
      diffs.push({
        type: 'add',
        content: newText,
        position: position
      });
    }
  }

  /**
   * 后处理差异：合并相邻的相同类型操作
   * @private
   */
  _postProcessDiffs(diffs) {
    if (diffs.length <= 1) return diffs;

    const merged = [];
    let current = { ...diffs[0] };

    for (let i = 1; i < diffs.length; i++) {
      const next = diffs[i];
      
      // 检查是否可以合并
      if (this._canMerge(current, next)) {
        // 合并操作
        current.content += next.content;
      } else {
        // 不能合并，保存当前操作
        merged.push(current);
        current = { ...next };
      }
    }
    
    merged.push(current);
    return merged;
  }

  /**
   * 检查两个差异操作是否可以合并
   * @private
   */
  _canMerge(current, next) {
    // 必须是相同类型
    if (current.type !== next.type) {
      return false;
    }

    // 位置必须连续或相邻
    if (current.type === 'add') {
      // 添加操作：位置相同或紧邻
      return Math.abs(next.position - current.position) <= current.content.length;
    } else if (current.type === 'delete') {
      // 删除操作：位置紧邻
      return next.position === current.position + current.content.length;
    }

    return false;
  }

}

/**
 * 数据库操作类
 */
class DatabaseManager {
  constructor() {
    this.connection = null;
  }

  /**
   * 连接数据库
   */
  async connect() {
    this.connection = await mysql.createConnection(DB_CONFIG);
    console.log('✅ 数据库连接成功');
  }

  /**
   * 关闭数据库连接
   */
  async close() {
    if (this.connection) {
      await this.connection.end();
    }
  }

  /**
   * 获取pad的版本数据
   */
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

  /**
   * 清理指定pad的变更记录
   */
  async clearPadChanges(padId) {
    await this.connection.execute('DELETE FROM pad_version_changes WHERE pad_id = ?', [padId]);
    console.log('🗑️ 清理旧的变更数据');
  }

  /**
   * 插入变更记录
   */
  async insertChange(change) {
    const query = `
      INSERT INTO pad_version_changes 
      (pad_id, revision, change_type, content, change_position, author_id, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    
    await this.connection.execute(query, [
      change.pad_id,
      change.revision,
      change.change_type,
      change.change_content,
      change.change_position,
      change.author,
      change.timestamp
    ]);
  }

  /**
   * 批量插入变更记录
   */
  async insertChanges(changes) {
    if (changes.length === 0) return;

    for (const change of changes) {
      await this.insertChange(change);
    }
  }
}

/**
 * Pad变更生成器主类
 */
class PadChangesGenerator {
  constructor() {
    this.db = new DatabaseManager();
    this.diffCalculator = new TextDiffCalculator();
  }

  /**
   * 处理单个pad的变更生成
   */
  async generateChanges(padId) {
    console.log(`\n🚀 开始处理 Pad: ${padId}`);
    console.log('='.repeat(50));

    try {
      // 连接数据库
      await this.db.connect();

      // 获取版本数据
      const versions = await this.db.getPadVersions(padId);
      if (versions.length === 0) {
        console.log(`❌ 未找到 Pad ${padId} 的版本数据`);
        return;
      }

      console.log(`📊 找到 ${versions.length} 个版本`);

      // 清理旧数据
      await this.db.clearPadChanges(padId);

      // 逐版本分析变更
      const allChanges = [];
      
      for (let i = 1; i < versions.length; i++) {
        const prevVersion = versions[i - 1];
        const currVersion = versions[i];
        
        const prevContent = prevVersion.content || '';
        const currContent = currVersion.content || '';

        console.log(`\n📝 分析版本 ${prevVersion.revision} → ${currVersion.revision}:`);
        console.log(`   长度: ${prevContent.length} → ${currContent.length}`);
        console.log(`   作者: ${currVersion.author_id || '未知'}`);

        // 计算差异
        const diffs = this.diffCalculator.calculateDiff(prevContent, currContent);
        
        if (diffs.length === 0) {
          console.log(`   ⏭️ 无变更，跳过`);
          continue;
        }

        // 转换为数据库记录格式
        const changeRecords = diffs.map(diff => ({
          pad_id: padId,
          revision: currVersion.revision,
          change_type: diff.type,
          change_content: diff.content,
          change_position: diff.position, // 在原文本中的位置
          author: currVersion.author_id || '',
          timestamp: currVersion.timestamp || Date.now()
        }));

        allChanges.push(...changeRecords);

        console.log(`   ✅ 发现 ${diffs.length} 个变更`);
        diffs.forEach((diff, index) => {
          const preview = diff.content.length > 30 ? 
            diff.content.substring(0, 30) + '...' : 
            diff.content;
          console.log(`      ${index + 1}. ${diff.type.toUpperCase()}: "${preview.replace(/\n/g, '\\n')}" @${diff.position}`);
        });
      }

      // 批量插入变更记录
      if (allChanges.length > 0) {
        await this.db.insertChanges(allChanges);
        console.log(`\n💾 插入 ${allChanges.length} 条变更记录到数据库`);
      }

      // 显示最终统计
      console.log(`\n📊 处理完成统计:`);
      console.log(`   分析版本数: ${versions.length - 1} 个版本对比`);
      console.log(`   生成变更记录: ${allChanges.length} 条`);
      console.log(`   平均每个版本: ${(allChanges.length / Math.max(versions.length - 1, 1)).toFixed(1)} 个变更`);

      console.log(`\n✅ Pad ${padId} 处理完成！`);

    } catch (error) {
      console.error(`❌ 处理失败:`, error);
      throw error;
    } finally {
      await this.db.close();
    }
  }

  /**
   * 验证生成的数据
   */
  async validateResults(padId) {
    console.log(`\n🔍 验证 Pad ${padId} 的生成结果...`);
    
    await this.db.connect();
    
    try {
      // 检查变更记录
      const [changes] = await this.db.connection.execute(
        'SELECT COUNT(*) as count FROM pad_version_changes WHERE pad_id = ?',
        [padId]
      );

      // 按版本统计
      const [versionStats] = await this.db.connection.execute(`
        SELECT 
          revision,
          COUNT(*) as change_count,
          SUM(CASE WHEN change_type = 'add' THEN 1 ELSE 0 END) as adds,
          SUM(CASE WHEN change_type = 'delete' THEN 1 ELSE 0 END) as deletes
        FROM pad_version_changes 
        WHERE pad_id = ?
        GROUP BY revision
        ORDER BY revision
      `, [padId]);

      console.log(`📝 总变更记录数: ${changes[0].count}`);
      console.log(`📊 按版本统计:`);
      versionStats.forEach(stat => {
        console.log(`   版本 ${stat.revision}: ${stat.change_count} 个变更 (${stat.adds} 添加, ${stat.deletes} 删除)`);
      });
      
      console.log(`✅ 验证完成`);
      
      return true;
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

功能说明:
  分析 pad_version_contents_merge 表中相邻版本的文本变化
  生成 pad_version_changes 表的变更记录
  支持连续操作合并，减少记录数量

环境变量:
  DB_HOST     - 数据库主机 (默认: 112.74.92.135)
  DB_USER     - 数据库用户 (默认: root)
  DB_PASSWORD - 数据库密码 (默认: 1q2w3e4R)
  DB_NAME     - 数据库名称 (默认: alic)

注意: 请确保数据库服务正在运行，并且已存在相关表
    `);
    process.exit(0);
  }

  const generator = new PadChangesGenerator();
  
  try {
    await generator.generateChanges(padId);
    await generator.validateResults(padId);
  } catch (error) {
    console.error('❌ 执行失败:', error);
    process.exit(1);
  }
}

// 如果直接运行此文件
if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  PadChangesGenerator,
  TextDiffCalculator,
  DatabaseManager
};