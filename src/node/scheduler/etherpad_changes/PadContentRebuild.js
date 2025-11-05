/**
 * Pad 版本内容重建工具
 * 基于 Etherpad Changeset 重建 Pad 版本内容并插入数据库
 * 直接调用 Etherpad 现有的 timeslider 核心逻辑
 *
 * 使用方法: node --require tsx/cjs src/node/scheduler/PadContentRebuild.js <padId>
 * 示例: cd src && node --require tsx/cjs node/scheduler/PadContentRebuild.js room-229
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
  console.log('🚀 Etherpad Pad 版本内容重建工具');
  console.log('═'.repeat(50));
  console.log('使用方法: cd src && node --require tsx/cjs node/scheduler/PadContentRebuild.js <padId>');
  console.log('示例: cd src && node --require tsx/cjs node/scheduler/PadContentRebuild.js room-229');
  console.log('');
  console.log('功能说明:');
  console.log('  - 直接调用 Etherpad 的 Changeset 核心函数');
  console.log('  - 模拟 timeslider 的版本重建过程');
  console.log('  - 从 store 表读取 changeset，逐步应用生成完整文本');
  console.log('  - 将重建的版本内容插入/更新到 MySQL pad_version_contents 表');
  process.exit(1);
}

const padId = process.argv[2];

(async () => {
  console.log(`\n========================================`);
  console.log(`重建 Pad [${padId}] 的版本内容`);
  console.log(`时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log(`========================================\n`);

  let mysqlConnection = null;

  try {
    // 初始化数据库
    console.log('🔧 连接 Etherpad 数据库...');
    await db.init();
    console.log('✓ Etherpad 数据库连接成功');

    // 连接 MySQL 数据库
    console.log('🔧 连接 MySQL 数据库...');
    mysqlConnection = await mysql.createConnection({
      host: settings.dbSettings.host,
      port: settings.dbSettings.port,
      user: settings.dbSettings.user,
      password: settings.dbSettings.password,
      database: settings.dbSettings.database
    });
    console.log('✓ MySQL 数据库连接成功');

    // 获取 Changeset 核心函数 - 这些就是 timeslider 使用的函数
    console.log('🔧 加载 Changeset 模块...');
    const { makeAText, applyToAText } = Changeset;
    console.log('✓ Changeset 模块加载成功');

    // 检查 pad 是否存在
    console.log(`🔍 检查 Pad [${padId}] 是否存在...`);
    const exists = await padManager.doesPadExists(padId);
    if (!exists) {
      console.error(`✗ Pad [${padId}] 不存在`);
      process.exit(1);
    }

    // 获取 Pad 对象
    const pad = await padManager.getPad(padId);
    const headRevision = pad.getHeadRevisionNumber();
    console.log(`✓ 找到 Pad [${padId}], 当前版本: ${headRevision}\n`);

    // 初始化文本 - 就像 timeslider 开始时一样，从空文本 + 换行符开始
    console.log('🚀 开始重建版本内容...');
    let atext = makeAText('\n');
    console.log(`✓ 初始化文本: "${atext.text.replace(/\n/g, '\\n')}"`);

    const results = [];
    let successCount = 0;
    let errorCount = 0;
    let insertCount = 0;
    let updateCount = 0;

    // 逐个版本应用 Changeset - 完全模拟 timeslider 的播放过程
    for (let rev = 0; rev <= headRevision; rev++) {
      try {
        // 从 store 表读取该版本的数据
        const revData = await db.get(`pad:${padId}:revs:${rev}`);

        if (!revData) {
          console.error(`  ✗ Rev ${rev}: 数据不存在`);
          errorCount++;
          continue;
        }

        const { changeset, meta } = revData;
        const { author, timestamp, pool: metaPool } = meta;

        // 使用版本的 pool（如果有）或 pad 的全局 pool
        const pool = metaPool || pad.apool();

        // 应用 changeset 到当前文本 - 这就是 timeslider 的核心逻辑！
        const oldText = atext.text;
        atext = applyToAText(changeset, atext, pool);
        const newText = atext.text;

        // 提取纯文本内容（去掉末尾换行符，符合显示习惯）
        let content = newText;
        if (content.endsWith('\n')) {
          content = content.slice(0, -1);
        }

        // 准备数据库记录
        const record = {
          pad_id: padId,
          revision: rev,
          content: content,
          author: author || '',
          timestamp: timestamp || Date.now(),
          changeset: changeset,
          attribs: atext.attribs || '',
          text_length: content.length,
          line_count: (content.match(/\n/g) || []).length + 1,
          change_summary: `${oldText.length} -> ${newText.length} chars`
        };

        // 执行数据库插入/更新操作 - 只插入到 MySQL 表
        let isUpdate = false;

        try {
          // 检查 MySQL 表中是否已存在该记录
          const [existingRows] = await mysqlConnection.execute(
            'SELECT revision FROM pad_version_contents WHERE pad_id = ? AND revision = ?',
            [padId, rev]
          );
          isUpdate = existingRows.length > 0;

          // 插入/更新 MySQL 表
          await mysqlConnection.execute(`
            INSERT INTO pad_version_contents
            (pad_id, revision, content, author_id, timestamp)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
            content = VALUES(content),
            author_id = VALUES(author_id),
            timestamp = VALUES(timestamp)
          `, [
            record.pad_id,
            record.revision,
            record.content,
            record.author,  // 使用 author 作为 author_id
            record.timestamp
          ]);

          if (isUpdate) {
            updateCount++;
          } else {
            insertCount++;
          }

        } catch (dbError) {
          console.error(`  ✗ Rev ${rev}: MySQL 操作失败 - ${dbError.message}`);
          errorCount++;
          continue;
        }

        results.push(record);
        successCount++;

        // 显示进度和变化
        if (rev % 5 === 0 || rev === headRevision || rev < 10) {
          const preview = content.substring(0, 40).replace(/\n/g, '\\n');
          const operation = isUpdate ? '更新' : '插入';
          console.log(`  ✓ Rev ${rev}: "${preview}${content.length > 40 ? '...' : ''}" (${record.change_summary}) [${operation}]`);
        }

        // 每 20 个版本显示一次总进度
        if ((rev + 1) % 20 === 0) {
          console.log(`    📊 进度: ${rev + 1}/${headRevision + 1} (${Math.round((rev + 1) / (headRevision + 1) * 100)}%) | 插入: ${insertCount}, 更新: ${updateCount}`);
        }

      } catch (err) {
        console.error(`  ✗ Rev ${rev} 处理失败:`, err.message);
        errorCount++;
      }
    }

    console.log(`\n========================================`);
    console.log(`重建完成！`);
    console.log(`  - 总版本数: ${headRevision + 1}`);
    console.log(`  - 成功处理: ${successCount}`);
    console.log(`  - 新增记录: ${insertCount}`);
    console.log(`  - 更新记录: ${updateCount}`);
    console.log(`  - 失败数量: ${errorCount}`);
    console.log(`========================================\n`);

    // 显示最终内容
    if (results.length > 0) {
      const lastVersion = results[results.length - 1];
      console.log(`📄 最新版本内容 (Rev ${lastVersion.revision}):`);
      console.log(`${'='.repeat(60)}`);
      console.log(lastVersion.content);
      console.log(`${'='.repeat(60)}`);
      console.log(`📊 统计信息:`);
      console.log(`  - 字符数: ${lastVersion.text_length}`);
      console.log(`  - 行数: ${lastVersion.line_count}`);
      console.log(`  - 作者: ${lastVersion.author}`);
      console.log(`  - 时间: ${new Date(lastVersion.timestamp).toLocaleString('zh-CN')}\n`);
    }

    // 显示数据验证信息
    console.log(`💾 数据库操作摘要:`);
    console.log(`${'='.repeat(50)}`);
    console.log(`✓ 成功插入 ${insertCount} 条新记录`);
    console.log(`✓ 成功更新 ${updateCount} 条现有记录`);
    console.log(`✓ 总共处理 ${successCount} 个版本`);
    if (errorCount > 0) {
      console.log(`⚠️  处理失败 ${errorCount} 个版本`);
    }
    console.log(`\n数据存储位置: MySQL 表 pad_version_contents`);

    // 验证 MySQL 表中的数据
    if (mysqlConnection) {
      try {
        const [countResult] = await mysqlConnection.execute(
          'SELECT COUNT(*) as count FROM pad_version_contents WHERE pad_id = ?',
          [padId]
        );
        console.log(`\n📊 MySQL 表验证:`);
        console.log(`  - pad_version_contents 表中 ${padId} 的记录数: ${countResult[0].count}`);

        // 检查最后几个版本
        const [lastVersions] = await mysqlConnection.execute(
          'SELECT revision FROM pad_version_contents WHERE pad_id = ? AND revision >= ? ORDER BY revision',
          [padId, Math.max(0, headRevision - 5)]
        );
        const foundVersions = lastVersions.map(row => row.revision);
        console.log(`  - 最后几个版本: ${foundVersions.join(', ')}`);

        if (foundVersions.includes(headRevision)) {
          console.log(`  ✓ 最新版本 ${headRevision} 已成功存储到 MySQL 表`);
        } else {
          console.log(`  ⚠️  最新版本 ${headRevision} 未在 MySQL 表中找到`);
        }
      } catch (verifyError) {
        console.error(`  ⚠️  MySQL 验证失败: ${verifyError.message}`);
      }
    }

  } catch (error) {
    console.error('\n❌ 处理失败:', error);
    console.error('错误堆栈:', error.stack);
  } finally {
    // 关闭连接
    if (mysqlConnection) {
      try {
        await mysqlConnection.end();
        console.log('\n🔌 MySQL 连接已关闭');
      } catch (closeError) {
        console.error('MySQL 连接关闭失败:', closeError.message);
      }
    }

    try {
      await db.shutdown();
      console.log('🔌 Etherpad 数据库连接已关闭');
    } catch (closeError) {
      console.error('Etherpad 数据库关闭失败:', closeError.message);
    }

    console.log('\n🎉 Pad 版本内容重建完成！');
  }
})();
