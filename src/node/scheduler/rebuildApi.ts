'use strict';

/**
 * Pad Content Rebuild API - Express 路由集成
 * 将 HTTP Stream API 集成到主 Express 服务器中，共享同一端口
 */

import {ArgsExpressType} from "../types/ArgsExpressType";
import {Response} from 'express';

const db = require('../db/DB');
const padManager = require('../db/PadManager');
const Changeset = require('../../static/js/Changeset');
const AttributePool = require('../../static/js/AttributePool').default;

/**
 * 格式化时间戳为香港时间
 */
function formatHKTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  const padMs = (n: number) => String(n).padStart(3, '0');
  const hkDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${hkDate.getUTCFullYear()}-${pad(hkDate.getUTCMonth() + 1)}-${pad(hkDate.getUTCDate())} ` +
    `${pad(hkDate.getUTCHours())}:${pad(hkDate.getUTCMinutes())}:${pad(hkDate.getUTCSeconds())}.${padMs(hkDate.getUTCMilliseconds())}`;
}

/**
 * Base64 编码内容
 */
function encodeToBase64(content: string): string {
  if (!content) return '';
  try {
    return Buffer.from(content, 'utf8').toString('base64');
  } catch (error) {
    return '';
  }
}

/**
 * 流式重建 Pad 版本内容
 */
async function streamRebuildPadContent(
  res: Response,
  padId: string,
  startRev: number | null,
  endRev: number | null,
  useBase64: boolean
): Promise<void> {
  try {
    // 初始化数据库（如果尚未初始化）
    if (!db.db) {
      await db.init();
    }

    // 检查 pad 是否存在
    const exists = await padManager.doesPadExists(padId);
    if (!exists) {
      res.write(JSON.stringify({
        success: false,
        error: `Pad [${padId}] does not exist`
      }) + '\n');
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
      }) + '\n');
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

        // 构建结果
        const record: any = {
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
          record.content_base64 = encodeToBase64(content);
          record.changeset_base64 = encodeToBase64(changeset);
          record.attribs_base64 = encodeToBase64(atext.attribs || '');
        } else {
          record.content = content;
          record.changeset = changeset;
          record.attribs = atext.attribs || '';
        }

        // 流式发送每个版本（NDJSON 格式）
        res.write(JSON.stringify(record) + '\n');
        successCount++;

      } catch (err: any) {
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

  } catch (error: any) {
    res.write(JSON.stringify({
      success: false,
      error: error.message,
      stack: error.stack
    }) + '\n');
  }
}

/**
 * Express 服务器创建钩子
 */
exports.expressCreateServer = (hookName: string, args: ArgsExpressType, cb: Function): void => {
  // 健康检查端点
  args.app.get('/api/rebuild/health', (req: any, res: any) => {
    res.json({
      status: 'ok',
      service: 'PadContentRebuildAPI',
      mode: 'http-stream',
      integrated: true
    });
  });

  // 重建端点
  args.app.get('/api/rebuild', async (req: any, res: any) => {
    const padId = req.query.padId;
    const startRev = req.query.startRev ? parseInt(req.query.startRev) : null;
    const endRev = req.query.endRev ? parseInt(req.query.endRev) : null;
    const useBase64 = req.query.useBase64 === 'true' || req.query.useBase64 === '1';

    if (!padId) {
      return res.status(400).json({ error: 'Missing padId parameter' });
    }

    try {
      // 设置响应头，支持流式传输
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache');

      // 开始流式传输 JSON
      await streamRebuildPadContent(res, padId, startRev, endRev, useBase64);
      
      res.end();
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message,
        stack: error.stack
      });
    }
  });

  cb();
};
