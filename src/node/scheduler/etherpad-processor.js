/**
 * Etherpad数据处理器
 * 仅处理 etherpad_author 和 etherpad_pad_info 两张表
 */

const Database = require('./utils/database.js');
const { extractPadBasicInfo, parsePadData } = require('./utils/parser.js');
const { formatTime, generateTaskId } = require('./utils/scheduler');
const { convertTimestampToBeijingTime } = require('./utils/timeConverter.js');

class EtherpadProcessor {
  constructor() {
    this.db = new Database();
  }

  async connect() {
    await this.db.connect();
  }

  async disconnect() {
    await this.db.disconnect();
  }

  // ==================== etherpad_pad_info 相关方法 ====================

  // 处理单个pad基础信息记录
  async processPadInfo(row, showDetails = false) {
    const padInfo = extractPadBasicInfo(row.key);
    if (!padInfo) {
      return { success: false, reason: 'Invalid pad basic info' };
    }

    try {
      const padData = parsePadData(row.value);
      if (!padData) {
        return { success: false, reason: 'Failed to parse pad data' };
      }

      // 检查记录是否已存在
      const existingRecord = await this.db.checkPadInfoExists(padInfo.padId);

      const insertData = {
        padId: padInfo.padId,
        fullText: padData.fullText,
        attribs: padData.attribs,
        pool: padData.pool,
        nextNum: padData.nextNum,
        head: padData.head,
        chatHead: padData.chatHead,
        publicStatus: padData.publicStatus,
        savedRevisions: padData.savedRevisions
      };

      await this.db.insertPadInfo(insertData);

      if (showDetails) {
        console.log(`📝 ${existingRecord ? '更新' : '新增'}: ${padInfo.padId}`);
      }

      return {
        success: true,
        isNewRecord: !existingRecord,
        padId: padInfo.padId,
        head: padData.head,
        textLength: padData.fullText ? padData.fullText.length : 0,
        authorCount: padData.pool && padData.pool.numToAttrib ? Object.keys(padData.pool.numToAttrib).length : 0
      };
    } catch (error) {
      console.error(`❌ 处理pad基础信息失败 ${padInfo.padId}:`, error);
      return { success: false, reason: error.message };
    }
  }

  // 运行pad基础信息处理任务
  async runPadInfoProcessTask() {
    const taskId = generateTaskId();
    console.log(`🚀 开始处理Pad基础信息任务 ${taskId}`);
    console.log(`⏰ 开始时间: ${formatTime(new Date())}`);

    try {
      await this.connect();
      
      // 获取所有pad基础数据
      console.log('📊 获取store中的pad基础数据...');
      const storeData = await this.db.getAllPadData();
      console.log(`📝 找到 ${storeData.length} 条pad基础记录`);

      if (storeData.length === 0) {
        console.log('✅ 没有需要处理的pad基础数据');
        return { success: true, processed: 0, new: 0, updated: 0 };
      }

      let successCount = 0;
      let failureCount = 0;
      let newRecordCount = 0;
      let updateRecordCount = 0;

      console.log('🔄 开始处理pad基础信息...');
      for (const row of storeData) {
        const result = await this.processPadInfo(row, false);
        
        if (result.success) {
          successCount++;
          if (result.isNewRecord) {
            newRecordCount++;
          } else {
            updateRecordCount++;
          }
        } else {
          failureCount++;
        }

        // 显示进度
        if (successCount % 100 === 0 && successCount > 0) {
          console.log(`📈 Pad信息处理进度: ${successCount}/${storeData.length}`);
        }
      }

      console.log('\n📊 Pad基础信息处理完成统计:');
      console.log(`   总记录数: ${storeData.length}`);
      console.log(`   成功处理: ${successCount}`);
      console.log(`   新增记录: ${newRecordCount}`);
      console.log(`   更新记录: ${updateRecordCount}`);
      console.log(`   处理失败: ${failureCount}`);
      console.log(`⏰ 结束时间: ${formatTime(new Date())}`);

      return {
        success: true,
        taskId,
        total: storeData.length,
        processed: successCount,
        new: newRecordCount,
        updated: updateRecordCount,
        failed: failureCount
      };

    } catch (error) {
      console.error('❌ Pad基础信息处理任务失败:', error);
      return { success: false, error: error.message, taskId };
    } finally {
      await this.disconnect();
    }
  }

  // ==================== etherpad_author 相关方法 ====================

  // 核心方法：处理作者数据的核心逻辑（不含连接管理和任务ID）
  async _syncAuthorDataCore() {
    try {
      // 获取所有 globalAuthor 数据
      const globalAuthorData = await this.db.getGlobalAuthorData();
      console.log(`📊 找到 ${globalAuthorData.length} 个作者记录`);

      if (globalAuthorData.length === 0) {
        return { success: true, processed: 0, inserted: 0, updated: 0, errors: 0 };
      }

      // 清空现有的 etherpad_author 表（全量更新）
      await this.db.clearAuthorTable();

      let processedCount = 0;
      let insertedCount = 0;
      let errorCount = 0;

      // 处理每个作者数据
      for (const authorRecord of globalAuthorData) {
        try {
          const result = await this.processAuthorRecord(authorRecord);
          
          if (result.success) {
            processedCount++;
            insertedCount++;
          } else {
            errorCount++;
          }

          // 显示进度
          if (processedCount % 200 === 0 && processedCount > 0) {
            console.log(`📈 作者处理进度: ${processedCount}/${globalAuthorData.length}`);
          }

        } catch (error) {
          errorCount++;
        }
      }

      return {
        success: true,
        total: globalAuthorData.length,
        processed: processedCount,
        inserted: insertedCount,
        updated: 0, // 全量更新，所以都是插入
        errors: errorCount
      };

    } catch (error) {
      console.error(`❌ 作者数据处理失败:`, error);
      return { success: false, error: error.message };
    }
  }

  // 运行作者数据同步任务
  async runAuthorSyncTask() {
    const taskId = generateTaskId();
    console.log(`👥 开始执行作者数据同步任务 ${taskId}`);
    console.log(`⏰ 开始时间: ${formatTime(new Date())}`);

    try {
      await this.connect();
      
      // 执行作者数据同步
      const result = await this.syncAuthorData();
      
      console.log(`⏰ 结束时间: ${formatTime(new Date())}`);
      return result;

    } catch (error) {
      console.error('❌ 作者数据同步任务失败:', error);
      return { success: false, error: error.message };
    } finally {
      await this.disconnect();
    }
  }

  // 同步作者数据到 etherpad_author 表
  async syncAuthorData() {
    const taskId = generateTaskId();
    console.log(`👥 [${taskId}] 开始同步作者数据到 etherpad_author 表...`);

    try {
      const result = await this._syncAuthorDataCore();
      
      if (result.success) {
        console.log(`✅ [${taskId}] 作者数据同步完成!`);
        console.log(`📊 统计: 总计${result.total}, 成功${result.processed}, 新增${result.inserted}, 错误${result.errors}`);
        
        // 添加 taskId 到结果中
        return { ...result, taskId };
      } else {
        console.error(`❌ [${taskId}] 作者数据同步失败:`, result.error);
        return { ...result, taskId };
      }
      
    } catch (error) {
      console.error(`❌ [${taskId}] 作者数据同步失败:`, error);
      return { success: false, error: error.message, taskId };
    }
  }

  // 处理单个作者记录
  async processAuthorRecord(authorRecord) {
    try {
      // 解析 globalAuthor 键，提取 author_id
      const keyMatch = authorRecord.key.match(/^globalAuthor:(.+)$/);
      if (!keyMatch) {
        return { success: false, reason: 'Invalid globalAuthor key format' };
      }

      const authorId = keyMatch[1];
      
      // 解析作者数据
      const authorData = JSON.parse(authorRecord.value);
      
      // timestamp: 存储原始 JSON 解析的 timestamp (bigint)
      // created_time: 存储北京时区转换后的 datetime
      const createdTimeValue = convertTimestampToBeijingTime(authorData.timestamp);

      // 处理 padIDs - 如果是字符串则转换为 JSON 对象
      let padIDsJson = null;
      if (authorData.padIDs) {
        if (typeof authorData.padIDs === 'string') {
          // 如果是字符串，尝试解析或创建简单对象
          try {
            padIDsJson = JSON.parse(authorData.padIDs);
          } catch (e) {
            // 如果解析失败，将字符串作为单个 pad ID 处理
            padIDsJson = { [authorData.padIDs]: 1 };
          }
        } else if (typeof authorData.padIDs === 'object') {
          padIDsJson = authorData.padIDs;
        }
      }

      // 构建要插入的作者数据
      const insertData = {
        author_id: authorId,
        author_name: authorData.name || null,
        color_id: authorData.colorId !== undefined ? String(authorData.colorId) : null,
        timestamp: authorData.timestamp, // 原始 JSON timestamp (bigint)
        created_time: createdTimeValue, // 北京时区转换后的 datetime
        padIDs: padIDsJson ? JSON.stringify(padIDsJson) : null
      };

      // 插入到 etherpad_author 表
      await this.db.insertAuthorData(insertData);

      return { 
        success: true, 
        authorData: insertData
      };

    } catch (error) {
      return { success: false, reason: error.message };
    }
  }
}

// 命令行入口
async function main() {
  const args = process.argv.slice(2);
  const processor = new EtherpadProcessor();

  if (args.includes('--process-etherpad_author')) {
    // 处理 etherpad_author
    console.log(`👥 [${new Date().toISOString()}] 开始执行 etherpad_author 处理任务`);
    const result = await processor.runAuthorSyncTask();
    
    if (result.success) {
      console.log(`✅ [${new Date().toISOString()}] etherpad_author 处理完成`);
      console.log(`📊 处理统计: 总数${result.total}, 成功${result.processed}, 错误${result.errors}`);
    } else {
      console.log(`❌ [${new Date().toISOString()}] etherpad_author 处理失败: ${result.error}`);
      process.exit(1);
    }

  } else if (args.includes('--process-etherpad_pad_info')) {
    // 处理 etherpad_pad_info
    console.log(`📝 [${new Date().toISOString()}] 开始执行 etherpad_pad_info 处理任务`);
    const result = await processor.runPadInfoProcessTask();
    
    if (result.success) {
      console.log(`✅ [${new Date().toISOString()}] etherpad_pad_info 处理完成`);
      console.log(`📊 处理统计: 总数${result.total}, 新增${result.new}, 更新${result.updated}, 失败${result.failed}`);
    } else {
      console.log(`❌ [${new Date().toISOString()}] etherpad_pad_info 处理失败: ${result.error}`);
      process.exit(1);
    }

  } else {
    // 显示帮助信息
    console.log('🚀 Etherpad数据处理器');
    console.log('═'.repeat(50));
    console.log('使用方法:');
    console.log('  node etherpad-processor.js --process-etherpad_author       # 全量处理 etherpad_author');
    console.log('  node etherpad-processor.js --process-etherpad_pad_info     # 全量处理 etherpad_pad_info');
    console.log('');
    console.log('功能说明:');
    console.log('  --process-etherpad_author: 全量处理作者数据，清空并重新同步所有作者信息');
    console.log('  --process-etherpad_pad_info: 全量处理pad基础信息，提取atext、pool等数据');
    console.log('');
    console.log('数据表说明:');
    console.log('  etherpad_author: 存储作者信息和颜色配置');
    console.log('  etherpad_pad_info: 存储pad的基础信息和当前状态');
  }
}

// 如果直接运行此文件，执行main函数
if (require.main === module) {
  main().catch(error => {
    console.error('程序执行失败:', error);
    process.exit(1);
  });
}

module.exports = EtherpadProcessor;
