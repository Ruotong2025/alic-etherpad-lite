#!/usr/bin/env node

/**
 * 查询特定版本的完整内容
 */

const mysql = require('mysql2/promise');

const DB_CONFIG = {
  host: '112.74.92.135',
  user: 'root',
  password: '1q2w3e4R',
  database: 'alic',
  charset: 'utf8mb4',
  port: 3306
};

async function main() {
  const padId = process.argv[2] || 'room-229';
  const revision = process.argv[3] || '58';
  
  console.log('='.repeat(70));
  console.log(`查询 Pad 版本内容`);
  console.log('='.repeat(70));
  console.log(`Pad ID: ${padId}`);
  console.log(`Revision: ${revision}`);
  console.log();

  const connection = await mysql.createConnection(DB_CONFIG);

  try {
    // 查询 pad_version_content
    const key1 = `pad_version_content:${padId}:${revision}`;
    console.log(`1. 查询 store 表 (key = ${key1}):`);
    console.log('-'.repeat(70));
    
    const [rows1] = await connection.execute(
      'SELECT `key`, `value` FROM store WHERE `key` = ?',
      [key1]
    );
    
    if (rows1.length > 0) {
      console.log('✅ 找到数据!');
      console.log('\n完整内容:');
      console.log('-'.repeat(70));
      console.log(rows1[0].value);
      console.log('-'.repeat(70));
    } else {
      console.log('❌ 该 key 不存在于 store 表中');
    }

    // 查询 revision 数据
    const key2 = `pad:${padId}:revs:${revision}`;
    console.log(`\n2. 查询 revision 数据 (key = ${key2}):`);
    console.log('-'.repeat(70));
    
    const [rows2] = await connection.execute(
      'SELECT `key`, `value` FROM store WHERE `key` = ?',
      [key2]
    );
    
    if (rows2.length > 0) {
      console.log('✅ 找到 revision 数据!');
      const revData = JSON.parse(rows2[0].value);
      console.log('\nRevision 信息:');
      console.log('  Changeset:', revData.changeset);
      console.log('  Author:', revData.meta?.author);
      console.log('  Timestamp:', revData.meta?.timestamp);
      if (revData.meta?.timestamp) {
        const date = new Date(revData.meta.timestamp);
        console.log('  Time:', date.toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong' }));
      }
    } else {
      console.log('❌ 该 revision 不存在');
    }

    // 查询 MySQL 表
    console.log(`\n3. 查询 pad_version_contents 表:`);
    console.log('-'.repeat(70));
    
    try {
      const [rows3] = await connection.execute(
        'SELECT content FROM pad_version_contents WHERE pad_id = ? AND revision = ?',
        [padId, parseInt(revision)]
      );
      
      if (rows3.length > 0) {
        console.log('✅ 找到数据!');
        console.log('\n内容 (前 200 字符):');
        console.log('-'.repeat(70));
        console.log(rows3[0].content.substring(0, 200) + (rows3[0].content.length > 200 ? '...' : ''));
        console.log('-'.repeat(70));
      } else {
        console.log('❌ 该表中没有该版本的数据');
      }
    } catch (error) {
      console.log('❌ 表不存在或查询失败:', error.message);
    }

  } catch (error) {
    console.error('❌ 查询失败:', error);
  } finally {
    await connection.end();
  }
}

main().catch(console.error);

