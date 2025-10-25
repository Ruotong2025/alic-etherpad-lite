/**
 * Pad 内容重建工具 - 保留删除数据版本
 * 基于 PadContentRebuild.js，增加删除数据保留和合并功能
 * 存储到新表 pad_content_with_deletions，每个 pad 只有一条最新记录
 *
 * 使用方法: node --require tsx/cjs src/node/scheduler/PadContentRebuildWithDeletions.js <padId>
 * 示例: cd src && node --require tsx/cjs node/scheduler/PadContentRebuildWithDeletions.js room-229
 */

'use strict';

// As of v14, Node.js does not exit when there is an unhandled Promise rejection. Convert an
// unhandled rejection into an uncaught exception, which does cause Node.js to exit.
process.on('unhandledRejection', (err) => { throw err; });

// Import required modules using the ep_etherpad-lite prefix
const db = require('ep_etherpad-lite/node/db/DB');
const padManager = require('ep_etherpad-lite/node/db/PadManager');
const Changeset = require('ep_etherpad-lite/static/js/Changeset');
const mysql = require('mysql2/promise');
const settings = require('ep_etherpad-lite/node/utils/Settings');

if (process.argv.length !== 3) {
  console.log('🚀 Etherpad Pad 内容重建工具 - 保留删除数据版本');
  console.log('═'.repeat(60));
  console.log('使用方法: cd src && node --require tsx/cjs node/scheduler/PadContentRebuildWithDeletions.js <padId>');
  console.log('示例: cd src && node --require tsx/cjs node/scheduler/PadContentRebuildWithDeletions.js room-229');
  console.log('');
  console.log('功能说明:');
  console.log('  - 基于 PadContentRebuild.js 的核心逻辑');
  console.log('  - 保留所有删除的数据并标记作者');
  console.log('  - 智能合并相同作者的相邻删除操作');
  console.log('  - 使用香港时区时间格式');
  console.log('  - 存储到 pad_content_with_deletions 表');
  console.log('  - 每个 pad 只保留一条最新记录');
  process.exit(1);
}

/**
 * 香港时区时间转换工具
 */
class HongKongTimeConverter {
  static toHKDateTime(timestamp) {
    const date = new Date(timestamp);
    // 转换为香港时区 (UTC+8)
    const hkDate = new Date(date.getTime() + (8 * 60 * 60 * 1000));
    return hkDate.toISOString().slice(0, 19).replace('T', ' ') + ' HKT';
  }

  static parseHKDateTime(hkDateTimeStr) {
    // 解析 "2024-01-01 14:30:00 HKT" 格式
    const dateStr = hkDateTimeStr.replace(' HKT', '');
    const date = new Date(dateStr);
    // 减去8小时转回UTC
    return date.getTime() - (8 * 60 * 60 * 1000);
  }

  static getTimeDifferenceMinutes(datetime1, datetime2) {
    const time1 = typeof datetime1 === 'string' ? this.parseHKDateTime(datetime1) : datetime1;
    const time2 = typeof datetime2 === 'string' ? this.parseHKDateTime(datetime2) : datetime2;
    return Math.abs(time2 - time1) / (1000 * 60); // 转换为分钟
  }
}

/**
 * 内容块合并器
 */
class ContentBlockMerger {
  constructor() {
    this.mergeTimeThreshold = 30; // 30分钟
  }

  /**
   * 合并相邻的内容块
   */
  mergeBlocks(blocks) {
    if (!blocks || blocks.length === 0) return [];

    const merged = [];
    let currentGroup = null;

    for (const block of blocks) {
      if (this.canMergeWithCurrentGroup(currentGroup, block)) {
        // 合并到当前组
        this.addBlockToGroup(currentGroup, block);
      } else {
        // 结束当前组，开始新组
        if (currentGroup) {
          merged.push(this.finalizeGroup(currentGroup));
        }
        currentGroup = this.createNewGroup(block);
      }
    }

    // 处理最后一组
    if (currentGroup) {
      merged.push(this.finalizeGroup(currentGroup));
    }

    return merged;
  }

  /**
   * 检查是否可以与当前组合并
   */
  canMergeWithCurrentGroup(currentGroup, block) {
    if (!currentGroup) return false;

    // 检查类型和作者
    if (currentGroup.type !== block.type || currentGroup.author !== block.author) {
      return false;
    }

    // 检查时间间隔：上一条的end到当前条的start
    const lastEndTime = currentGroup.endDatetime || currentGroup.datetime;
    const timeDiff = HongKongTimeConverter.getTimeDifferenceMinutes(lastEndTime, block.datetime);
    
    return timeDiff <= this.mergeTimeThreshold;
  }

  /**
   * 创建新的合并组
   */
  createNewGroup(block) {
    return {
      type: block.type,
      author: block.author,
      content: block.content,
      datetime: block.datetime,
      endDatetime: null,
      blocks: [block]
    };
  }

  /**
   * 添加块到组
   */
  addBlockToGroup(group, block) {
    group.content += block.content;
    group.endDatetime = block.datetime;
    group.blocks.push(block);
  }

  /**
   * 完成组的合并
   */
  finalizeGroup(group) {
    const result = {
      type: group.type,
      content: group.content,
      author: group.author,
      datetime: group.datetime
    };

    // 如果是合并的多个块，添加结束时间
    if (group.blocks.length > 1) {
      result.endDatetime = group.endDatetime;
    }

    return result;
  }
}

/**
 * 文档重建器 - 累积所有删除操作并在最终位置显示
 */
class DocumentRebuilder {
  constructor() {
    this.allDeletions = []; // 累积所有删除操作
  }

  /**
   * 应用 changeset 并收集删除信息
   */
  applyChangesetWithTracking(changeset, currentText, author, timestamp, revision, applyToAText, atext, pool) {
    try {
      // 解析 changeset 收集删除信息
      const unpacked = Changeset.unpack(changeset);
      const operations = Changeset.deserializeOps(unpacked.ops);
      
      let position = 0;
      
      for (const op of operations) {
        if (op.opcode === '=') {
          // 保持操作，移动位置
          position += op.chars;
        } else if (op.opcode === '+') {
          // 插入操作，不移动原文位置
          // 不需要处理
        } else if (op.opcode === '-') {
          // 删除操作 - 记录被删除的内容
          const deletedContent = currentText.slice(position, position + op.chars);
          if (deletedContent.length > 0) {
            this.allDeletions.push({
              type: 'deleted',
              content: deletedContent,
              author: author,
              datetime: HongKongTimeConverter.toHKDateTime(timestamp),
              revision: revision,
              originalPosition: position
            });
          }
          position += op.chars;
        }
      }
      
      // 应用 changeset 获取新的文本状态
      const newAtext = applyToAText(changeset, atext, pool);
      
      return {
        newAtext,
        deletions: this.allDeletions
      };
      
    } catch (error) {
      console.warn(`⚠️  应用 changeset 失败 (rev ${revision}):`, error.message);
      // 如果解析失败，仍然应用 changeset
      const newAtext = applyToAText(changeset, atext, pool);
      return {
        newAtext,
        deletions: this.allDeletions
      };
    }
  }

  /**
   * 生成包含删除标记的完整文档
   */
  generateDocumentWithDeletions(finalText) {
    // 处理最终文本
    let pureText = finalText;
    if (pureText.endsWith('\n')) {
      pureText = pureText.slice(0, -1);
    }

    // 如果没有删除操作，直接返回纯文本
    if (this.allDeletions.length === 0) {
      return {
        blocks: [{
          type: 'normal',
          content: pureText,
          author: 'system',
          datetime: HongKongTimeConverter.toHKDateTime(Date.now())
        }],
        displayText: pureText
      };
    }

    // 构建包含删除标记的文档
    // 这里需要将删除的内容插入到合适的位置
    let result = pureText;
    
    // 按原始位置倒序插入删除标记，避免位置偏移
    const sortedDeletions = [...this.allDeletions].sort((a, b) => b.originalPosition - a.originalPosition);
    
    for (const deletion of sortedDeletions) {
      const timeStr = deletion.datetime.slice(5, 16); // MM-DD HH:mm
      const deleteMarker = `[DEL:${deletion.author}:${timeStr}] ${deletion.content} [/DEL]`;
      
      // 在原始位置插入删除标记
      // 注意：这里的位置是基于原始文档的，需要调整
      let insertPos = Math.min(deletion.originalPosition, result.length);
      result = result.slice(0, insertPos) + deleteMarker + result.slice(insertPos);
    }

    // 生成块结构
    const blocks = [];
    
    // 添加正常内容块
    if (pureText.length > 0) {
      blocks.push({
        type: 'normal',
        content: pureText,
        author: 'system',
        datetime: HongKongTimeConverter.toHKDateTime(Date.now())
      });
    }
    
    // 添加删除块
    for (const deletion of this.allDeletions) {
      blocks.push(deletion);
    }

    return {
      blocks,
      displayText: result
    };
  }

  /**
   * 获取所有删除操作
   */
  getAllDeletions() {
    return this.allDeletions;
  }
}

/**
 * Pad 内容重建器 - 保留删除数据版本
 */
class PadContentRebuildWithDeletions {
  constructor() {
    this.documentRebuilder = new DocumentRebuilder();
    this.blockMerger = new ContentBlockMerger();
  }

  /**
   * 重建 Pad 内容，保留删除数据
   */
  async rebuildPad(padId) {
    console.log(`\n🔄 开始重建 ${padId} (保留删除数据)...`);
    
    try {
      // 获取 Changeset 核心函数 - 和 PadContentRebuild.js 一样
      console.log('🔧 加载 Changeset 模块...');
      const { makeAText, applyToAText } = Changeset;
      console.log('✓ Changeset 模块加载成功');

      // 检查 pad 是否存在
      console.log(`🔍 检查 Pad [${padId}] 是否存在...`);
      const exists = await padManager.doesPadExists(padId);
      if (!exists) {
        console.error(`✗ Pad [${padId}] 不存在`);
        throw new Error(`Pad [${padId}] 不存在`);
      }

      // 获取 pad 基础信息
      const pad = await padManager.getPad(padId);
      const headRevision = pad.getHeadRevisionNumber();
      
      console.log(`✓ 找到 Pad [${padId}], 当前版本: ${headRevision}`);
      
      // 初始化文档状态 - 完全模拟 PadContentRebuild.js
      console.log('🚀 开始重建版本内容...');
      let atext = makeAText('\n');
      console.log(`✓ 初始化文本: "${atext.text.replace(/\n/g, '\\n')}"`);
      
      // 逐版本应用 changeset，同时收集删除信息
      for (let rev = 0; rev <= headRevision; rev++) {
        try {
          const revData = await db.get(`pad:${padId}:revs:${rev}`);
          
          if (!revData) {
            console.error(`  ✗ Rev ${rev}: 数据不存在`);
            continue;
          }

          const { changeset, meta } = revData;
          const { author, timestamp, pool: metaPool } = meta;
          
          // 使用版本的 pool（如果有）或 pad 的全局 pool
          const pool = metaPool || pad.apool();
          
          console.log(`  📝 处理版本 ${rev}: ${author} @ ${HongKongTimeConverter.toHKDateTime(timestamp)}`);
          
          // 应用 changeset 并收集删除信息
          const oldText = atext.text;
          const result = this.documentRebuilder.applyChangesetWithTracking(
            changeset, oldText, author, timestamp, rev, applyToAText, atext, pool
          );
          
          atext = result.newAtext;
          const newText = atext.text;
          
          console.log(`    变更: ${oldText.length} -> ${newText.length} 字符, 累积删除 ${result.deletions.length} 个`);
          
        } catch (error) {
          console.error(`  ❌ Rev ${rev} 处理失败:`, error.message);
        }
      }
      
      // 生成包含删除标记的最终文档
      const documentResult = this.documentRebuilder.generateDocumentWithDeletions(atext.text);
      
      // 生成最终结果
      const finalResult = this.generateFinalDocument(padId, headRevision, atext.text, documentResult);
      
      // 保存到数据库
      await this.saveToDatabase(finalResult);
      
      console.log(`\n✅ 重建完成！`);
      console.log(`📊 最终统计:`);
      console.log(`   纯净文本长度: ${finalResult.summary.pureLength}`);
      console.log(`   删除块数量: ${finalResult.summary.deletedBlocks}`);
      console.log(`   正常块数量: ${finalResult.summary.normalBlocks}`);
      
      return finalResult;
      
    } catch (error) {
      console.error(`❌ 重建失败:`, error);
      throw error;
    }
  }

  /**
   * 生成最终文档
   */
  generateFinalDocument(padId, latestRevision, finalText, documentResult) {
    // 处理最终文本
    let pureText = finalText;
    if (pureText.endsWith('\n')) {
      pureText = pureText.slice(0, -1);
    }
    
    // 合并相邻的同类型同作者块
    const mergedBlocks = this.blockMerger.mergeBlocks(documentResult.blocks);
    
    // 按序列排列
    const documentFlow = mergedBlocks.map((block, index) => ({
      sequence: index + 1,
      ...block
    }));
    
    // 使用重建器生成的显示文本
    const displayText = documentResult.displayText;
    
    // 统计信息
    const normalBlocks = documentFlow.filter(b => b.type === 'normal');
    const deletedBlocks = documentFlow.filter(b => b.type === 'deleted');
    
    return {
      padId,
      latestRevision,
      lastModified: HongKongTimeConverter.toHKDateTime(Date.now()),
      documentFlow,
      summary: {
        pureText,
        displayText,
        totalBlocks: documentFlow.length,
        normalBlocks: normalBlocks.length,
        deletedBlocks: deletedBlocks.length,
        authors: [...new Set(documentFlow.map(b => b.author))],
        pureLength: pureText.length,
        totalLength: displayText.length
      }
    };
  }

  /**
   * 生成显示文本
   */
  generateDisplayText(blocks) {
    let result = '';
    
    for (const block of blocks) {
      if (block.type === 'normal') {
        result += block.content;
      } else if (block.type === 'deleted') {
        const timeStr = block.datetime.slice(5, 16); // MM-DD HH:mm
        
        if (block.endDatetime) {
          const endTimeStr = block.endDatetime.slice(5, 16);
          result += `[DEL:${block.author}:${timeStr}-${endTimeStr}] ${block.content} [/DEL]`;
        } else {
          result += `[DEL:${block.author}:${timeStr}] ${block.content} [/DEL]`;
        }
      }
    }
    
    return result;
  }

  /**
   * 保存到数据库
   */
  async saveToDatabase(result) {
    console.log('\n💾 保存到数据库...');
    
    try {
      // 1. 保存到 key-value 存储
      const kvKey = `pad_content_with_deletions:${result.padId}`;
      await db.set(kvKey, {
        ...result,
        created_at: Date.now(),
        updated_at: Date.now()
      });
      
      console.log(`✓ 已保存到 key-value 存储: ${kvKey}`);
      
      // 2. 保存到 MySQL（如果配置了的话）
      if (settings.dbType === 'mysql') {
        await this.saveToMySQL(result);
      }
      
    } catch (error) {
      console.error('❌ 保存到数据库失败:', error);
      throw error;
    }
  }

  /**
   * 保存到 MySQL
   */
  async saveToMySQL(result) {
    try {
      const mysqlConnection = await mysql.createConnection({
        host: settings.dbSettings.host,
        user: settings.dbSettings.user,
        password: settings.dbSettings.password,
        database: settings.dbSettings.database,
        charset: 'utf8mb4'
      });

      // 创建表（如果不存在）
      await mysqlConnection.execute(`
        CREATE TABLE IF NOT EXISTS pad_content_with_deletions (
          pad_id VARCHAR(100) PRIMARY KEY,
          latest_revision INT NOT NULL,
          content_json JSON NOT NULL,
          pure_text LONGTEXT,
          display_text LONGTEXT,
          total_blocks INT DEFAULT 0,
          normal_blocks INT DEFAULT 0,
          deleted_blocks INT DEFAULT 0,
          authors JSON,
          pure_length INT DEFAULT 0,
          total_length INT DEFAULT 0,
          last_modified DATETIME,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_last_modified (last_modified),
          INDEX idx_pure_length (pure_length),
          INDEX idx_deleted_blocks (deleted_blocks)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // 插入或更新记录
      await mysqlConnection.execute(`
        INSERT INTO pad_content_with_deletions 
        (pad_id, latest_revision, content_json, pure_text, display_text, 
         total_blocks, normal_blocks, deleted_blocks, authors, 
         pure_length, total_length, last_modified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        latest_revision = VALUES(latest_revision),
        content_json = VALUES(content_json),
        pure_text = VALUES(pure_text),
        display_text = VALUES(display_text),
        total_blocks = VALUES(total_blocks),
        normal_blocks = VALUES(normal_blocks),
        deleted_blocks = VALUES(deleted_blocks),
        authors = VALUES(authors),
        pure_length = VALUES(pure_length),
        total_length = VALUES(total_length),
        last_modified = VALUES(last_modified)
      `, [
        result.padId,
        result.latestRevision,
        JSON.stringify(result),
        result.summary.pureText,
        result.summary.displayText,
        result.summary.totalBlocks,
        result.summary.normalBlocks,
        result.summary.deletedBlocks,
        JSON.stringify(result.summary.authors),
        result.summary.pureLength,
        result.summary.totalLength,
        result.lastModified.replace(' HKT', '')
      ]);

      await mysqlConnection.end();
      console.log(`✓ 已保存到 MySQL 表: pad_content_with_deletions`);
      
    } catch (error) {
      console.error('❌ 保存到 MySQL 失败:', error);
      // 不抛出错误，因为 key-value 存储已经成功
    }
  }
}

// 主执行逻辑
(async () => {
  const padId = process.argv[2];
  
  console.log(`\n========================================`);
  console.log(`🚀 Pad 内容重建工具 - 保留删除数据版本`);
  console.log(`========================================`);
  console.log(`📝 目标 Pad: ${padId}`);
  console.log(`⏰ 开始时间: ${new Date().toLocaleString('zh-CN')}`);
  
  try {
    // 初始化数据库 - 这是关键！
    console.log('🔧 初始化 Etherpad 数据库...');
    await db.init();
    console.log('✓ 数据库初始化完成');
    
    const rebuilder = new PadContentRebuildWithDeletions();
    const result = await rebuilder.rebuildPad(padId);
    
    console.log(`\n🎉 重建成功完成！`);
    console.log(`📄 最终结果预览:`);
    console.log(`   纯净文本: "${result.summary.pureText.substring(0, 100)}${result.summary.pureText.length > 100 ? '...' : ''}"`);
    console.log(`   显示文本: "${result.summary.displayText.substring(0, 100)}${result.summary.displayText.length > 100 ? '...' : ''}"`);
    
  } catch (error) {
    console.error(`\n❌ 重建失败:`, error.message);
    process.exit(1);
  }
  
  console.log(`⏰ 结束时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log(`========================================\n`);
})();
