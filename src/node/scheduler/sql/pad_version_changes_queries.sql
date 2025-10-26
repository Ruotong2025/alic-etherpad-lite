-- ============================================================================
-- Pad 版本变更表 - SQL 查询语句
-- 从 pad_version_changes 表复原文本
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 查询1：生成带 [deleted:...] 标记的完整文本（显示所有历史删除）
-- ----------------------------------------------------------------------------
-- 说明：将 add 和 deleted 操作按顺序拼接，deleted 操作用 [deleted:内容] 包裹
-- 用途：可以看到文档的完整编辑历史，包括被删除的内容

SELECT 
    pad_id,
    GROUP_CONCAT(
        CASE 
            WHEN behavior = 'add' THEN content
            WHEN behavior = 'deleted' THEN CONCAT('[deleted:', content, ']')
        END
        ORDER BY seq_order
        SEPARATOR ''
    ) AS full_text_with_deleted
FROM pad_version_changes
WHERE pad_id = 'room-229'
GROUP BY pad_id;


-- ----------------------------------------------------------------------------
-- 查询2：生成纯净文本（只显示当前内容，不包含删除的部分）
-- ----------------------------------------------------------------------------
-- 说明：只拼接 behavior='add' 的内容
-- 用途：获取文档当前的实际内容，不包含历史删除记录

SELECT 
    pad_id,
    GROUP_CONCAT(
        content
        ORDER BY seq_order
        SEPARATOR ''
    ) AS pure_text
FROM pad_version_changes
WHERE pad_id = 'room-229' 
  AND behavior = 'add'
GROUP BY pad_id;


-- ----------------------------------------------------------------------------
-- 查询3：同时显示两种格式（对比查看）
-- ----------------------------------------------------------------------------
-- 说明：一次性获取完整文本和纯净文本，方便对比

SELECT 
    pad_id,
    -- 带删除标记的完整文本
    GROUP_CONCAT(
        CASE 
            WHEN behavior = 'add' THEN content
            WHEN behavior = 'deleted' THEN CONCAT('[deleted:', content, ']')
        END
        ORDER BY seq_order
        SEPARATOR ''
    ) AS full_text_with_deleted,
    -- 纯净文本
    GROUP_CONCAT(
        CASE WHEN behavior = 'add' THEN content END
        ORDER BY seq_order
        SEPARATOR ''
    ) AS pure_text,
    -- 统计信息
    SUM(CASE WHEN behavior = 'add' THEN 1 ELSE 0 END) AS add_count,
    SUM(CASE WHEN behavior = 'deleted' THEN 1 ELSE 0 END) AS deleted_count,
    -- 字符数统计
    SUM(CASE WHEN behavior = 'add' THEN CHAR_LENGTH(content) ELSE 0 END) AS pure_text_length,
    SUM(CHAR_LENGTH(content)) AS total_content_length
FROM pad_version_changes
WHERE pad_id = 'room-229'
GROUP BY pad_id;


-- ----------------------------------------------------------------------------
-- 查询4：详细列表（显示每个操作的详细信息）
-- ----------------------------------------------------------------------------
-- 说明：查看每个操作的详细信息，包括作者、时间、内容预览

SELECT 
    seq_order AS '顺序',
    behavior AS '操作',
    SUBSTRING(author, 1, 20) AS '作者',
    start_time AS '开始时间',
    end_time AS '结束时间',
    CASE 
        WHEN behavior = 'add' THEN CONCAT('添加: ', SUBSTRING(content, 1, 50))
        WHEN behavior = 'deleted' THEN CONCAT('删除: ', SUBSTRING(content, 1, 50))
    END AS '操作摘要',
    CHAR_LENGTH(content) AS '内容长度'
FROM pad_version_changes
WHERE pad_id = 'room-229'
ORDER BY seq_order;


-- ----------------------------------------------------------------------------
-- 查询5：按作者分组统计
-- ----------------------------------------------------------------------------
-- 说明：统计每个作者的操作数量和内容长度

SELECT 
    author AS '作者',
    COUNT(*) AS '总操作数',
    SUM(CASE WHEN behavior = 'add' THEN 1 ELSE 0 END) AS '添加次数',
    SUM(CASE WHEN behavior = 'deleted' THEN 1 ELSE 0 END) AS '删除次数',
    SUM(CASE WHEN behavior = 'add' THEN CHAR_LENGTH(content) ELSE 0 END) AS '添加字符数',
    SUM(CASE WHEN behavior = 'deleted' THEN CHAR_LENGTH(content) ELSE 0 END) AS '删除字符数'
FROM pad_version_changes
WHERE pad_id = 'room-229'
GROUP BY author;


-- ----------------------------------------------------------------------------
-- 查询6：生成 JSON 格式（用于 API 返回）
-- ----------------------------------------------------------------------------
-- 说明：返回完整的 JSON 对象，包含文本和操作列表

SELECT 
    JSON_OBJECT(
        'pad_id', pad_id,
        'full_text', GROUP_CONCAT(
            CASE 
                WHEN behavior = 'add' THEN content
                WHEN behavior = 'deleted' THEN CONCAT('[deleted:', content, ']')
            END
            ORDER BY seq_order
            SEPARATOR ''
        ),
        'pure_text', GROUP_CONCAT(
            CASE WHEN behavior = 'add' THEN content END
            ORDER BY seq_order
            SEPARATOR ''
        ),
        'statistics', JSON_OBJECT(
            'total_operations', COUNT(*),
            'add_operations', SUM(CASE WHEN behavior = 'add' THEN 1 ELSE 0 END),
            'deleted_operations', SUM(CASE WHEN behavior = 'deleted' THEN 1 ELSE 0 END)
        ),
        'operations', (
            SELECT JSON_ARRAYAGG(
                JSON_OBJECT(
                    'seq_order', seq_order,
                    'behavior', behavior,
                    'author', author,
                    'start_time', start_time,
                    'end_time', end_time,
                    'content', content
                )
            )
            FROM pad_version_changes AS inner_table
            WHERE inner_table.pad_id = outer_table.pad_id
            ORDER BY seq_order
        )
    ) AS result_json
FROM pad_version_changes AS outer_table
WHERE pad_id = 'room-229'
GROUP BY pad_id;


-- ============================================================================
-- 使用示例和说明
-- ============================================================================

/*
【查询1 - 带删除标记的完整文本】
结果示例：
[deleted:*]欢迎来到Welcome to Etherpad!

[deleted:This pad text...]周末去哪里玩
可以去迪士尼[deleted:二元]乐园...

用途：
- 显示文档的完整编辑历史
- 可以看到哪些内容被删除了
- 适合用于审计和历史追踪


【查询2 - 纯净文本】
结果示例：
欢迎来到Welcome to Etherpad!

周末去哪里玩
可以去迪士尼乐园或者海洋公园...

用途：
- 获取文档当前的实际内容
- 不包含任何历史删除记录
- 适合用于展示和导出


【查询3 - 对比查看】
同时返回两种格式 + 统计信息

用途：
- 一次性获取所有信息
- 方便对比和分析


【查询4 - 详细列表】
显示每个操作的详细信息

用途：
- 查看操作时间线
- 分析编辑过程
- 审计追踪


【查询5 - 按作者统计】
统计每个作者的贡献

用途：
- 了解谁做了多少修改
- 统计协作情况


【查询6 - JSON 格式】
返回结构化的 JSON 数据

用途：
- API 接口返回
- 前端直接使用
- 数据交换


【批量查询所有 Pad】
如果要查询所有 Pad，只需移除 WHERE 子句：

SELECT 
    pad_id,
    GROUP_CONCAT(...) AS full_text_with_deleted
FROM pad_version_changes
GROUP BY pad_id;

*/


