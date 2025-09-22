/**
 * 数据库连接和操作工具
 */

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// 读取settings.json配置  
function loadDatabaseConfig() {
  try {
    // 动态读取settings.json文件
    const settingsPath = path.join(__dirname, '../../../settings.json');
    
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
      console.log('✅ 数据库连接成功 (配置来源: settings.json)');
    } catch (error) {
      console.error('❌ 数据库连接失败:', error);
      console.error('💡 请检查settings.json中的数据库配置');
      throw error;
    }
  }

  async disconnect() {
    if (this.connection) {
      await this.connection.end();
      console.log('数据库连接已关闭');
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

  // 插入或更新pad版本数据
  async insertPadVersion(data) {
    try {
      // 先尝试包含change_position字段的插入
      const queryWithPosition = `
        INSERT INTO etherpad_pad_version 
        (pad_id, revision, content, author, timestamp, changeset, user_name, change_description, change_position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          content = VALUES(content),
          author = VALUES(author),
          timestamp = VALUES(timestamp),
          changeset = VALUES(changeset),
          user_name = VALUES(user_name),
          change_description = VALUES(change_description),
          change_position = VALUES(change_position)
      `;
      
      await this.connection.execute(queryWithPosition, [
        data.padId,
        data.revision,
        data.content || null,
        data.author,
        data.timestamp,
        data.changeset,
        data.userName || null,
        data.changeDescription,
        data.changePosition || null
      ]);
    } catch (error) {
      // 如果失败（可能是缺少change_position字段），使用不包含该字段的查询
      if (error.message.includes('change_position')) {
        console.warn('⚠️  change_position字段不存在，使用兼容模式插入');
        const queryWithoutPosition = `
          INSERT INTO etherpad_pad_version 
          (pad_id, revision, content, author, timestamp, changeset, user_name, change_description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            content = VALUES(content),
            author = VALUES(author),
            timestamp = VALUES(timestamp),
            changeset = VALUES(changeset),
            user_name = VALUES(user_name),
            change_description = VALUES(change_description)
        `;
        
        await this.connection.execute(queryWithoutPosition, [
          data.padId,
          data.revision,
          data.content || null,
          data.author,
          data.timestamp,
          data.changeset,
          data.userName || null,
          data.changeDescription
        ]);
      } else {
        throw error;
      }
    }
  }

  // 更新pad版本数据
  async updatePadVersion(data) {
    try {
      // 先尝试包含change_position字段的更新
      const queryWithPosition = `
        UPDATE etherpad_pad_version 
        SET content = ?, author = ?, timestamp = ?, changeset = ?, 
            user_name = ?, change_description = ?, change_position = ?
        WHERE pad_id = ? AND revision = ?
      `;
      
      await this.connection.execute(queryWithPosition, [
        data.content || null,
        data.author,
        data.timestamp,
        data.changeset,
        data.userName || null,
        data.changeDescription,
        data.changePosition || null,
        data.padId,
        data.revision
      ]);
    } catch (error) {
      // 如果失败（可能是缺少change_position字段），使用不包含该字段的更新
      if (error.message.includes('change_position')) {
        console.warn('⚠️  change_position字段不存在，使用兼容模式更新');
        const queryWithoutPosition = `
          UPDATE etherpad_pad_version 
          SET content = ?, author = ?, timestamp = ?, changeset = ?, 
              user_name = ?, change_description = ?
          WHERE pad_id = ? AND revision = ?
        `;
        
        await this.connection.execute(queryWithoutPosition, [
          data.content || null,
          data.author,
          data.timestamp,
          data.changeset,
          data.userName || null,
          data.changeDescription,
          data.padId,
          data.revision
        ]);
      } else {
        throw error;
      }
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
      // 先尝试包含change_position字段的查询
      const queryWithPosition = `
        SELECT pad_id, revision, content, author, timestamp, changeset, 
               user_name, change_description, change_position
        FROM etherpad_pad_version 
        WHERE pad_id = ? AND revision = ? 
        LIMIT 1
      `;
      
      const [rows] = await this.connection.execute(queryWithPosition, [padId, revision]);
      if (rows.length === 0) {
        return null;
      }
      
      const row = rows[0];
      return {
        padId: row.pad_id,
        revision: row.revision,
        content: row.content,
        author: row.author,
        timestamp: row.timestamp,
        changeset: row.changeset,
        userName: row.user_name,
        changeDescription: row.change_description,
        changePosition: row.change_position || null
      };
    } catch (error) {
      // 如果失败（可能是缺少change_position字段），使用不包含该字段的查询
      if (error.message.includes('change_position')) {
        console.warn('⚠️  change_position字段不存在，使用兼容模式查询');
        const queryWithoutPosition = `
          SELECT pad_id, revision, content, author, timestamp, changeset, 
                 user_name, change_description
          FROM etherpad_pad_version 
          WHERE pad_id = ? AND revision = ? 
          LIMIT 1
        `;
        
        const [rows] = await this.connection.execute(queryWithoutPosition, [padId, revision]);
        if (rows.length === 0) {
          return null;
        }
        
        const row = rows[0];
        return {
          padId: row.pad_id,
          revision: row.revision,
          content: row.content,
          author: row.author,
          timestamp: row.timestamp,
          changeset: row.changeset,
          userName: row.user_name,
          changeDescription: row.change_description,
          changePosition: null
        };
      } else {
        throw error;
      }
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
        console.log(`📝 为 ${padId} 创建版本0记录`);
        
        // 创建版本0记录
        const version0Data = {
          padId: padId,
          revision: 0,
          content: '', // 版本0通常是空内容
          author: 'system',
          timestamp: Date.now(),
          changeset: '', // 版本0没有changeset
          userName: 'system',
          changeDescription: '初始文档状态',
          changePosition: null
        };
        
        await this.insertPadVersion(version0Data);
        console.log(`✅ 已创建 ${padId} 的版本0记录`);
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

  // 修复内容重建中的空格问题
  async fixContentSpacing(padId, revision, content) {
    if (!content) return content;
    
    try {
      // 移除多余的空格和换行
      let fixedContent = content
        .replace(/\s+/g, ' ')           // 多个空格替换为单个空格
        .replace(/^\s+|\s+$/g, '')      // 移除首尾空格
        .replace(/\n\s*\n/g, '\n')      // 多个换行替换为单个换行
        .trim();                        // 最终trim
      
      // 如果内容为空但原来不为空，保留一个换行符（Etherpad的默认状态）
      if (!fixedContent && content.length > 0) {
        fixedContent = '\n';
      }
      
      return fixedContent;
    } catch (error) {
      console.warn(`⚠️  修复内容空格失败 (${padId}:${revision}):`, error);
      return content; // 返回原内容
    }
  }

  // 批量修复内容空格问题
  async fixAllContentSpacing() {
    try {
      const query = `
        SELECT pad_id, revision, content
        FROM etherpad_pad_version 
        WHERE content IS NOT NULL 
        AND (content LIKE '%  %' OR content LIKE ' %' OR content LIKE '% ')
        ORDER BY pad_id, revision
      `;
      
      const [rows] = await this.connection.execute(query);
      console.log(`📊 发现 ${rows.length} 个记录需要修复空格问题`);
      
      let fixedCount = 0;
      for (const row of rows) {
        const fixedContent = await this.fixContentSpacing(row.pad_id, row.revision, row.content);
        
        if (fixedContent !== row.content) {
          await this.updateContentOnly(row.pad_id, row.revision, fixedContent);
          fixedCount++;
          
          if (fixedCount % 100 === 0) {
            console.log(`📝 已修复 ${fixedCount} 个记录的空格问题`);
          }
        }
      }
      
      console.log(`✅ 共修复了 ${fixedCount} 个记录的空格问题`);
      return fixedCount;
    } catch (error) {
      console.error('❌ 批量修复空格问题失败:', error);
      throw error;
    }
  }
}

module.exports = DatabaseManager; 