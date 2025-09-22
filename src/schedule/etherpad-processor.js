/**
 * Etherpad数据处理器
 * 合并了定时任务处理和数据格式更新功能
 */

const mysql = require('mysql2/promise');
const Database = require('./utils/database.js');
const { parseAndGroupByPad, formatParseReport } = require('./utils/json-parser.js');
const { analyzeChangesetContent, ContentReconstructor, extractPadInfo } = require('./utils/parser.js');
const { calculateTimeRange, getYesterday, formatTime, generateTaskId } = require('./utils/scheduler');

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
        // 如果记录已存在，只更新content字段（如果为空），保留原有的change_description和change_position
        const existingData = await this.db.getPadVersionRecord(padInfo.padId, padInfo.revision);
        
        insertData = {
          padId: padInfo.padId,
          revision: padInfo.revision,
          content: existingData.content || null, // 保持原有content，稍后可能会被重建
          author: existingData.author,
          timestamp: existingData.timestamp,
          changeset: existingData.changeset,
          userName: existingData.userName,
          changeDescription: existingData.changeDescription, // 保留原有描述
          changePosition: existingData.changePosition // 保留原有位置
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
          userName: null,
          changeDescription: analysis.change_description || analysis.summary,
          changePosition: analysis.change_position || null
        };
      }

      await this.db.insertPadVersion(insertData);

      if (showDetails) {
        console.log(`📝 ${existingRecord ? '更新' : '新增'}: ${padInfo.padId}:rev${padInfo.revision}`);
        if (!existingRecord) {
          console.log(`   变更: ${insertData.changeDescription}`);
          console.log(`   位置: ${insertData.changePosition || '无'}`);
        }
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

  // 定时任务：处理指定日期的数据
  async processDayData(targetDate) {
    const taskId = generateTaskId();
    console.log(`🚀 [${taskId}] 开始处理 ${targetDate.toLocaleDateString()} 的数据...`);

    try {
      // 计算时间范围
      const timeRange = calculateTimeRange(targetDate);
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
        const result = await this.processRecord(row, processedCount < 5);
        
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
        if (processedCount % 10 === 0 && processedCount > 0) {
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

  // 处理所有现有数据
  async processAllData() {
    const taskId = generateTaskId();
    console.log(`🚀 [${taskId}] 开始处理所有现有数据...`);

    try {
      // 获取所有store数据
      const storeData = await this.db.getAllStoreData();
      console.log(`📊 找到 ${storeData.length} 条store记录`);

      let processedCount = 0;
      let insertedCount = 0;
      let updatedCount = 0;
      let errorCount = 0;

      for (const row of storeData) {
        const result = await this.processRecord(row, processedCount < 5);
        
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
        if (processedCount % 10 === 0 && processedCount > 0) {
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



  // 运行定时任务
  async runScheduledTask() {
    try {
      await this.connect();
      
      // 处理前一天的数据
      const yesterday = getYesterday();
      const result = await this.processDayData(yesterday);
      
      return result;

    } catch (error) {
      console.error('定时任务执行失败:', error);
      return { success: false, error: error.message };
    } finally {
      await this.disconnect();
    }
  }



  // 运行全量数据处理任务
  async runFullProcessTask() {
    try {
      await this.connect();
      const result = await this.processAllData();
      return result;

    } catch (error) {
      console.error('全量数据处理任务执行失败:', error);
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
              userName: 'system',
              changeDescription: '初始文档状态',
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
                  userName: null,
                  changeDescription: '内容重建',
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
            console.log(`✅ ${padId}: 更新${updates.length}个+插入${insertData.length}个 = 总计${operationCount}个版本`);
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
            // 更新现有记录
            await this.db.connection.execute(`
              UPDATE etherpad_pad_version 
              SET content = ?, changeset = ?, author = ?, timestamp = ?, 
                  change_description = ?, change_position = ?
              WHERE pad_id = ? AND revision = 0
            `, [
              version0Data.content, 
              storeValue.changeset,
              storeValue.meta.author,
              storeValue.meta.timestamp,
              analysis.summary || '版本0初始内容',
              changePosition || null,
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
              userName: null,
              changeDescription: analysis.summary || '版本0初始内容',
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
          if (!changeset) continue;
          
          try {
            // 检查记录是否存在
            const exists = await this.db.checkRecordExists(padId, revision);
            
            if (exists) {
              // 获取现有记录，检查是否已有正确的changeset分析
              const [existingRows] = await this.db.connection.execute(`
                SELECT change_description, change_position 
                FROM etherpad_pad_version 
                WHERE pad_id = ? AND revision = ?
              `, [padId, revision]);
              
              let shouldUpdateDescription = false;
              let shouldUpdatePosition = false;
              let changeDescription = null;
              let changePosition = null;
              
              if (existingRows.length > 0) {
                const existing = existingRows[0];
                // 只有当现有数据为空、null或默认值时才更新
                shouldUpdateDescription = !existing.change_description || 
                                        existing.change_description === '内容重建' ||
                                        existing.change_description === 'null' ||
                                        existing.change_description.trim() === '';
                                        
                shouldUpdatePosition = !existing.change_position || 
                                     existing.change_position === 'null';
              }
              
              // 只有在需要更新时才进行changeset分析
              if (revision > 0 && (shouldUpdateDescription || shouldUpdatePosition)) {
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
                  
                  if (shouldUpdateDescription) {
                    changeDescription = analysis.change_description || analysis.summary || null;
                  }
                  if (shouldUpdatePosition) {
                    changePosition = analysis.change_position || null;
                  }
                } catch (analysisError) {
                  console.warn(`⚠️  分析changeset失败 ${padId}:rev${revision}:`, analysisError.message);
                }
              }
              
              // 构建更新SQL和参数
              const updateFields = ['content = ?'];
              const updateParams = [contentInfo.content];
              
              if (shouldUpdateDescription && changeDescription !== null) {
                updateFields.push('change_description = ?');
                updateParams.push(changeDescription);
              }
              
              if (shouldUpdatePosition && changePosition !== null) {
                updateFields.push('change_position = ?');
                updateParams.push(changePosition);
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
                
                if (operationCount % 100 === 0) {
                  console.log(`📊 内容重建进度: ${operationCount} 个版本已更新`);
                }
              } else {
                // 只更新content
                await this.db.connection.execute(`
                  UPDATE etherpad_pad_version 
                  SET content = ?
                  WHERE pad_id = ? AND revision = ?
                `, [contentInfo.content, padId, revision]);
                
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
          userName: 'system',
          changeDescription: '初始文档状态',
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
              userName: null,
              changeDescription: '内容重建',
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

  // 运行内容重建任务
  async runContentReconstructionTask() {
    try {
      await this.connect();
      const result = await this.reconstructAllContent();
      return result;

    } catch (error) {
      console.error('内容重建任务执行失败:', error);
      return { success: false, error: error.message };
    } finally {
      await this.disconnect();
    }
  }
}

// 命令行入口
async function main() {
  const args = process.argv.slice(2);
  const processor = new EtherpadProcessor();

  if (args.includes('--scheduled') || args.includes('--run')) {
    // 运行定时任务
    console.log(`🕐 [${new Date().toISOString()}] 开始执行定时数据处理任务`);
    const result = await processor.runScheduledTask();
    
    if (result.success) {
      console.log(`✅ [${new Date().toISOString()}] 定时任务完成`);
    } else {
      console.log(`❌ [${new Date().toISOString()}] 定时任务失败: ${result.error}`);
      process.exit(1);
    }

  } else if (args.includes('--process-all')) {
    // 处理所有现有数据
    console.log(`🚀 [${new Date().toISOString()}] 开始执行全量数据处理任务`);
    const result = await processor.runFullProcessTask();
    
    if (result.success) {
      console.log(`✅ [${new Date().toISOString()}] 全量数据处理完成`);
    } else {
      console.log(`❌ [${new Date().toISOString()}] 全量数据处理失败: ${result.error}`);
      process.exit(1);
    }

  } else if (args.includes('--test')) {
    // 测试运行（处理昨天的数据）
    console.log(`🧪 [${new Date().toISOString()}] 开始执行测试任务`);
    const result = await processor.runScheduledTask();
    
    console.log('🔍 测试结果:', result);

  } else {
    // 显示帮助信息
    console.log('🚀 Etherpad数据处理器');
    console.log('═'.repeat(50));
    console.log('使用方法:');
    console.log('  node etherpad-processor.js --run         # 运行定时任务');
    console.log('  node etherpad-processor.js --scheduled   # 运行定时任务');
    console.log('  node etherpad-processor.js --process-all # 处理所有现有数据');
    console.log('  node etherpad-processor.js --test        # 测试运行');
    console.log('');
    console.log('功能说明:');
    console.log('  --run/--scheduled: 处理前一天整天(00:00-23:59)的数据，包含changeset分析和内容重建');
    console.log('  --process-all: 处理store表中所有pad数据，包含changeset分析和内容重建');
    console.log('  --test: 测试模式，显示详细结果');
    console.log('');
    console.log('注意: 所有处理流程都会自动进行内容重建，无需单独执行');
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