/**
 * Etherpad数据处理器
 * 处理 etherpad_author、etherpad_pad_info 和 pad_version_changes
 */

const Database = require('./utils/database.js');
const { extractPadBasicInfo, parsePadData } = require('./utils/parser.js');
const { formatTime, generateTaskId } = require('./utils/scheduler');
const { convertTimestampToBeijingTime } = require('./utils/timeConverter.js');
const { fork } = require('child_process');
const path = require('path');

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
        savedRevisions: padData.savedRevisions,
        roomName: padData.roomName || null  // roomName：如果没有，设置为 null（容错处理）
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

  // ==================== pad_version_changes 相关方法 ====================

  /**
   * 检测前一天有变更的 pads (通过检测前一天的时间戳)
   * 使用北京时间计算日期，确保与 cron 配置的时区一致
   */
  async detectChangedPads(targetDate = null) {
    console.log('🔍 开始检测前一天有变更的 pads...');
    
    try {
      // 计算目标日期 (默认为昨天，使用北京时间)
      let date;
      if (targetDate) {
        date = new Date(targetDate);
      } else {
        // 使用北京时间计算昨天
        // 步骤1: 获取当前北京时间
        const nowBeijing = new Date();
        // 转换为北京时间 (UTC+8)
        const beijingOffset = 8 * 60 * 60 * 1000; // 8小时
        const nowUTC = nowBeijing.getTime() + (nowBeijing.getTimezoneOffset() * 60 * 1000);
        const nowBeijingTime = new Date(nowUTC + beijingOffset);
        
        // 步骤2: 在北京时间上减去1天得到昨天
        date = new Date(nowBeijingTime);
        date.setDate(date.getDate() - 1);
      }
      
      // 计算目标日期的时间范围（使用北京时间）
      // 先转换为北京时间当天 00:00:00
      const beijingOffset = 8 * 60 * 60 * 1000; // 8小时
      
      // 北京时间当天的开始 (00:00:00 北京时间)
      const startOfDayUTC = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
      // 转换为 UTC 时间戳 (减去8小时)
      const startTimestamp = startOfDayUTC.getTime() - beijingOffset;
      
      // 北京时间当天的结束 (23:59:59.999 北京时间)
      const endOfDayUTC = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
      // 转换为 UTC 时间戳 (减去8小时)
      const endTimestamp = endOfDayUTC.getTime() - beijingOffset;
      
      // 格式化显示北京时间范围
      const startBeijing = new Date(startTimestamp + beijingOffset);
      const endBeijing = new Date(endTimestamp + beijingOffset);
      const padDateStr = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
      
      console.log(`📅 检测日期(北京时间): ${padDateStr} (前一天)`);
      console.log(`📅 北京时间范围: ${padDateStr} 00:00:00 ~ 23:59:59`);
      console.log(`📅 北京时间 00:00:00 = UTC 时间戳: ${startTimestamp}`);
      console.log(`📅 北京时间 23:59:59 = UTC 时间戳: ${endTimestamp}`);
      console.log(`📅 时间戳范围: ${startTimestamp} ~ ${endTimestamp}`);
      
      // 从 store 表中查询当天有变更的 pads
      // store 表的 value 中包含 meta.timestamp
      const query = `
        SELECT DISTINCT
          SUBSTRING_INDEX(SUBSTRING_INDEX(\`key\`, ':', 2), ':', -1) as pad_id
        FROM store
        WHERE \`key\` LIKE 'pad:%:revs:%'
          AND JSON_EXTRACT(value, '$.meta.timestamp') >= ?
          AND JSON_EXTRACT(value, '$.meta.timestamp') <= ?
        ORDER BY pad_id
      `;
      
      const [pads] = await this.db.connection.execute(query, [startTimestamp, endTimestamp]);
      console.log(`📊 找到 ${pads.length} 个前一天有变更的 pads`);
      
      const changedPads = pads.map(row => ({
        padId: row.pad_id,
        detectionDate: padDateStr
      }));
      
      if (changedPads.length > 0) {
        console.log('\n📝 需要处理的 Pads:');
        changedPads.forEach((pad, index) => {
          console.log(`  ${index + 1}. ${pad.padId}`);
        });
      }
      
      console.log(`\n📊 检测结果: 共 ${changedPads.length} 个 pads 需要处理`);
      return changedPads;
      
    } catch (error) {
      console.error('❌ 检测变更失败:', error);
      throw error;
    }
  }

  /**
   * 处理单个 pad 的 changes (调用 generatePadChanges.js)
   */
  async processPadChanges(padId) {
    console.log(`\n🔧 处理 pad: ${padId}`);
    
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(__dirname, 'etherpad_changes', 'generatePadChanges.js');
      
      // 设置正确的工作目录(src目录),以便能找到 ep_etherpad-lite 模块
      const srcDir = path.join(__dirname, '../..');
      
      // 使用 fork 执行 generatePadChanges.js
      // 需要添加 --require tsx/cjs 以便加载 TypeScript 模块
      const child = fork(scriptPath, [padId], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        cwd: srcDir,  // 在 src 目录下运行
        execArgv: ['--require', 'tsx/cjs']  // 添加 tsx/cjs 加载器
      });
      
      let output = '';
      let errorOutput = '';
      
      child.stdout.on('data', (data) => {
        const text = data.toString();
        output += text;
        process.stdout.write(text); // 实时输出
      });
      
      child.stderr.on('data', (data) => {
        const text = data.toString();
        errorOutput += text;
        process.stderr.write(text); // 实时输出错误
      });
      
      child.on('exit', (code) => {
        if (code === 0) {
          console.log(`✅ ${padId} 处理完成`);
          resolve({ success: true, padId, output });
        } else {
          console.error(`❌ ${padId} 处理失败 (退出码: ${code})`);
          reject(new Error(`Process exited with code ${code}: ${errorOutput}`));
        }
      });
      
      child.on('error', (error) => {
        console.error(`❌ ${padId} 执行错误:`, error);
        reject(error);
      });
    });
  }

  /**
   * 获取所有 pads (全量)
   */
  async getAllPads() {
    console.log('🔍 开始获取所有 pads...');
    
    try {
      // 从 store 表中查询所有 pads
      const query = `
        SELECT DISTINCT
          SUBSTRING_INDEX(SUBSTRING_INDEX(\`key\`, ':', 2), ':', -1) as pad_id
        FROM store
        WHERE \`key\` LIKE 'pad:%:revs:%'
        ORDER BY pad_id
      `;
      
      const [pads] = await this.db.connection.execute(query);
      console.log(`📊 找到 ${pads.length} 个 pads`);
      
      const allPads = pads.map(row => ({
        padId: row.pad_id
      }));
      
      if (allPads.length > 0) {
        console.log('\n📝 需要处理的 Pads 总数:', allPads.length);
      }
      
      return allPads;
      
    } catch (error) {
      console.error('❌ 获取所有 pads 失败:', error);
      throw error;
    }
  }

  /**
   * 运行 pad changes 处理任务（增量 - 仅处理前一天有变更的）
   */
  async runPadChangesTask() {
    const taskId = generateTaskId();
    console.log(`🚀 开始执行 Pad Changes 处理任务 ${taskId}`);
    console.log(`⏰ 开始时间: ${formatTime(new Date())}`);
    
    try {
      await this.connect();
      
      // 1. 检测有变更的 pads
      const changedPads = await this.detectChangedPads();
      
      if (changedPads.length === 0) {
        console.log('✅ 没有需要处理的 pads');
        return {
          success: true,
          taskId,
          total: 0,
          processed: 0,
          failed: 0
        };
      }
      
      // 2. 逐个处理有变更的 pads
      let processedCount = 0;
      let failedCount = 0;
      const failedPads = [];
      
      for (const pad of changedPads) {
        try {
          await this.processPadChanges(pad.padId);
          processedCount++;
        } catch (error) {
          console.error(`❌ 处理 ${pad.padId} 失败:`, error.message);
          failedCount++;
          failedPads.push({
            padId: pad.padId,
            error: error.message
          });
        }
        
        // 显示进度
        console.log(`\n📈 进度: ${processedCount + failedCount}/${changedPads.length}`);
      }
      
      console.log('\n📊 Pad Changes 处理完成统计:');
      console.log(`   总数: ${changedPads.length}`);
      console.log(`   成功: ${processedCount}`);
      console.log(`   失败: ${failedCount}`);
      
      if (failedPads.length > 0) {
        console.log('\n失败的 Pads:');
        failedPads.forEach(p => console.log(`  - ${p.padId}: ${p.error}`));
      }
      
      console.log(`⏰ 结束时间: ${formatTime(new Date())}`);
      
      return {
        success: true,
        taskId,
        total: changedPads.length,
        processed: processedCount,
        failed: failedCount,
        failedPads
      };
      
    } catch (error) {
      console.error('❌ Pad Changes 处理任务失败:', error);
      return { success: false, error: error.message, taskId };
    } finally {
      await this.disconnect();
    }
  }

  /**
   * 运行 pad changes 全量处理任务（处理所有 pads）
   */
  async runPadChangesFullTask() {
    const taskId = generateTaskId();
    console.log(`🚀 开始执行 Pad Changes 全量处理任务 ${taskId}`);
    console.log(`⏰ 开始时间: ${formatTime(new Date())}`);
    console.log(`⚠️  警告: 这将重新处理所有 pads 的 changes 数据！`);
    
    try {
      await this.connect();
      
      // 1. 获取所有 pads
      const allPads = await this.getAllPads();
      
      if (allPads.length === 0) {
        console.log('✅ 没有需要处理的 pads');
        return {
          success: true,
          taskId,
          total: 0,
          processed: 0,
          failed: 0
        };
      }
      
      // 2. 逐个处理所有 pads
      let processedCount = 0;
      let failedCount = 0;
      const failedPads = [];
      
      for (const pad of allPads) {
        try {
          await this.processPadChanges(pad.padId);
          processedCount++;
        } catch (error) {
          console.error(`❌ 处理 ${pad.padId} 失败:`, error.message);
          failedCount++;
          failedPads.push({
            padId: pad.padId,
            error: error.message
          });
        }
        
        // 显示进度
        console.log(`\n📈 进度: ${processedCount + failedCount}/${allPads.length}`);
      }
      
      console.log('\n📊 Pad Changes 全量处理完成统计:');
      console.log(`   总数: ${allPads.length}`);
      console.log(`   成功: ${processedCount}`);
      console.log(`   失败: ${failedCount}`);
      
      if (failedPads.length > 0) {
        console.log('\n失败的 Pads:');
        failedPads.forEach(p => console.log(`  - ${p.padId}: ${p.error}`));
      }
      
      console.log(`⏰ 结束时间: ${formatTime(new Date())}`);
      
      return {
        success: true,
        taskId,
        total: allPads.length,
        processed: processedCount,
        failed: failedCount,
        failedPads
      };
      
    } catch (error) {
      console.error('❌ Pad Changes 全量处理任务失败:', error);
      return { success: false, error: error.message, taskId };
    } finally {
      await this.disconnect();
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

  } else if (args.includes('--process-pad_changes')) {
    // 处理 pad_version_changes (智能增量)
    console.log(`🔄 [${new Date().toISOString()}] 开始执行 Pad Changes 智能增量处理任务`);
    const result = await processor.runPadChangesTask();
    
    if (result.success) {
      console.log(`✅ [${new Date().toISOString()}] Pad Changes 处理完成`);
      console.log(`📊 处理统计: 总数${result.total}, 成功${result.processed}, 失败${result.failed}`);
    } else {
      console.log(`❌ [${new Date().toISOString()}] Pad Changes 处理失败: ${result.error}`);
      process.exit(1);
    }

  } else if (args.includes('--process-pad_changes-full')) {
    // 处理 pad_version_changes (全量重跑)
    console.log(`🔄 [${new Date().toISOString()}] 开始执行 Pad Changes 全量处理任务`);
    console.log(`⚠️  警告: 这将重新处理所有 pads 的 changes 数据！`);
    const result = await processor.runPadChangesFullTask();
    
    if (result.success) {
      console.log(`✅ [${new Date().toISOString()}] Pad Changes 全量处理完成`);
      console.log(`📊 处理统计: 总数${result.total}, 成功${result.processed}, 失败${result.failed}`);
    } else {
      console.log(`❌ [${new Date().toISOString()}] Pad Changes 全量处理失败: ${result.error}`);
      process.exit(1);
    }

  } else {
    // 显示帮助信息
    console.log('🚀 Etherpad数据处理器');
    console.log('═'.repeat(50));
    console.log('使用方法:');
    console.log('  node etherpad-processor.js --process-etherpad_author       # 全量处理 etherpad_author');
    console.log('  node etherpad-processor.js --process-etherpad_pad_info     # 全量处理 etherpad_pad_info');
    console.log('  node etherpad-processor.js --process-pad_changes           # 智能增量处理 pad_version_changes');
    console.log('  node etherpad-processor.js --process-pad_changes-full      # 全量重跑所有 pad_version_changes');
    console.log('');
    console.log('功能说明:');
    console.log('  --process-etherpad_author: 全量处理作者数据，清空并重新同步所有作者信息');
    console.log('  --process-etherpad_pad_info: 全量处理pad基础信息，提取atext、pool等数据');
    console.log('  --process-pad_changes: 智能增量处理，检测有变更的pads并重新生成changes数据');
    console.log('  --process-pad_changes-full: 全量重跑，处理所有pads的changes数据（手动运行）');
    console.log('');
    console.log('数据表说明:');
    console.log('  etherpad_author: 存储作者信息和颜色配置');
    console.log('  etherpad_pad_info: 存储pad的基础信息和当前状态');
    console.log('  pad_version_changes: 存储pad的版本变更历史和操作记录');
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
