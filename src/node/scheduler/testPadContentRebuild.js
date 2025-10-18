node src/node/scheduler/PadContentMerge.js room-229/**
 * 测试脚本：基于 Etherpad Changeset 重建 Pad 版本内容
 * 直接调用 Etherpad 现有的 timeslider 核心逻辑
 *
 * 使用方法: node src/node/scheduler/testPadContentRebuild.js room-229
 */

'use strict';

// As of v14, Node.js does not exit when there is an unhandled Promise rejection. Convert an
// unhandled rejection into an uncaught exception, which does cause Node.js to exit.
process.on('unhandledRejection', (err) => { throw err; });

if (process.argv.length !== 3) {
  console.log('🚀 Etherpad Pad 版本内容重建测试工具');
  console.log('═'.repeat(50));
  console.log('使用方法: node src/node/scheduler/testPadContentRebuild.js <padId>');
  console.log('示例: node src/node/scheduler/testPadContentRebuild.js room-229');
  console.log('');
  console.log('功能说明:');
  console.log('  - 直接调用 Etherpad 的 Changeset 核心函数');
  console.log('  - 模拟 timeslider 的版本重建过程');
  console.log('  - 从 store 表读取数据，逐步应用 changeset');
  console.log('  - 生成可插入 pad_version_contents 表的数据');
  process.exit(1);
}

const padId = process.argv[2];

(async () => {
  console.log(`\n========================================`);
  console.log(`测试重建 Pad [${padId}] 的版本内容`);
  console.log(`时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log(`========================================\n`);

  try {
    // 初始化 Etherpad 设置
    console.log('🔧 初始化 Etherpad 环境...');
    const path = require('path');
    const settingsPath = path.join(__dirname, '..', 'utils', 'Settings');
    require(settingsPath);

    // 初始化数据库
    console.log('🔧 连接数据库...');
    const dbPath = path.join(__dirname, '..', 'db', 'DB');
    const db = require(dbPath);
    await db.init();
    console.log('✓ 数据库连接成功');

    // 导入 Changeset 核心函数 - 这些就是 timeslider 使用的函数
    console.log('🔧 加载 Changeset 模块...');
    const changesetPath = path.join(__dirname, '..', '..', 'static', 'js', 'Changeset');
    const Changeset = require(changesetPath);
    const { makeAText, applyToAText } = Changeset;
    console.log('✓ Changeset 模块加载成功');

    // 获取 Pad 管理器
    const padManagerPath = path.join(__dirname, '..', 'db', 'PadManager');
    const padManager = require(padManagerPath);

    // 检查 pad 是否存在
    console.log(`🔍 检查 Pad [${padId}] 是否存在...`);
    const exists = await padManager.doesPadExist(padId);
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

        // 收集结果
        const result = {
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

        results.push(result);
        successCount++;

        // 显示进度和变化
        if (rev % 5 === 0 || rev === headRevision || rev < 10) {
          const preview = content.substring(0, 40).replace(/\n/g, '\\n');
          console.log(`  ✓ Rev ${rev}: "${preview}${content.length > 40 ? '...' : ''}" (${result.change_summary})`);
        }

        // 每 20 个版本显示一次总进度
        if ((rev + 1) % 20 === 0) {
          console.log(`    📊 进度: ${rev + 1}/${headRevision + 1} (${Math.round((rev + 1) / (headRevision + 1) * 100)}%)`);
        }

      } catch (err) {
        console.error(`  ✗ Rev ${rev} 处理失败:`, err.message);
        errorCount++;
      }
    }

    console.log(`\n========================================`);
    console.log(`重建完成！`);
    console.log(`  - 总版本数: ${headRevision + 1}`);
    console.log(`  - 成功重建: ${successCount}`);
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

    // 显示数据库插入示例
    if (results.length > 0) {
      console.log(`💾 数据库插入示例 (前 3 条):`);
      console.log(`${'='.repeat(80)}`);

      // 创建表的 SQL
      console.log(`-- 创建表`);
      console.log(`CREATE TABLE IF NOT EXISTS pad_version_contents (`);
      console.log(`  id BIGINT AUTO_INCREMENT PRIMARY KEY,`);
      console.log(`  pad_id VARCHAR(255) NOT NULL,`);
      console.log(`  revision INT NOT NULL,`);
      console.log(`  content LONGTEXT NOT NULL,`);
      console.log(`  author VARCHAR(255) DEFAULT '',`);
      console.log(`  timestamp BIGINT NOT NULL,`);
      console.log(`  changeset TEXT,`);
      console.log(`  attribs TEXT,`);
      console.log(`  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,`);
      console.log(`  UNIQUE KEY unique_pad_revision (pad_id, revision)`);
      console.log(`);`);
      console.log(``);

      // 插入数据的 SQL
      console.log(`-- 插入数据示例`);
      results.slice(0, 3).forEach(r => {
        const escapedContent = r.content.replace(/'/g, "\\'").replace(/\n/g, '\\n');
        const escapedChangeset = r.changeset.replace(/'/g, "\\'");
        const escapedAttribs = r.attribs.replace(/'/g, "\\'");

        console.log(`INSERT INTO pad_version_contents`);
        console.log(`  (pad_id, revision, content, author, timestamp, changeset, attribs)`);
        console.log(`VALUES`);
        console.log(`  ('${r.pad_id}', ${r.revision}, '${escapedContent.substring(0, 50)}...', '${r.author}', ${r.timestamp}, '${escapedChangeset.substring(0, 30)}...', '${escapedAttribs.substring(0, 20)}...');`);
        console.log(``);
      });
    }

    await db.shutdown();
    console.log('🎉 测试成功完成！');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ 处理失败:', error);
    console.error('错误堆栈:', error.stack);
    process.exit(1);
  }
})();
