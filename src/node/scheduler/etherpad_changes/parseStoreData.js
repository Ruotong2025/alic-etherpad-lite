#!/usr/bin/env node

/**
 * 解析 store 表中的 pad 数据
 * 提取 content, changeset, timestamp 并存储到新表
 */

const mysql = require('mysql2/promise');

// 数据库配置
const DB_CONFIG = {
  host: process.env.DB_HOST || '112.74.92.135',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '1q2w3e4R',
  database: process.env.DB_NAME || 'alic',
  charset: 'utf8mb4',
  port: process.env.DB_PORT || 3306
};

class StoreDataParser {
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

  /**
   * 创建解析数据表
   */
  async createParseTable() {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS pad_store_parsed (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        store_key VARCHAR(500) NOT NULL COMMENT 'Store 表的 key',
        pad_id VARCHAR(255) NOT NULL COMMENT 'Pad ID',
        revision INT NOT NULL COMMENT '版本号',
        content LONGTEXT COMMENT '内容',
        changeset TEXT COMMENT 'Changeset',
        timestamp BIGINT COMMENT '时间戳（毫秒）',
        create_time DATETIME COMMENT '创建时间（从 timestamp 转换）',
        parsed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '解析时间',
        
        INDEX idx_pad_id (pad_id),
        INDEX idx_pad_revision (pad_id, revision),
        INDEX idx_create_time (create_time),
        UNIQUE KEY uk_store_key (store_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci 
        COMMENT='Store 表解析数据（用于对比分析）'
    `;

    await this.connection.execute(createTableSQL);
    console.log('✅ 解析数据表创建/检查完成（pad_store_parsed）');
  }

  /**
   * 从 store 表获取 pad 相关的数据
   */
  async getStorePadData(padId) {
    const pattern = `pad:${padId}:%`;
    const query = `
      SELECT \`key\`, \`value\`
      FROM store
      WHERE \`key\` LIKE ?
      ORDER BY \`key\`
    `;
    
    const [rows] = await this.connection.execute(query, [pattern]);
    return rows;
  }

  /**
   * 解析单条 store 数据
   */
  parseStoreRecord(key, value) {
    try {
      // 解析 key: pad:room-229:revs:123
      const keyParts = key.split(':');
      
      if (keyParts.length < 4) {
        return null; // 不是版本数据
      }

      const padId = keyParts[1];
      const type = keyParts[2]; // revs
      const revision = parseInt(keyParts[3]);

      if (type !== 'revs') {
        return null; // 只处理版本数据
      }

      // 解析 JSON 值
      let data;
      if (typeof value === 'object') {
        data = value;
      } else {
        data = JSON.parse(value);
      }

      // 提取字段
      // 注意：只有第一个版本（revs:0）包含完整的 atext.text
      // 后续版本只有 changeset
      const content = data.meta?.atext?.text || null;
      const changeset = data.changeset || null;
      const timestamp = data.meta?.timestamp || null;

      // 转换 timestamp 为 datetime
      let createTime = null;
      if (timestamp) {
        createTime = new Date(timestamp);
      }

      return {
        store_key: key,
        pad_id: padId,
        revision: revision,
        content: content,
        changeset: changeset,
        timestamp: timestamp,
        create_time: createTime
      };
    } catch (error) {
      console.error(`解析失败 [${key}]:`, error.message);
      return null;
    }
  }

  /**
   * 清空指定 pad 的解析数据
   */
  async clearParsedData(padId) {
    await this.connection.execute(
      'DELETE FROM pad_store_parsed WHERE pad_id = ?',
      [padId]
    );
    console.log('🗑️  清理旧的解析数据');
  }

  /**
   * 插入解析后的数据
   */
  async insertParsedData(records) {
    if (records.length === 0) return;

    console.log(`💾 开始保存 ${records.length} 条解析记录...`);

    const query = `
      INSERT INTO pad_store_parsed 
      (store_key, pad_id, revision, content, changeset, timestamp, create_time)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    let successCount = 0;

    for (const record of records) {
      try {
        await this.connection.execute(query, [
          record.store_key,
          record.pad_id,
          record.revision,
          record.content,
          record.changeset,
          record.timestamp,
          record.create_time
        ]);
        successCount++;

        if (successCount % 100 === 0) {
          console.log(`   进度: ${successCount}/${records.length}`);
        }
      } catch (error) {
        console.error(`   ❌ 保存失败 (${record.store_key}):`, error.message);
      }
    }

    console.log(`✅ 保存完成: 成功 ${successCount}/${records.length}`);
  }

  /**
   * 从 changeset 中提取变化的内容（$ 后面的部分）
   */
  extractChangesetContent(changeset) {
    try {
      if (!changeset || !changeset.startsWith('Z:')) {
        return null;
      }

      // 提取 changeset 中的文本内容（$ 后面的部分）
      const dollarIndex = changeset.indexOf('$');
      if (dollarIndex === -1) {
        // 如果没有 $，说明是纯删除操作，没有新增内容
        return null;
      }

      // 返回 $ 后面的内容（新增或修改的文本）
      return changeset.substring(dollarIndex + 1);
    } catch (error) {
      console.error('提取 changeset 内容失败:', error.message);
      return null;
    }
  }

  /**
   * 提取所有版本中的变化内容
   */
  extractChangeContents(parsedRecords) {
    console.log(`\n📝 提取变化内容...`);
    
    let extractedCount = 0;
    
    for (const record of parsedRecords) {
      if (record.changeset && !record.content) {
        // 从 changeset 中提取变化的内容
        const changeContent = this.extractChangesetContent(record.changeset);
        if (changeContent) {
          record.content = changeContent;
          extractedCount++;
        }
      }
      
      if ((record.revision + 1) % 20 === 0) {
        console.log(`   已处理: ${record.revision + 1}/${parsedRecords.length}`);
      }
    }
    
    console.log(`✅ 提取完成: ${extractedCount} 个版本有变化内容\n`);
    
    return parsedRecords;
  }

  /**
   * 主处理函数
   */
  async parseAndStore(padId) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`📤 解析 Store 表中的 Pad 数据`);
    console.log(`${'='.repeat(70)}`);
    console.log(`📝 目标 Pad: ${padId}`);
    console.log(`⏰ 开始时间: ${new Date().toLocaleString('zh-CN')}`);
    console.log(`${'='.repeat(70)}\n`);

    try {
      await this.connect();
      await this.createParseTable();

      console.log(`\n📖 从 store 表读取数据...`);
      const storeRecords = await this.getStorePadData(padId);
      console.log(`✅ 读取到 ${storeRecords.length} 条 store 记录\n`);

      console.log(`🔄 开始解析数据...`);
      const parsedRecords = [];

      for (const record of storeRecords) {
        const parsed = this.parseStoreRecord(record.key, record.value);
        if (parsed) {
          parsedRecords.push(parsed);
        }
      }

      console.log(`✅ 解析完成: 共 ${parsedRecords.length} 条版本数据\n`);

      // 提取变化内容
      const extractedRecords = this.extractChangeContents(parsedRecords);

      // 清理旧数据
      await this.clearParsedData(padId);

      // 保存数据
      await this.insertParsedData(extractedRecords);

      console.log(`\n${'='.repeat(70)}`);
      console.log('📊 解析完成');
      console.log(`${'='.repeat(70)}`);
      console.log(`Pad ID: ${padId}`);
      console.log(`Store 记录数: ${storeRecords.length}`);
      console.log(`解析版本数: ${parsedRecords.length}`);
      console.log(`${'='.repeat(70)}\n`);

    } catch (error) {
      console.error('\n❌ 解析失败:', error);
      console.error(error.stack);
      throw error;
    } finally {
      await this.close();
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
使用方法: node parseStoreData.js <padId>

参数:
  <padId>        要解析的 Pad ID

示例:
  node parseStoreData.js room-229

说明:
  从 store 表中读取指定 pad 的版本数据，解析 content、changeset、timestamp
  并存储到 pad_store_parsed 表中，用于后续对比分析。
    `);
    process.exit(0);
  }

  const parser = new StoreDataParser();

  try {
    await parser.parseAndStore(padId);
    console.log('⏰ 结束时间: ' + new Date().toLocaleString('zh-CN'));
    console.log('✨ 解析完成！\n');
  } catch (error) {
    console.error('❌ 执行失败:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { StoreDataParser };

