/**
 * Pad 版本内容重建工具 - HTTP Stream 版本
 * 使用 HTTP 流式传输，避免缓冲区限制导致的 JSON 截断问题
 * 
 * 功能说明：
 *   - 支持两种输出模式：标准模式和 Base64 编码模式
 *   - 使用 HTTP 流式传输，逐版本发送数据，避免缓冲区限制
 *   - 完全避免 JSON 截断问题，支持任意大小的数据
 * 
 * 使用方法: 
 *   # 启动 HTTP 流式服务器
 *   node --require tsx/cjs src/node/scheduler/etherpad_changes/PadContentRebuildAPI.js [--port <port>]
 *   
 *   然后通过 HTTP GET 请求获取数据：
 *   http://localhost:3000/rebuild?padId=room-229&startRev=0&endRev=10&useBase64=true
 * 
 * 示例:
 *   # 启动 HTTP 服务器（默认端口 3000）
 *   cd src && node --require tsx/cjs node/scheduler/etherpad_changes/PadContentRebuildAPI.js
 *   
 *   # 指定端口
 *   cd src && node --require tsx/cjs node/scheduler/etherpad_changes/PadContentRebuildAPI.js --port 8080
 * 
 *   # 通过 HTTP 请求获取数据
 *   curl "http://localhost:3000/rebuild?padId=room-229&startRev=0&endRev=10&useBase64=true"
 */

'use strict';

process.on('unhandledRejection', (err) => { throw err; });

// 设置环境变量以最小化日志输出
process.env.SUPPRESS_LOGS = 'true';

const http = require('http');
const url = require('url');
const db = require('ep_etherpad-lite/node/db/DB');
const padManager = require('ep_etherpad-lite/node/db/PadManager');
const Changeset = require('ep_etherpad-lite/static/js/Changeset');
const AttributePool = require('ep_etherpad-lite/static/js/AttributePool').default;

// 解析命令行参数
const args = process.argv.slice(2);
const portIndex = args.findIndex(arg => arg === '--port' || arg === '-p');
const httpPort = portIndex >= 0 && args[portIndex + 1] ? parseInt(args[portIndex + 1]) : 3000;

// 启动 HTTP 服务器
startHttpServer(httpPort);

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
 * 启动 HTTP 服务器
 */
function startHttpServer(port) {
  const server = http.createServer(async (req, res) => {
    // 只处理 GET 请求
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use GET.' }));
      return;
    }

    const parsedUrl = url.parse(req.url, true);
    
    // 健康检查端点
    if (parsedUrl.pathname === '/health' || parsedUrl.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        status: 'ok', 
        service: 'PadContentRebuildAPI',
        mode: 'http-stream'
      }));
      return;
    }

    // 重建端点
    if (parsedUrl.pathname === '/rebuild') {
      const query = parsedUrl.query;
      const padId = query.padId;
      const startRev = query.startRev ? parseInt(query.startRev) : null;
      const endRev = query.endRev ? parseInt(query.endRev) : null;
      const useBase64 = query.useBase64 === 'true' || query.useBase64 === '1';

      if (!padId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing padId parameter' }));
        return;
      }

      try {
        // 设置响应头，支持流式传输
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache'
        });

        // 开始流式传输 JSON
        await streamRebuildPadContent(res, padId, startRev, endRev, useBase64);
        
        res.end();
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: error.message,
          stack: error.stack
        }));
      }
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, () => {
    console.error(`🚀 HTTP Stream Server started on port ${port}`);
    console.error(`📡 Health check: http://localhost:${port}/health`);
    console.error(`📡 Rebuild API: http://localhost:${port}/rebuild?padId=<padId>&startRev=<start>&endRev=<end>&useBase64=<true|false>`);
    console.error(`\n💡 Example: http://localhost:${port}/rebuild?padId=room-229&startRev=0&endRev=10&useBase64=true`);
  });

  // 优雅关闭
  process.on('SIGTERM', () => {
    console.error('\n🛑 Shutting down server...');
    server.close(() => {
      process.exit(0);
    });
  });
}

/**
 * 流式重建 Pad 版本内容（通过 HTTP 流传输）
 */
async function streamRebuildPadContent(res, padId, startRev, endRev, useBase64) {
  try {
    // 初始化数据库
    await db.init();

    // 检查 pad 是否存在
    const exists = await padManager.doesPadExists(padId);
    if (!exists) {
      res.write(JSON.stringify({
        success: false,
        error: `Pad [${padId}] does not exist`
      }));
      return;
    }

    // 获取 Pad 对象
    const pad = await padManager.getPad(padId);
    const headRevision = pad.getHeadRevisionNumber();

    // 确定处理范围
    const actualStartRev = startRev !== null ? Math.max(0, startRev) : 0;
    const actualEndRev = endRev !== null ? Math.min(headRevision, endRev) : headRevision;

    if (actualStartRev > actualEndRev) {
      res.write(JSON.stringify({
        success: false,
        error: `Invalid revision range: ${actualStartRev} > ${actualEndRev}`
      }));
      return;
    }

    // 发送响应头部信息
    res.write(JSON.stringify({
      success: true,
      pad_id: padId,
      head_revision: headRevision,
      requested_range: {
        start: actualStartRev,
        end: actualEndRev
      },
      encoding: useBase64 ? 'base64' : 'standard',
      stream: true
    }) + '\n');

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
          
          // 将数据库中的 pool 对象转换为 AttributePool 实例
          let pool;
          if (meta.pool && typeof meta.pool === 'object') {
            pool = new AttributePool();
            pool.fromJsonable(meta.pool);
          } else {
            pool = pad.apool();
          }
          
          atext = applyToAText(changeset, atext, pool);
        }
      }
    }

    let successCount = 0;
    let errorCount = 0;

    // 逐个版本应用 Changeset 并流式发送
    for (let rev = actualStartRev; rev <= actualEndRev; rev++) {
      try {
        const revData = await db.get(`pad:${padId}:revs:${rev}`);

        if (!revData) {
          errorCount++;
          res.write(JSON.stringify({
            revision: rev,
            success: false,
            error: 'Revision data not found'
          }) + '\n');
          continue;
        }

        const { changeset, meta } = revData;
        const { author, timestamp, pool: metaPool } = meta;
        
        // 将数据库中的 pool 对象转换为 AttributePool 实例
        let pool;
        if (metaPool && typeof metaPool === 'object') {
          pool = new AttributePool();
          pool.fromJsonable(metaPool);
        } else {
          pool = pad.apool();
        }

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
          // 标准模式 - 直接存储
          record.content = content;
          record.changeset = changeset;
          record.attribs = atext.attribs || '';
        }

        // 流式发送每个版本（NDJSON 格式，每行一个 JSON 对象）
        res.write(JSON.stringify(record) + '\n');
        successCount++;

      } catch (err) {
        errorCount++;
        res.write(JSON.stringify({
          revision: rev,
          success: false,
          error: err.message
        }) + '\n');
      }
    }

    // 发送统计信息和结束标记
    res.write(JSON.stringify({
      _statistics: {
        total: actualEndRev - actualStartRev + 1,
        success: successCount,
        failed: errorCount
      },
      _end: true
    }) + '\n');

  } catch (error) {
    res.write(JSON.stringify({
      success: false,
      error: error.message,
      stack: error.stack
    }) + '\n');
  }
}


