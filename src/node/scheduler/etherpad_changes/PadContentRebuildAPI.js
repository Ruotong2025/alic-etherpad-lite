/**
 * Pad 版本内容重建工具 - HTTP API 版本（整合版）
 * 不存储到数据库，而是通过 HTTP 返回 JSON 数据
 * 
 * 功能说明：
 *   - 支持两种输出模式：标准模式和 Base64 编码模式
 *   - 标准模式：过滤控制字符，适合小数据量
 *   - Base64 模式：完全避免 JSON 转义问题，适合大数据量和远程 SSH 调用
 * 
 * 使用方法: 
 *   node --require tsx/cjs src/node/scheduler/etherpad_changes/PadContentRebuildAPI.js <padId> [startRev] [endRev] [--base64]
 * 
 * 示例:
 *   # 标准模式（默认）
 *   cd src && node --require tsx/cjs node/scheduler/etherpad_changes/PadContentRebuildAPI.js room-229
 *   cd src && node --require tsx/cjs node/scheduler/etherpad_changes/PadContentRebuildAPI.js room-229 0 10
 * 
 *   # Base64 编码模式（推荐用于大数据量和远程调用）
 *   cd src && node --require tsx/cjs node/scheduler/etherpad_changes/PadContentRebuildAPI.js room-229 0 10 --base64
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
    error: '缺少 padId 参数',
    usage: 'node PadContentRebuildAPI.js <padId> [startRev] [endRev] [--base64]',
    example: 'node PadContentRebuildAPI.js room-229 0 10 --base64'
  }));
  process.exit(1);
}

// 检查是否使用 Base64 编码模式
const useBase64 = args.includes('--base64');
const filteredArgs = args.filter(arg => arg !== '--base64');

const padId = filteredArgs[0];
const startRev = filteredArgs[1] ? parseInt(filteredArgs[1]) : null;
const endRev = filteredArgs[2] ? parseInt(filteredArgs[2]) : null;

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
 * 安全的 JSON 字符串化 - 确保所有字符都被正确转义
 * 移除可能导致 JSON 解析失败的控制字符
 */
function safeStringify(obj) {
  return JSON.stringify(obj, (key, value) => {
    // 如果是字符串类型，确保特殊字符被正确处理
    if (typeof value === 'string') {
      // 移除或替换可能导致问题的控制字符
      return value
        .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F]/g, '') // 移除控制字符
        .replace(/\uFEFF/g, ''); // 移除 BOM (Byte Order Mark)
    }
    return value;
  });
}

/**
 * Base64 编码内容 - 用于避免 JSON 转义问题
 * 适合大数据量和远程 SSH 调用
 */
function encodeToBase64(content) {
  if (!content) return '';
  try {
    return Buffer.from(content, 'utf8').toString('base64');
  } catch (error) {
    return '';
  }
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

        // 构建结果 - 根据模式选择编码方式
        const record = {
          revision: rev,
          success: true,
          pad_id: padId,
          author: author || '',
          timestamp: timestamp || Date.now(),
          formatted_timestamp: formatHKTime(timestamp || Date.now()),
          text_length: content.length,
          line_count: (content.match(/\n/g) || []).length + 1,
          change_summary: `${oldText.length} -> ${newText.length} chars`
        };

        // 根据模式添加内容字段
        if (useBase64) {
          // Base64 编码模式 - 避免 JSON 转义问题
          record.content_base64 = encodeToBase64(content);
          record.changeset_base64 = encodeToBase64(changeset);
          record.attribs_base64 = encodeToBase64(atext.attribs || '');
        } else {
          // 标准模式 - 直接存储（会被 safeStringify 过滤控制字符）
          record.content = content;
          record.changeset = changeset;
          record.attribs = atext.attribs || '';
        }

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
    const result = {
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

    // 如果使用 Base64 模式，添加标记
    if (useBase64) {
      result.encoding = 'base64';
      result.note = '内容使用 Base64 编码，需要解码后使用';
    }

    return result;

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
  try {
    const result = await rebuildPadContent();
    // 使用安全的 JSON 字符串化方法，不使用格式化以减少输出大小
    const jsonOutput = safeStringify(result);
    console.log(jsonOutput);
    process.exit(result.success ? 0 : 1);
  } catch (error) {
    // 如果发生意外错误，输出错误信息
    console.log(safeStringify({
      success: false,
      error: error.message,
      stack: error.stack
    }));
    process.exit(1);
  }
})();

