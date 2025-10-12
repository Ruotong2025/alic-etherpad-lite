/**
 * 数据库连接和操作工具
 */

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { convertTimestampToBeijingTime } = require('./timeConverter.js');

// 读取settings.json配置  
function loadDatabaseConfig() {
  try {
    // 动态读取settings.json文件
    const settingsPath = path.join(__dirname, '../../../../settings.json');
    
    if (!fs.existsSync(settingsPath)) {
      throw new Error('settings.json文件不存在');
    }
    
    console.log('📖 读取settings.json配置文件');
    const settingsContent = fs.readFileSync(settingsPath, 'utf8');
    
    console.log('📝 处理JSON注释和格式问题...');
    // 更严格的注释移除和格式清理
    let cleanedContent = settingsContent
      // 移除多行注释 /* ... */
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // 移除单行注释 // ... 但不包括URL中的//
      .replace(/(?<!")\/\/.*$/gm, '')
      // 移除多余的空白行
      .replace(/^\s*[\r\n]/gm, '')
      // 移除控制字符
      .replace(/[\x00-\x1F\x7F]/g, '')
      // 清理空白
      .trim();
    
    // 验证JSON结构
    if (!cleanedContent.startsWith('{')) {
      throw new Error('settings.json格式错误：文件应该以 { 开头');
    }
    if (!cleanedContent.endsWith('}')) {
      throw new Error('settings.json格式错误：文件应该以 } 结尾');
    }
    
    console.log('🔍 尝试解析JSON...');
    const settings = JSON.parse(cleanedContent);
    
    // 验证数据库配置
    if (!settings.dbSettings) {
      throw new Error('settings.json中缺少dbSettings配置');
    }
    
    const dbSettings = settings.dbSettings;
    
    // 验证必要的数据库配置字段
    const requiredFields = ['user', 'host', 'port', 'password', 'database'];
    const missingFields = requiredFields.filter(field => !dbSettings[field]);
    
    if (missingFields.length > 0) {
      throw new Error(`settings.json中缺少必要的数据库配置字段: ${missingFields.join(', ')}`);
    }
    
    const configFromSettings = {
      user: dbSettings.user,
      host: dbSettings.host,
      port: dbSettings.port,
      password: dbSettings.password,
      database: dbSettings.database,
      charset: dbSettings.charset || "utf8mb4",
      ssl: dbSettings.ssl || false
    };
    
    console.log('✅ 成功读取settings.json中的数据库配置');
    console.log(`📊 数据库配置: ${configFromSettings.user}@${configFromSettings.host}:${configFromSettings.port}/${configFromSettings.database}`);
    
    return configFromSettings;
    
  } catch (error) {
    console.error('❌ 读取settings.json配置失败:', error.message);
    console.warn('⚠️  使用备用数据库配置');
    
    // 备用配置（从您之前提供的信息中获取）
    const fallbackConfig = {
      user: "root",
      host: "112.74.92.135",
      port: 3306,
      password: "1q2w3e4R",
      database: "alic",
      charset: "utf8mb4",
      ssl: false
    };
    
    console.log('✅ 使用备用数据库配置');
    console.log(`📊 数据库配置: ${fallbackConfig.user}@${fallbackConfig.host}:${fallbackConfig.port}/${fallbackConfig.database}`);
    
    return fallbackConfig;
  }
}

class DatabaseManager {
  constructor() {
    this.connection = null;
    this.dbConfig = null;
  }

  // 重新加载数据库配置
  reloadConfig() {
    this.dbConfig = loadDatabaseConfig();
    return this.dbConfig;
  }

  // 获取当前数据库配置
  getConfig() {
    if (!this.dbConfig) {
      this.dbConfig = loadDatabaseConfig();
    }
    return this.dbConfig;
  }

  async connect() {
    try {
      // 每次连接时都重新加载配置，确保使用最新的settings.json
      const config = this.reloadConfig();
      console.log(`📡 连接数据库: ${config.user}@${config.host}:${config.port}/${config.database}`);
      this.connection = await mysql.createConnection(config);
      // 数据库连接成功
    } catch (error) {
      console.error('❌ 数据库连接失败:', error);
      console.error('💡 请检查settings.json中的数据库配置');
      throw error;
    }
  }

  async disconnect() {
    if (this.connection) {
      await this.connection.end();
      // 数据库连接已关闭
    }
  }

  // 获取指定时间范围内的store数据
  async getStoreData(startTime, endTime) {
    const query = `
      SELECT \`key\`, \`value\` 
      FROM store 
      WHERE \`key\` LIKE 'pad:room-%:revs:%'
      AND JSON_EXTRACT(\`value\`, '$.meta.timestamp') BETWEEN ? AND ?
      ORDER BY \`key\`
    `;
    
    const [rows] = await this.connection.execute(query, [startTime, endTime]);
    return rows;
  }

  // 获取所有pad数据
  async getAllStoreData() {
    const query = `
      SELECT \`key\`, \`value\` 
      FROM store 
      WHERE \`key\` LIKE 'pad:room-%:revs:%'
      ORDER BY \`key\`
    `;
    
    const [rows] = await this.connection.execute(query);
    return rows;
  }

  // 获取所有 globalAuthor 数据
  async getGlobalAuthorData() {
    const query = `
      SELECT \`key\`, \`value\` 
      FROM store 
      WHERE \`key\` LIKE 'globalAuthor:%'
      ORDER BY \`key\`
    `;
    
    const [rows] = await this.connection.execute(query);
    return rows;
  }

  // 获取所有 pad 基础信息数据（不包括版本数据）
  async getAllPadData() {
    const query = `
      SELECT \`key\`, \`value\` 
      FROM store 
      WHERE \`key\` LIKE 'pad:room-%' 
        AND \`key\` NOT LIKE 'pad:room-%:revs:%'
        AND \`key\` NOT LIKE 'pad:room-%:chat:%'
      ORDER BY \`key\`
    `;
    
    const [rows] = await this.connection.execute(query);
    return rows;
  }

  // 插入或更新pad基础信息
  async insertPadInfo(data) {
    try {
      const query = `
        INSERT INTO etherpad_pad_info 
        (pad_id, full_text, attribs, pool, next_num, head, chat_head, public_status, saved_revisions, create_time, update_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE
          full_text = VALUES(full_text),
          attribs = VALUES(attribs),
          pool = VALUES(pool),
          next_num = VALUES(next_num),
          head = VALUES(head),
          chat_head = VALUES(chat_head),
          public_status = VALUES(public_status),
          saved_revisions = VALUES(saved_revisions),
          update_time = NOW()
      `;
      
      await this.connection.execute(query, [
        data.padId,
        data.fullText || null,
        data.attribs || null,
        data.pool ? JSON.stringify(data.pool) : null,
        data.nextNum || null,
        data.head || null,
        data.chatHead || null,
        data.publicStatus !== undefined ? data.publicStatus : null,
        data.savedRevisions ? JSON.stringify(data.savedRevisions) : null
      ]);
      
      return { success: true };
    } catch (error) {
      console.error('❌ 插入pad基础信息失败:', error);
      throw error;
    }
  }

  // 检查pad基础信息是否存在
  async checkPadInfoExists(padId) {
    try {
      const query = `SELECT COUNT(*) as count FROM etherpad_pad_info WHERE pad_id = ?`;
      const [rows] = await this.connection.execute(query, [padId]);
      return rows[0].count > 0;
    } catch (error) {
      console.error('❌ 检查pad基础信息失败:', error);
      throw error;
    }
  }

  // 获取pad基础信息记录
  async getPadInfo(padId) {
    try {
      const query = `
        SELECT pad_id, full_text, attribs, pool, next_num, head, chat_head, 
               public_status, saved_revisions, create_time, update_time
        FROM etherpad_pad_info 
        WHERE pad_id = ? 
        LIMIT 1
      `;
      const [rows] = await this.connection.execute(query, [padId]);
      if (rows.length === 0) {
        return null;
      }
      const row = rows[0];
      return {
        padId: row.pad_id,
        fullText: row.full_text,
        attribs: row.attribs,
        pool: row.pool ? JSON.parse(row.pool) : null,
        nextNum: row.next_num,
        head: row.head,
        chatHead: row.chat_head,
        publicStatus: row.public_status,
        savedRevisions: row.saved_revisions ? JSON.parse(row.saved_revisions) : null,
        createTime: row.create_time,
        updateTime: row.update_time
      };
    } catch (error) {
      console.error('❌ 获取pad基础信息失败:', error);
      throw error;
    }
  }

  // 插入或更新pad版本数据
  async insertPadVersion(data) {
    try {
      const createTime = convertTimestampToBeijingTime(data.timestamp);

      // 先尝试包含新字段结构的插入
      const queryWithNewFields = `
        INSERT INTO etherpad_pad_version 
        (pad_id, revision, content, change_behavior, change_content, change_position, author, timestamp, changeset, create_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          content = VALUES(content),
          change_behavior = VALUES(change_behavior),
          change_content = VALUES(change_content),
          change_position = VALUES(change_position),
          author = VALUES(author),
          timestamp = VALUES(timestamp),
          changeset = VALUES(changeset),
          create_time = VALUES(create_time)
      `;
      
      await this.connection.execute(queryWithNewFields, [
        data.padId,
        data.revision,
        data.content || null,
        data.changeBehavior || null,
        data.changeContent || null,
        data.changePosition || null,
        data.author,
        data.timestamp,
        data.changeset,
        createTime
      ]);
    } catch (error) {
        throw error;
    }
  }

  // 更新pad版本数据
  async updatePadVersion(padId, revision, data) {
    try {
      const updateQuery = `
        UPDATE etherpad_pad_version 
        SET content = ?, author = ?, timestamp = ?, changeset = ?, 
            change_description = ?, change_position = ?
        WHERE pad_id = ? AND revision = ?
      `;
      
      await this.connection.execute(updateQuery, [
        data.content || null,
        data.author,
        data.timestamp,
        data.changeset,
        data.changeDescription,
        data.changePosition || null,
        padId,
        revision
      ]);
    } catch (error) {
      console.error('❌ 更新pad版本失败:', error);
      throw error;
    }
  }

  // 只更新content字段
  async updateContentOnly(padId, revision, content) {
    const query = `
      UPDATE etherpad_pad_version 
      SET content = ?
      WHERE pad_id = ? AND revision = ?
    `;
    
    await this.connection.execute(query, [content, padId, revision]);
  }

  // 获取pad的历史内容
  async getPadContent(padId, beforeRevision) {
    const query = `
      SELECT content, changeset 
      FROM etherpad_pad_version 
      WHERE pad_id = ? AND revision < ? 
      ORDER BY revision DESC 
      LIMIT 1
    `;
    
    const [rows] = await this.connection.execute(query, [padId, beforeRevision]);
    return rows.length > 0 ? rows[0] : null;
  }



  // 检查记录是否存在
  async checkRecordExists(padId, revision) {
    const query = 'SELECT id FROM etherpad_pad_version WHERE pad_id = ? AND revision = ?';
    const [rows] = await this.connection.execute(query, [padId, revision]);
    return rows.length > 0;
  }

  // 获取特定的pad版本记录
  async getPadVersionRecord(padId, revision) {
    try {
      const query = `
        SELECT pad_id, revision, content, change_behavior, change_content, change_position,
               author, timestamp, changeset
        FROM etherpad_pad_version 
        WHERE pad_id = ? AND revision = ? 
        LIMIT 1
      `;
      
      const [rows] = await this.connection.execute(query, [padId, revision]);
      if (rows.length === 0) {
        return null;
      }
      
      const row = rows[0];
      return {
        padId: row.pad_id,
        revision: row.revision,
        content: row.content,
        change_behavior: row.change_behavior,
        change_content: row.change_content,
        change_position: row.change_position || null,
        author: row.author,
        timestamp: row.timestamp,
        changeset: row.changeset
      };
    } catch (error) {
      console.error('❌ 获取pad版本记录失败:', error);
      throw error;
    }
  }

  // 获取特定pad的所有版本记录（用于内容重建）
  async getPadAllRevisions(padId) {
    const query = `
      SELECT pad_id, revision, changeset, author, timestamp, content
      FROM etherpad_pad_version 
      WHERE pad_id = ? 
      ORDER BY revision ASC
    `;
    
    const [rows] = await this.connection.execute(query, [padId]);
    return rows;
  }

  // 批量更新内容字段
  async updateContentBatch(updates) {
    const query = `
      UPDATE etherpad_pad_version 
      SET content = ? 
      WHERE pad_id = ? AND revision = ?
    `;
    
    for (const update of updates) {
      await this.connection.execute(query, [update.content, update.padId, update.revision]);
    }
    
    return updates.length;
  }

  // 获取需要重建内容的记录
  async getRecordsNeedingContent() {
    const query = `
      SELECT pad_id, COUNT(*) as count
      FROM etherpad_pad_version 
      WHERE content IS NULL OR content = ''
      GROUP BY pad_id
      ORDER BY count DESC
    `;
    
    const [rows] = await this.connection.execute(query);
    return rows;
  }

  // 验证数据库表结构
  async validateTableSchema() {
    try {
      const query = `
        SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'etherpad_pad_version'
        ORDER BY ORDINAL_POSITION
      `;
      
      const [rows] = await this.connection.execute(query);
      const columns = rows.map(row => row.COLUMN_NAME);
      
      console.log('📊 当前表结构字段:', columns.join(', '));
      
      // 检查必要字段
      const requiredFields = ['change_position'];
      const missingFields = requiredFields.filter(field => !columns.includes(field));
      
      if (missingFields.length > 0) {
        console.warn('⚠️  表结构缺少字段:', missingFields.join(', '));
        return { valid: false, missingFields };
      }
      
      console.log('✅ 表结构验证通过');
      return { valid: true, missingFields: [] };
    } catch (error) {
      console.error('❌ 表结构验证失败:', error);
      return { valid: false, error: error.message };
    }
  }

  // 添加缺失的字段
  async addMissingFields() {
    try {
      const schema = await this.validateTableSchema();
      if (!schema.valid && schema.missingFields) {
        for (const field of schema.missingFields) {
          if (field === 'change_position') {
            const alterQuery = `
              ALTER TABLE etherpad_pad_version 
              ADD COLUMN change_position varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci 
              NULL DEFAULT NULL COMMENT '变更位置(如: 第3行第5个词)' 
              AFTER change_description
            `;
            
            await this.connection.execute(alterQuery);
            console.log('✅ 已添加 change_position 字段');
          }
        }
      }
    } catch (error) {
      console.error('❌ 添加字段失败:', error);
      throw error;
    }
  }

  // 检查版本0是否存在，不存在则创建
  async ensureVersion0Exists(padId) {
    try {
      const version0Exists = await this.checkRecordExists(padId, 0);
      
      if (!version0Exists) {
        // 创建版本0记录
        
        // 创建版本0记录
        const version0Data = {
          padId: padId,
          revision: 0,
          content: '', // 版本0通常是空内容
          author: 'system',
          timestamp: Date.now(),
          changeset: '', // 版本0没有changeset
          changeBehavior: 'add', // 初始状态视为添加
          changeContent: '',
          changePosition: null
        };
        
        await this.insertPadVersion(version0Data);
        // 已创建版本0记录
        return true;
      }
      
      return false; // 已存在
    } catch (error) {
      console.error(`❌ 创建版本0失败 (${padId}):`, error);
      throw error;
    }
  }

  // 获取pad的最小版本号
  async getPadMinRevision(padId) {
    const query = `
      SELECT MIN(revision) as min_revision
      FROM etherpad_pad_version 
      WHERE pad_id = ?
    `;
    
    const [rows] = await this.connection.execute(query, [padId]);
    return rows.length > 0 ? rows[0].min_revision : null;
  }

  // 批量确保版本0存在
  async ensureAllVersion0Exist() {
    try {
      // 获取所有不同的pad_id
      const query = `
        SELECT DISTINCT pad_id, MIN(revision) as min_revision
        FROM etherpad_pad_version 
        GROUP BY pad_id
        HAVING MIN(revision) > 0
      `;
      
      const [rows] = await this.connection.execute(query);
      
      console.log(`📊 发现 ${rows.length} 个pad缺少版本0`);
      
      let createdCount = 0;
      for (const row of rows) {
        const created = await this.ensureVersion0Exists(row.pad_id);
        if (created) {
          createdCount++;
        }
      }
      
      console.log(`✅ 创建了 ${createdCount} 个版本0记录`);
      return createdCount;
    } catch (error) {
      console.error('❌ 批量创建版本0失败:', error);
      throw error;
    }
  }

  // 清空 etherpad_author 表
  async clearAuthorTable() {
    try {
      const query = 'DELETE FROM etherpad_author';
      await this.connection.execute(query);
      // etherpad_author 表已清空
    } catch (error) {
      console.error('❌ 清空 etherpad_author 表失败:', error);
      throw error;
    }
  }

  // 插入作者数据到 etherpad_author 表
  async insertAuthorData(authorData) {
    try {
      const query = `
        INSERT INTO etherpad_author 
        (author_id, author_name, color_id, timestamp, created_time, padIDs)
        VALUES (?, ?, ?, ?, ?, ?)
      `;
      
      await this.connection.execute(query, [
        authorData.author_id,
        authorData.author_name,
        authorData.color_id,
        authorData.timestamp,
        authorData.created_time,
        authorData.padIDs
      ]);
      
    } catch (error) {
      console.error(`❌ 插入作者数据失败 (${authorData.author_id}):`, error);
      throw error;
    }
  }

  // 获取作者统计信息
  async getAuthorStats() {
    try {
      const query = `
        SELECT 
          COUNT(*) as total_authors,
          COUNT(CASE WHEN author_name IS NOT NULL THEN 1 END) as named_authors,
          COUNT(CASE WHEN padIDs IS NOT NULL THEN 1 END) as authors_with_pads
        FROM etherpad_author
      `;
      
      const [rows] = await this.connection.execute(query);
      return rows[0];
      
    } catch (error) {
      console.error('❌ 获取作者统计信息失败:', error);
      throw error;
    }
  }
}

module.exports = DatabaseManager;