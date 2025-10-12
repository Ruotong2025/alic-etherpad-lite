/**
 * Etherpad数据处理器
 * 合并了定时任务处理和数据格式更新功能
 */

const mysql = require('mysql2/promise');
const Database = require('./utils/database.js');
const { parseAndGroupByPad, formatParseReport } = require('./utils/json-parser.js');
const { analyzeChangesetContent, ContentReconstructor, extractPadInfo, extractPadBasicInfo, parsePadData } = require('./utils/parser.js');
const { calculateTimeRange, getYesterday, formatTime, generateTaskId } = require('./utils/scheduler');
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

  // 处理单个changeset记录
  async processRecord(row, showDetails = false) {
    const padInfo = extractPadInfo(row.key);
    if (!padInfo) {
      return { success: false, reason: 'Invalid pad info' };
    }

    try {
      const valueData = JSON.parse(row.value);
      const changeset = valueData.changeset;
      const meta = valueData.meta;

      // 检查记录是否已存在
      const existingRecord = await this.db.checkRecordExists(padInfo.padId, padInfo.revision);

      let insertData;

      if (existingRecord) {
        // 如果记录已存在，只更新content字段（如果为空），保留原有的字段
        const existingData = await this.db.getPadVersionRecord(padInfo.padId, padInfo.revision);
        
        insertData = {
          padId: padInfo.padId,
          revision: padInfo.revision,
          content: existingData.content || null, // 保持原有content，稍后可能会被重建
          author: existingData.author,
          timestamp: existingData.timestamp,
          changeset: existingData.changeset,
          changeBehavior: existingData.change_behavior,
          changeContent: existingData.change_content,
          changePosition: existingData.change_position
        };
      } else {
        // 新记录，进行完整的changeset分析
        // 获取历史内容用于分析
        const previousContent = await this.db.getPadContent(padInfo.padId, padInfo.revision);
        const baseDocument = previousContent ? previousContent.content || '' : '';

        // 分析changeset
        const analysis = analyzeChangesetContent(changeset, baseDocument);

        insertData = {
          padId: padInfo.padId,
          revision: padInfo.revision,
          content: null, // 内容将在后续重建
          author: meta.author,
          timestamp: meta.timestamp,
          changeset: changeset,
          changeBehavior: analysis.change_behavior,
          changeContent: analysis.change_content,
          changePosition: analysis.change_position || null
        };
      }

      await this.db.insertPadVersion(insertData);

      if (showDetails) {
        console.log(`📝 ${existingRecord ? '更新' : '新增'}: ${padInfo.padId}:rev${padInfo.revision}`);
      }

      return { 
        success: true, 
        isUpdate: existingRecord,
        padInfo,
        insertData
      };

    } catch (error) {
      console.error(`❌ 处理记录失败 ${row.key}:`, error.message);
      return { success: false, reason: error.message };
    }
  }

  // 增量处理 etherpad_pad_version 数据（前一天的数据）
  async processIncrementalPadVersion(targetDate = null) {
    const taskId = generateTaskId();
    const processDate = targetDate || getYesterday();
    console.log(`🚀 [${taskId}] 开始增量处理 etherpad_pad_version 数据 (${processDate.toLocaleDateString()})...`);

    try {
      // 计算时间范围
      const timeRange = calculateTimeRange(processDate);
      console.log(`📅 时间范围: ${formatTime(timeRange.startTime)} 到 ${formatTime(timeRange.endTime)}`);

      // 获取store数据
      const storeData = await this.db.getStoreData(timeRange.startTime, timeRange.endTime);
      console.log(`📊 获取到 ${storeData.length} 条store记录`);

      if (storeData.length === 0) {
        console.log('✅ 没有需要处理的数据');
        return { success: true, processed: 0, inserted: 0, updated: 0, errors: 0 };
      }

      let processedCount = 0;
      let insertedCount = 0;
      let updatedCount = 0;
      let errorCount = 0;

      // 处理数据
      for (const row of storeData) {
        const result = await this.processRecord(row, false);
        
        if (result.success) {
          processedCount++;
          if (result.isUpdate) {
            updatedCount++;
          } else {
            insertedCount++;
          }
        } else {
          errorCount++;
        }

        // 显示进度
        if (processedCount % 500 === 0 && processedCount > 0) {
          console.log(`📈 已处理 ${processedCount}/${storeData.length} 条记录...`);
        }
      }

      console.log(`✅ [${taskId}] 基础处理完成!`);
      console.log(`📊 统计: 总计${storeData.length}, 成功${processedCount}, 新增${insertedCount}, 更新${updatedCount}, 错误${errorCount}`);

      // 自动进行内容重建
      console.log(`🔧 [${taskId}] 开始重建内容...`);
      const contentResult = await this.reconstructContentForProcessedData(storeData);
      console.log(`✅ [${taskId}] 内容重建完成: 处理${contentResult.totalPads}个pad, 更新${contentResult.updatedVersions}个版本`);

      return {
        success: true,
        taskId,
        total: storeData.length,
        processed: processedCount,
        inserted: insertedCount,
        updated: updatedCount,
        errors: errorCount,
        contentRebuilt: contentResult.updatedVersions
      };

    } catch (error) {
      console.error(`❌ [${taskId}] 处理失败:`, error);
      return { success: false, error: error.message, taskId };
    }
  }

  // 全量处理 etherpad_pad_version 数据
  async processFullPadVersion() {
    const taskId = generateTaskId();
    console.log(`🚀 [${taskId}] 开始全量处理 etherpad_pad_version 数据...`);

    try {
      // 获取所有版本数据
      const storeData = await this.db.getAllStoreData();
      console.log(`📊 找到 ${storeData.length} 条store记录`);

      let processedCount = 0;
      let insertedCount = 0;
      let updatedCount = 0;
      let errorCount = 0;

      for (const row of storeData) {
        const result = await this.processRecord(row, false);
        
        if (result.success) {
          processedCount++;
          if (result.isUpdate) {
            updatedCount++;
          } else {
            insertedCount++;
          }
        } else {
          errorCount++;
        }

        // 显示进度
        if (processedCount % 500 === 0 && processedCount > 0) {
          console.log(`📈 已处理 ${processedCount}/${storeData.length} 条记录...`);
        }
      }

      console.log(`✅ [${taskId}] 基础处理完成!`);
      console.log(`📊 统计: 总计${storeData.length}, 成功${processedCount}, 新增${insertedCount}, 更新${updatedCount}, 错误${errorCount}`);

      // 自动进行内容重建
      console.log(`🔧 [${taskId}] 开始重建内容...`);
      const contentResult = await this.reconstructContentForProcessedData(storeData);
      console.log(`✅ [${taskId}] 内容重建完成: 处理${contentResult.totalPads}个pad, 更新${contentResult.updatedVersions}个版本`);

      return {
        success: true,
        taskId,
        total: storeData.length,
        processed: processedCount,
        inserted: insertedCount,
        updated: updatedCount,
        errors: errorCount,
        contentRebuilt: contentResult.updatedVersions
      };

    } catch (error) {
      console.error(`❌ [${taskId}] 处理失败:`, error);
      return { success: false, error: error.message, taskId };
    }
  }



  // 运行增量处理任务（替代原来的定时任务）
  async runIncrementalTask() {
    try {
      await this.connect();
      const result = await this.processIncrementalPadVersion();
      return result;
    } catch (error) {
      console.error('增量处理任务执行失败:', error);
      return { success: false, error: error.message };
    } finally {
      await this.disconnect();
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
        total: storeData.length,
        processed: successCount,
        new: newRecordCount,
        updated: updateRecordCount,
        failed: failureCount
      };

    } catch (error) {
      console.error('❌ Pad基础信息处理任务失败:', error);
      return { success: false, error: error.message };
    } finally {
      await this.disconnect();
    }
  }

  // 运行全量版本处理任务
  async runFullPadVersionTask() {
    try {
      await this.connect();
      const result = await this.processFullPadVersion();
      return result;
    } catch (error) {
      console.error('全量版本处理任务执行失败:', error);
      return { success: false, error: error.message };
    } finally {
      await this.disconnect();
    }
  }

  // 重建所有pad的内容 - 使用store数据
  async reconstructAllContent() {
    const taskId = generateTaskId();
    console.log(`🔄 [${taskId}] 开始重建所有pad内容...`);

    try {
      // 获取所有store记录
      const storeRecords = await this.db.getAllStoreData();
      console.log(`📊 找到 ${storeRecords.length} 个store记录`);

      // 解析并按pad分组
      const { grouped, errors: parseErrors } = parseAndGroupByPad(storeRecords);
      const padIds = Object.keys(grouped);
      console.log(`📊 解析出 ${padIds.length} 个pad`);

      if (parseErrors.length > 0) {
        console.log(`⚠️  解析错误: ${parseErrors.length} 个`);
      }

      let totalReconstructed = 0;
      let totalUpdated = 0;
      let errors = [];

      for (const padId of padIds) {
        try {
          const padData = grouped[padId];
          console.log(`🔧 重建 ${padId} 的内容 (${padData.revisions.length}个版本)...`);

          // 重建内容
          const contentReconstructor = new ContentReconstructor();
          const reconstructed = contentReconstructor.reconstructFromDBRecords(
            padData.revisions, 
            "" // 从空文档开始
          );
          
          // 准备批量更新和插入（包括版本0）
          const updates = [];
          const insertData = [];
          
          // 首先确保版本0存在
          const version0Exists = await this.db.checkRecordExists(padId, 0);
          if (!version0Exists && reconstructed.has(0)) {
            const version0Info = reconstructed.get(0);
            insertData.push({
              padId: padId,
              revision: 0,
              content: version0Info.content || '',
              author: 'system',
              timestamp: Date.now(),
              changeset: '',
              changeBehavior: 'add', // 初始状态视为添加
              changeContent: version0Info.content || '',
              changePosition: null
            });
            console.log(`📝 准备插入版本0: "${version0Info.content || ''}" (${(version0Info.content || '').length}字符)`);
          }
          
          for (const [revision, contentInfo] of reconstructed.entries()) {
            if (!contentInfo.error && contentInfo.content !== undefined) {
              // 版本0已经在上面处理了
              if (revision === 0 && !version0Exists) {
                continue;
              }
              
              // 检查记录是否已存在
              const exists = await this.db.checkRecordExists(padId, revision);
              
              if (exists) {
                // 已存在，准备更新内容
                updates.push({
                  padId: padId,
                  revision: revision,
                  content: contentInfo.content
                });
              } else if (revision > 0) {
                // 不存在，准备插入新记录（版本1及以上）
                const changeset = contentInfo.changeset || '';
                let changePosition = null;
                
                if (changeset) {
                  try {
                    // 获取前一个版本的内容作为基础文档
                    let baseDocument = '';
                    if (revision > 0) {
                      const prevVersion = revision - 1;
                      if (reconstructed.has(prevVersion) && !reconstructed.get(prevVersion).error) {
                        baseDocument = reconstructed.get(prevVersion).content || '';
                      }
                    }
                    
                    const analysis = analyzeChangesetContent(changeset, baseDocument);
                    changePosition = analysis.change_position || null;
                  } catch (error) {
                    console.warn(`⚠️  分析changeset失败 ${padId}:rev${revision}:`, error.message);
                    changePosition = null;
                  }
                }
                
                insertData.push({
                  padId: padId,
                  revision: revision,
                  content: contentInfo.content,
                  author: padData.revisions.find(r => r.revision === revision)?.author || 'unknown',
                  timestamp: padData.revisions.find(r => r.revision === revision)?.timestamp || Date.now(),
                  changeset: changeset,
                  changeBehavior: null, // 内容重建无法确定具体行为
                  changeContent: null, // 内容重建无法确定具体内容
                  changePosition: changePosition
                });
              }
            }
          }

          let operationCount = 0;
          
          // 执行批量更新
          if (updates.length > 0) {
            await this.db.updateContentBatch(updates);
            operationCount += updates.length;
          }
          
          // 执行批量插入（自动处理重复更新）
          if (insertData.length > 0) {
            for (const data of insertData) {
              await this.db.insertPadVersion(data);
            }
            operationCount += insertData.length;
          }

          if (operationCount > 0) {
            totalUpdated += operationCount;
            // 减少日志输出
          }

          totalReconstructed++;

        } catch (error) {
          console.error(`❌ 重建 ${padId} 失败:`, error.message);
          errors.push({
            padId: padId,
            error: error.message
          });
        }
      }

      console.log(`✅ [${taskId}] 内容重建完成!`);
      console.log(`📊 统计: 处理${totalReconstructed}个pad, 更新${totalUpdated}个版本, 错误${errors.length}个`);

      return {
        success: true,
        taskId,
        totalPads: padIds.length,
        reconstructedPads: totalReconstructed,
        updatedVersions: totalUpdated,
        errors
      };

    } catch (error) {
      console.error(`❌ [${taskId}] 内容重建失败:`, error);
      return { success: false, error: error.message, taskId };
    }
  }

  // 处理版本0记录的特殊方法
  async processVersion0Records(storeData) {
    console.log('🔧 专门处理版本0记录...');
    
    const version0Records = storeData.filter(record => record.key.endsWith(':revs:0'));
    let processed = 0;
    
    for (const record of version0Records) {
      try {
        // 解析pad信息
        const padMatch = record.key.match(/^pad:(room-\d+):revs:0$/);
        if (!padMatch) continue;
        
        const padId = padMatch[1];
        const storeValue = JSON.parse(record.value);
        
        // 构建changeset记录
        const changesetRecord = {
          revision: 0,
          changeset: storeValue.changeset,
          author: storeValue.meta.author,
          timestamp: storeValue.meta.timestamp
        };
        
        // 使用内容重建器处理版本0
        const contentReconstructor = new ContentReconstructor();
        const result = contentReconstructor.reconstructFromDBRecords([changesetRecord], '');
        
        if (result.has(0) && !result.get(0).error) {
          const version0Data = result.get(0);
          
          // 分析changeset以获取位置信息
          const analysis = analyzeChangesetContent(storeValue.changeset, '');
          const changePosition = analysis.change_position || null;
          
          // 检查数据库中是否已存在
          const exists = await this.db.checkRecordExists(padId, 0);
          
          if (exists) {
            const createTime = convertTimestampToBeijingTime(storeValue.meta.timestamp);

            // 更新现有记录
            await this.db.connection.execute(`
              UPDATE etherpad_pad_version 
              SET content = ?, changeset = ?, author = ?, timestamp = ?, 
                  change_behavior = ?, change_content = ?, change_position = ?, create_time = ?
              WHERE pad_id = ? AND revision = 0
            `, [
              version0Data.content, 
              storeValue.changeset,
              storeValue.meta.author,
              storeValue.meta.timestamp,
              analysis.change_behavior || 'add',
              analysis.change_content || version0Data.content,
              changePosition || null,
              createTime,
              padId
            ]);
            console.log(`✅ 已更新 ${padId} 的版本0记录 (${version0Data.content.length}字符) 位置: ${changePosition || '无'}`);
          } else {
            // 插入新记录
            await this.db.insertPadVersion({
              padId: padId,
              revision: 0,
              content: version0Data.content,
              author: storeValue.meta.author,
              timestamp: storeValue.meta.timestamp,
              changeset: storeValue.changeset,
              changeBehavior: analysis.change_behavior || 'add', // 版本0通常是添加
              changeContent: analysis.change_content || version0Data.content,
              changePosition: changePosition || null
            });
            console.log(`✅ 已插入 ${padId} 的版本0记录 (${version0Data.content.length}字符) 位置: ${changePosition || '无'}`);
          }
          processed++;
        }
      } catch (error) {
        console.error(`❌ 处理版本0记录失败 ${record.key}:`, error.message);
      }
    }
    
    console.log(`🎯 版本0处理完成: 处理了 ${processed} 个记录`);
    return processed;
  }

  // 为已处理的数据重建内容（基于store数据）
  async reconstructContentForProcessedData(storeData) {
    try {
      // 先处理版本0记录
      await this.processVersion0Records(storeData);
      
      // 解析并按pad分组
      const { grouped, errors: parseErrors } = parseAndGroupByPad(storeData);
      
      if (parseErrors.length > 0) {
        console.warn(`⚠️  解析过程中遇到 ${parseErrors.length} 个错误`);
      }
      
      const contentReconstructor = new ContentReconstructor();
      let totalPads = 0;
      let updatedVersions = 0;
      let operationCount = 0;
      
      for (const [padId, padData] of Object.entries(grouped)) {
        if (!padData || !padData.revisions || padData.revisions.length === 0) continue;
        
        totalPads++;
        const reconstructed = contentReconstructor.reconstructPadContent(padData);
        
        for (const [revision, contentInfo] of reconstructed.entries()) {
          if (contentInfo.error) {
            console.warn(`⚠️  重建内容失败 ${padId}:rev${revision}:`, contentInfo.error);
            continue;
          }
          
          const changeset = padData.revisions.find(r => r.revision === revision)?.changeset;
          const changesetRecord = padData.revisions.find(r => r.revision === revision);
          if (!changeset || !changesetRecord) continue;
          
                  try {
          const createTime = convertTimestampToBeijingTime(changesetRecord.timestamp);

            // 检查记录是否存在
            const exists = await this.db.checkRecordExists(padId, revision);
            
            if (exists) {
              // 获取现有记录，检查是否已有正确的changeset分析
              const [existingRows] = await this.db.connection.execute(`
                SELECT change_behavior, change_content, change_position
                FROM etherpad_pad_version 
                WHERE pad_id = ? AND revision = ?
              `, [padId, revision]);
              
              let shouldUpdateFields = false;
              let changeBehavior = null;
              let changeContent = null;
              let changePosition = null;
              
              if (existingRows.length > 0) {
                const existing = existingRows[0];
                // 强制更新changeset分析，确保使用正确的baseDocument
                shouldUpdateFields = true;
              }
              
              // 只有在需要更新时才进行changeset分析
              if (revision > 0 && shouldUpdateFields) {
                try {
                  // 获取前一个版本的内容作为基础文档
                  let baseDocument = '';
                  if (revision > 0) {
                    const prevVersion = revision - 1;
                    if (reconstructed.has(prevVersion) && !reconstructed.get(prevVersion).error) {
                      baseDocument = reconstructed.get(prevVersion).content || '';
                    }
                  }
                  
                  const analysis = analyzeChangesetContent(changeset, baseDocument);
                  
                  if (shouldUpdateFields) {
                    changeBehavior = analysis.change_behavior;
                    changeContent = analysis.change_content;
                    changePosition = analysis.change_position || null;
                  }
                } catch (analysisError) {
                  console.warn(`⚠️  分析changeset失败 ${padId}:rev${revision}:`, analysisError.message);
                }
              }
              
              // 构建更新SQL和参数
              const updateFields = ['content = ?'];
              const updateParams = [contentInfo.content];
              
              if (shouldUpdateFields) {
                if (changeBehavior !== null) {
                  updateFields.push('change_behavior = ?');
                  updateParams.push(changeBehavior);
              }
                if (changeContent !== null) {
                  updateFields.push('change_content = ?');
                  updateParams.push(changeContent);
                }
                if (changePosition !== null) {
                updateFields.push('change_position = ?');
                updateParams.push(changePosition);
                }
              }

              // 总是更新create_time字段
              if (createTime) {
                updateFields.push('create_time = ?');
                updateParams.push(createTime);
              }
              
              // 只有在有字段需要更新时才执行更新
              if (updateFields.length > 1) { // 大于1因为content总是会更新
                updateParams.push(padId, revision);
                await this.db.connection.execute(`
                  UPDATE etherpad_pad_version 
                  SET ${updateFields.join(', ')}
                  WHERE pad_id = ? AND revision = ?
                `, updateParams);
                
                updatedVersions++;
                operationCount++;
                
                if (operationCount % 1000 === 0) {
                  console.log(`📊 内容重建进度: ${operationCount} 个版本已更新`);
                }
              } else {
                // 只更新content和create_time
                const simpleUpdateFields = ['content = ?'];
                const simpleUpdateParams = [contentInfo.content];
                
                if (createTime) {
                  simpleUpdateFields.push('create_time = ?');
                  simpleUpdateParams.push(createTime);
                }
                
                simpleUpdateParams.push(padId, revision);
                
                await this.db.connection.execute(`
                  UPDATE etherpad_pad_version 
                  SET ${simpleUpdateFields.join(', ')}
                  WHERE pad_id = ? AND revision = ?
                `, simpleUpdateParams);
                
                updatedVersions++;
                operationCount++;
              }
            }
          } catch (error) {
            console.error(`❌ 更新失败 ${padId}:rev${revision}:`, error.message);
          }
        }
      }
      
      console.log(`🎯 内容重建完成: 处理了 ${totalPads} 个pad，更新了 ${updatedVersions} 个版本`);
      return { totalPads, updatedVersions };
      
    } catch (error) {
      console.error(`❌ 内容重建失败:`, error);
      throw error;
    }
  }

  // 重建特定pad的内容 - 使用store数据而不是数据库记录
  async reconstructPadContent(padId) {
    console.log(`🔧 重建 ${padId} 的内容...`);

    try {
      // 获取该pad的所有store记录
      const storeRecords = await this.db.getAllStoreData();
      
      // 筛选出该pad的记录
      const padRecords = storeRecords.filter(record => 
        record.key.includes(`pad:${padId}:revs:`)
      );
      
      if (padRecords.length === 0) {
        throw new Error(`Pad ${padId} 没有store记录`);
      }

      console.log(`📊 找到 ${padRecords.length} 个store记录`);

      // 解析store记录
      const { grouped } = parseAndGroupByPad(padRecords);
      const padData = grouped[padId];
      
      if (!padData) {
        throw new Error(`无法解析 ${padId} 的数据`);
      }

      console.log(`📊 解析出 ${padData.revisions.length} 个版本，版本范围: ${padData.revisions[0]?.revision} - ${padData.revisions[padData.revisions.length-1]?.revision}`);

      // 重建内容 - 确保从第一个版本开始
      const contentReconstructor = new ContentReconstructor();
      const reconstructed = contentReconstructor.reconstructFromDBRecords(
        padData.revisions, 
        "" // 从空文档开始
      );
      
      // 验证重建结果（如果需要的话，现在跳过验证）
      console.log(`📈 重建完成，处理了 ${reconstructed.size} 个版本`);

      // 显示内容示例
      console.log('\n📝 内容重建示例:');
      const sampleVersions = Array.from(reconstructed.entries()).slice(0, 3);
      sampleVersions.forEach(([revision, content]) => {
        console.log(`   版本 ${revision}:`);
        if (content.error) {
          console.log(`     ❌ 错误: ${content.error}`);
        } else {
          const preview = content.content.substring(0, 100).replace(/\n/g, '\\n');
          console.log(`     📄 内容: "${preview}${content.content.length > 100 ? '...' : ''}"`);
          console.log(`     📏 长度: ${content.length} 字符`);
        }
      });

      // 显示最后几个版本的内容
      console.log('\n📝 最后几个版本:');
      const lastVersions = Array.from(reconstructed.entries()).slice(-3);
      lastVersions.forEach(([revision, content]) => {
        console.log(`   版本 ${revision}:`);
        if (content.error) {
          console.log(`     ❌ 错误: ${content.error}`);
        } else {
          const preview = content.content.substring(0, 100).replace(/\n/g, '\\n');
          console.log(`     📄 内容: "${preview}${content.content.length > 100 ? '...' : ''}"`);
          console.log(`     📏 长度: ${content.length} 字符`);
        }
      });

      // 准备批量更新（包括版本0）
      const updates = [];
      const insertData = [];
      
      // 首先确保版本0存在
      const version0Exists = await this.db.checkRecordExists(padId, 0);
      if (!version0Exists && reconstructed.has(0)) {
        const version0Info = reconstructed.get(0);
        insertData.push({
          padId: padId,
          revision: 0,
          content: version0Info.content || '',
          author: 'system',
          timestamp: Date.now(),
          changeset: '',
          changeBehavior: 'add', // 初始状态视为添加
          changeContent: version0Info.content || '',
          changePosition: null
        });
        console.log(`📝 准备插入版本0: "${version0Info.content || ''}" (${(version0Info.content || '').length}字符)`);
      }
      
      for (const [revision, contentInfo] of reconstructed.entries()) {
        if (!contentInfo.error && contentInfo.content !== undefined) {
          // 版本0已经在上面处理了
          if (revision === 0 && !version0Exists) {
            continue;
          }
          
          // 检查记录是否已存在
          const exists = await this.db.checkRecordExists(padId, revision);
          
          if (exists) {
            // 已存在，准备更新内容
            updates.push({
              padId: padId,
              revision: revision,
              content: contentInfo.content
            });
          } else if (revision > 0) {
            // 不存在，准备插入新记录（版本1及以上）
            const changeset = contentInfo.changeset || '';
            let changePosition = null;
            
                                              if (changeset) {
              try {
                // 获取前一个版本的内容作为基础文档
                let baseDocument = '';
                if (revision > 0) {
                  const prevVersion = revision - 1;
                  if (reconstructed.has(prevVersion) && !reconstructed.get(prevVersion).error) {
                    baseDocument = reconstructed.get(prevVersion).content || '';
                  }
                }
                
                const analysis = analyzeChangesetContent(changeset, baseDocument);
                changePosition = analysis.change_position || null;
              } catch (error) {
                console.warn(`⚠️  分析changeset失败 ${padId}:rev${revision}:`, error.message);
                changePosition = null;
              }
            }
            
            insertData.push({
              padId: padId,
              revision: revision,
              content: contentInfo.content,
              author: padData.revisions.find(r => r.revision === revision)?.author || 'unknown',
              timestamp: padData.revisions.find(r => r.revision === revision)?.timestamp || Date.now(),
              changeset: changeset,
              changeBehavior: null, // 内容重建无法确定具体行为
              changeContent: null, // 内容重建无法确定具体内容
              changePosition: changePosition
            });
          }
        }
      }

      let operationCount = 0;
      
      // 执行批量更新
      if (updates.length > 0) {
        await this.db.updateContentBatch(updates);
        operationCount += updates.length;
        console.log(`✅ 更新了 ${updates.length} 个已存在版本的内容`);
      }
      
      // 执行批量插入（自动处理重复更新）
      if (insertData.length > 0) {
        for (const data of insertData) {
          await this.db.insertPadVersion(data);
        }
        operationCount += insertData.length;
        console.log(`✅ 插入了 ${insertData.length} 个新版本记录（包括版本0）`);
      }
      
      console.log(`✅ 总共处理 ${operationCount} 个版本的数据`)

      return {
        success: true,
        padId,
        totalVersions: padData.revisions.length,
        reconstructedVersions: reconstructed.size,
        updatedVersions: updates.length,
        validation,
        contentMap: reconstructed
      };

    } catch (error) {
      console.error(`❌ 重建 ${padId} 内容失败:`, error);
      return { success: false, padId, error: error.message };
    }
  }

  // 组合处理三张表：etherpad_pad_version(增量) + etherpad_author(全量) + etherpad_pad_info(全量)
  async processAllTables() {
    const taskId = generateTaskId();
    console.log(`🚀 [${taskId}] 开始组合处理三张表：etherpad_pad_version(增量) + etherpad_author(全量) + etherpad_pad_info(全量)...`);
    
    try {
      await this.connect();
      
      // 并行执行所有任务以提高效率
      console.log(`🔄 [${taskId}] 并行执行三个处理任务...`);
      
      const [padVersionResult, authorResult, padInfoResult] = await Promise.all([
        // 1. 增量处理 etherpad_pad_version（处理前一天数据）
        this.processIncrementalPadVersionInternal(),
        
        // 2. 全量处理 etherpad_author（重新同步所有作者）
        this.syncAuthorDataInternal(),
        
        // 3. 全量处理 etherpad_pad_info（重新提取所有pad信息）
        this.processPadInfoBatchInternal()
      ]);
      
      console.log(`✅ [${taskId}] 三张表组合处理完成!`);
      console.log(`📊 汇总统计:`);
      console.log(`   etherpad_pad_version(增量): 处理${padVersionResult.processed}条，重建${padVersionResult.contentRebuilt}个版本`);
      console.log(`   etherpad_author(全量): 处理${authorResult.processed}个作者`);
      console.log(`   etherpad_pad_info(全量): 处理${padInfoResult.processed}个pad`);
      
      return {
        success: true,
        taskId,
        padVersion: padVersionResult,
        author: authorResult,
        padInfo: padInfoResult
      };
      
    } catch (error) {
      console.error(`❌ [${taskId}] 三张表组合处理失败:`, error);
      return { success: false, error: error.message, taskId };
    } finally {
      await this.disconnect();
    }
  }

  // 内部方法：增量处理 etherpad_pad_version（不含连接管理）
  async processIncrementalPadVersionInternal(targetDate = null) {
    const processDate = targetDate || getYesterday();
    console.log(`📊 增量处理 etherpad_pad_version 数据 (${processDate.toLocaleDateString()})...`);

    try {
      // 计算时间范围
      const timeRange = calculateTimeRange(processDate);
      
      // 获取store数据
      const storeData = await this.db.getStoreData(timeRange.startTime, timeRange.endTime);
      console.log(`📊 获取到 ${storeData.length} 条版本记录`);

      if (storeData.length === 0) {
        return { success: true, processed: 0, inserted: 0, updated: 0, errors: 0, contentRebuilt: 0 };
      }

      let processedCount = 0;
      let insertedCount = 0;
      let updatedCount = 0;
      let errorCount = 0;

      // 处理数据
      for (const row of storeData) {
        const result = await this.processRecord(row, false);
        
        if (result.success) {
          processedCount++;
          if (result.isUpdate) {
            updatedCount++;
          } else {
            insertedCount++;
          }
        } else {
          errorCount++;
        }

        // 显示进度
        if (processedCount % 500 === 0 && processedCount > 0) {
          console.log(`📈 版本处理进度: ${processedCount}/${storeData.length}`);
        }
      }

      // 自动进行内容重建
      console.log(`🔧 开始重建版本内容...`);
      const contentResult = await this.reconstructContentForProcessedData(storeData);

      return {
        success: true,
        total: storeData.length,
        processed: processedCount,
        inserted: insertedCount,
        updated: updatedCount,
        errors: errorCount,
        contentRebuilt: contentResult.updatedVersions
      };

    } catch (error) {
      console.error(`❌ 增量处理版本数据失败:`, error);
      throw error;
    }
  }

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

  // 内部方法：全量处理 etherpad_author（不含连接管理）
  async syncAuthorDataInternal() {
    console.log(`👥 全量处理 etherpad_author 数据...`);
    return await this._syncAuthorDataCore();
  }

  // 内部方法：全量处理 etherpad_pad_info（不含连接管理）
  async processPadInfoBatchInternal() {
    console.log(`📝 全量处理 etherpad_pad_info 数据...`);

    try {
      // 获取所有pad基础数据
      const storeData = await this.db.getAllPadData();
      console.log(`📊 找到 ${storeData.length} 条pad基础记录`);

      if (storeData.length === 0) {
        return { success: true, processed: 0, new: 0, updated: 0 };
      }

      let successCount = 0;
      let failureCount = 0;
      let newRecordCount = 0;
      let updateRecordCount = 0;

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

      return {
        success: true,
        total: storeData.length,
        processed: successCount,
        new: newRecordCount,
        updated: updateRecordCount,
        failed: failureCount
      };

    } catch (error) {
      console.error(`❌ 全量处理pad信息失败:`, error);
      throw error;
    }
  }

  // 批量处理 pad_info （为组合命令使用）
  async processPadInfoBatch() {
    const taskId = generateTaskId();
    console.log(`📝 [${taskId}] 开始批量处理 etherpad_pad_info...`);

    try {
      // 获取所有pad基础数据
      const storeData = await this.db.getAllPadData();
      console.log(`📊 找到 ${storeData.length} 条pad基础记录`);

      if (storeData.length === 0) {
        return { success: true, processed: 0, new: 0, updated: 0 };
      }

      let successCount = 0;
      let failureCount = 0;
      let newRecordCount = 0;
      let updateRecordCount = 0;

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
      }

      console.log(`✅ [${taskId}] Pad基础信息处理完成: 成功${successCount}, 新增${newRecordCount}, 更新${updateRecordCount}, 失败${failureCount}`);

      return {
        success: true,
        total: storeData.length,
        processed: successCount,
        new: newRecordCount,
        updated: updateRecordCount,
        failed: failureCount
      };

    } catch (error) {
      console.error(`❌ [${taskId}] 批量处理失败:`, error);
      throw error;
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

  if (args.includes('--process-incremental-etherpad_pad_version')) {
    // 增量处理 etherpad_pad_version
    console.log(`📊 [${new Date().toISOString()}] 开始执行 etherpad_pad_version 增量处理任务`);
    const result = await processor.runIncrementalTask();
    
    if (result.success) {
      console.log(`✅ [${new Date().toISOString()}] etherpad_pad_version 增量处理完成`);
      console.log(`📊 处理统计: 总数${result.total}, 成功${result.processed}, 新增${result.inserted}, 更新${result.updated}, 错误${result.errors}`);
    } else {
      console.log(`❌ [${new Date().toISOString()}] etherpad_pad_version 增量处理失败: ${result.error}`);
      process.exit(1);
    }

  } else if (args.includes('--process-full-etherpad_pad_version')) {
    // 全量处理 etherpad_pad_version
    console.log(`🚀 [${new Date().toISOString()}] 开始执行 etherpad_pad_version 全量处理任务`);
    const result = await processor.runFullPadVersionTask();
    
    if (result.success) {
      console.log(`✅ [${new Date().toISOString()}] etherpad_pad_version 全量处理完成`);
      console.log(`📊 处理统计: 总数${result.total}, 成功${result.processed}, 新增${result.inserted}, 更新${result.updated}, 错误${result.errors}`);
    } else {
      console.log(`❌ [${new Date().toISOString()}] etherpad_pad_version 全量处理失败: ${result.error}`);
      process.exit(1);
    }

  } else if (args.includes('--process-etherpad_author')) {
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

  } else if (args.includes('--process-all-tables')) {
    // 组合处理三张表：etherpad_pad_version(增量) + etherpad_author(全量) + etherpad_pad_info(全量)
    console.log(`🚀 [${new Date().toISOString()}] 开始执行三张表组合处理任务`);
    const result = await processor.processAllTables();
    
    if (result.success) {
      console.log(`✅ [${new Date().toISOString()}] 三张表组合处理完成`);
      console.log(`📊 汇总统计:`);
      console.log(`   etherpad_pad_version(增量): 处理${result.padVersion.processed}条，重建${result.padVersion.contentRebuilt}个版本`);
      console.log(`   etherpad_author(全量): 处理${result.author.processed}个作者`);
      console.log(`   etherpad_pad_info(全量): 处理${result.padInfo.processed}个pad`);
    } else {
      console.log(`❌ [${new Date().toISOString()}] 三张表组合处理失败: ${result.error}`);
      process.exit(1);
    }

  } else if (args.includes('--test')) {
    // 测试运行（增量处理昨天的数据）
    console.log(`🧪 [${new Date().toISOString()}] 开始执行测试任务`);
    const result = await processor.runIncrementalTask();
    
    console.log('🔍 测试结果:', result);

  } else {
    // 显示帮助信息
    console.log('🚀 Etherpad数据处理器');
    console.log('═'.repeat(50));
    console.log('使用方法:');
    console.log('  node etherpad-processor.js --process-incremental-etherpad_pad_version  # 增量处理 etherpad_pad_version');
    console.log('  node etherpad-processor.js --process-full-etherpad_pad_version         # 全量处理 etherpad_pad_version');
    console.log('  node etherpad-processor.js --process-etherpad_author                   # 全量处理 etherpad_author');
    console.log('  node etherpad-processor.js --process-etherpad_pad_info                 # 全量处理 etherpad_pad_info');
    console.log('  node etherpad-processor.js --process-all-tables                       # 全量处理三张表组合');
    console.log('  node etherpad-processor.js --test                                     # 测试运行');
    console.log('');
    console.log('功能说明:');
    console.log('  --process-incremental-etherpad_pad_version: 增量处理前一天的版本数据，包含changeset分析和内容重建');
    console.log('  --process-full-etherpad_pad_version: 全量处理所有版本数据，包含changeset分析和内容重建');
    console.log('  --process-etherpad_author: 全量处理作者数据，清空并重新同步所有作者信息');
    console.log('  --process-etherpad_pad_info: 全量处理pad基础信息，提取atext、pool等数据');
    console.log('  --process-all-tables: 组合命令，并行执行：版本增量处理+作者全量处理+pad信息全量处理');
    console.log('  --test: 测试模式，执行增量处理并显示详细结果');
    console.log('');
    console.log('数据表说明:');
    console.log('  etherpad_pad_version: 存储pad的版本历史和变更记录');
    console.log('  etherpad_author: 存储作者信息和颜色配置');
    console.log('  etherpad_pad_info: 存储pad的基础信息和当前状态');
    console.log('');
    console.log('组合命令详情:');
    console.log('  --process-all-tables 同时执行:');
    console.log('    ├─ etherpad_pad_version: 增量处理（前一天数据）');
    console.log('    ├─ etherpad_author: 全量处理（重新同步所有作者）');
    console.log('    └─ etherpad_pad_info: 全量处理（重新提取所有pad信息）');
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