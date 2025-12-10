/**
 * Pad 版本内容重建工具 - HTTP API 版本
 * 不存储到数据库，而是通过 HTTP 返回 JSON 数据
 * 
 * 使用方法: 
 *   node --require tsx/cjs src/node/scheduler/etherpad_changes/PadContentRebuildAPI.js <padId> [startRev] [endRev]
 * 
 * 示例:
 *   cd src && node --require tsx/cjs node/scheduler/etherpad_changes/PadContentRebuildAPI.js room-229
 *   cd src && node --require tsx/cjs node/scheduler/etherpad_changes/PadContentRebuildAPI.js room-229 0 10
 */

'use strict';

process.on('unhandledRejection', (err) => { throw err; });

// 设置环境变量以最小化日志输出
process.env.SUPPRESS_LOGS = 'true';

// 禁用所有 console 输出到 stdout，确保只输出 JSON
const originalStdoutWrite = process.stdout.write;
const originalConsoleLog = console.log;
const bufferedLogs = [];

// 拦截所有 stdout 输出
process.stdout.write = function(chunk, encoding, callback) {
  bufferedLogs.push(chunk);
  return true;
};

const db = require('ep_etherpad-lite/node/db/DB');
const padManager = require('ep_etherpad-lite/node/db/PadManager');
const Changeset = require('ep_etherpad-lite/static/js/Changeset');

// 恢复 stdout 用于最后输出 JSON
process.stdout.write = originalStdoutWrite;
console.log = originalConsoleLog;

// 解析命令行参数
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error(JSON.stringify({
    error: 'Missing padId parameter',
    usage: 'node PadContentRebuildAPI.js <padId> [startRev] [endRev]',
    example: 'node PadContentRebuildAPI.js room-229 0 10'
  }));
  process.exit(1);
}

const padId = args[0];
const startRev = args[1] ? parseInt(args[1]) : null;
const endRev = args[2] ? parseInt(args[2]) : null;

/**
 * 格式化时间戳为香港时间
 */
function formatHKTime(timestamp) {
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  const padMs = (n) => String(n).padStart(3, '0');
  const hkDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${hkDate.getUTCFullYear()}-${pad(hkDate.getUTCMonth() + 1)}-${pad(hkDate.getUTCDate())} ` +
    `${pad(hkDate.getUTCHours())}:${pad(hkDate.getUTCMinutes())}:${pad(hkDate.getUTCSeconds())}.${padMs(hkDate.getUTCMilliseconds())}`;
}

/**
 * 重建 Pad 版本内容
 */
async function rebuildPadContent() {
  try {
    // 初始化数据库
    await db.init();

    // 检查 pad 是否存在
    const exists = await padManager.doesPadExists(padId);
    if (!exists) {
      return {
        success: false,
        error: `Pad [${padId}] does not exist`
      };
    }

    // 获取 Pad 对象
    const pad = await padManager.getPad(padId);
    const headRevision = pad.getHeadRevisionNumber();

    // 确定处理范围
    const actualStartRev = startRev !== null ? Math.max(0, startRev) : 0;
    const actualEndRev = endRev !== null ? Math.min(headRevision, endRev) : headRevision;

    if (actualStartRev > actualEndRev) {
      return {
        success: false,
        error: `Invalid revision range: ${actualStartRev} > ${actualEndRev}`
      };
    }

    // 获取 Changeset 核心函数
    const { makeAText, applyToAText } = Changeset;

    // 初始化文本
    let atext = makeAText('\n');

    // 如果不是从 0 开始，需要先重建到 startRev
    if (actualStartRev > 0) {
      for (let rev = 0; rev < actualStartRev; rev++) {
        const revData = await db.get(`pad:${padId}:revs:${rev}`);
        if (revData) {
          const { changeset, meta } = revData;
          const pool = meta.pool || pad.apool();
          atext = applyToAText(changeset, atext, pool);
        }
      }
    }

    const results = [];
    let successCount = 0;
    let errorCount = 0;

    // 逐个版本应用 Changeset
    for (let rev = actualStartRev; rev <= actualEndRev; rev++) {
      try {
        const revData = await db.get(`pad:${padId}:revs:${rev}`);

        if (!revData) {
          errorCount++;
          results.push({
            revision: rev,
            success: false,
            error: 'Revision data not found'
          });
          continue;
        }

        const { changeset, meta } = revData;
        const { author, timestamp, pool: metaPool } = meta;
        const pool = metaPool || pad.apool();

        // 应用 changeset
        const oldText = atext.text;
        atext = applyToAText(changeset, atext, pool);
        const newText = atext.text;

        // 提取纯文本内容
        let content = newText;
        if (content.endsWith('\n')) {
          content = content.slice(0, -1);
        }

        // 构建结果
        const record = {
          revision: rev,
          success: true,
          pad_id: padId,
          content: content,
          author: author || '',
          timestamp: timestamp || Date.now(),
          formatted_timestamp: formatHKTime(timestamp || Date.now()),
          changeset: changeset,
          attribs: atext.attribs || '',
          text_length: content.length,
          line_count: (content.match(/\n/g) || []).length + 1,
          change_summary: `${oldText.length} -> ${newText.length} chars`
        };

        results.push(record);
        successCount++;

      } catch (err) {
        errorCount++;
        results.push({
          revision: rev,
          success: false,
          error: err.message
        });
      }
    }

    // 返回完整结果
    return {
      success: true,
      pad_id: padId,
      head_revision: headRevision,
      requested_range: {
        start: actualStartRev,
        end: actualEndRev
      },
      statistics: {
        total: actualEndRev - actualStartRev + 1,
        success: successCount,
        failed: errorCount
      },
      versions: results
    };

  } catch (error) {
    return {
      success: false,
      error: error.message,
      stack: error.stack
    };
  }
}

// 执行并输出 JSON
(async () => {
  const result = await rebuildPadContent();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
})();

