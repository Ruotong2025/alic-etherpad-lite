-- Pad 版本变更详细记录表（对比分析用）
-- 用于存储从 pad_version_contents 生成的操作历史
-- 每个操作（add/deleted）作为一行记录

DROP TABLE IF EXISTS `pad_version_changes_compare`;

CREATE TABLE `pad_version_changes_compare` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '自增ID',
  
  -- 基本信息
  `pad_id` VARCHAR(255) NOT NULL COMMENT 'Pad ID',
  `revision` INT NOT NULL COMMENT '最终版本号（用于追溯到哪个版本生成的）',
  `seq_order` INT NOT NULL COMMENT '操作顺序（从1开始，表示操作的先后顺序）',
  
  -- 操作信息
  `behavior` VARCHAR(20) NOT NULL COMMENT '操作类型：add（添加）或 deleted（删除）',
  `author` VARCHAR(255) NOT NULL COMMENT '作者ID（执行该操作的用户）',
  
  -- 时间信息
  `start_time` VARCHAR(50) NOT NULL COMMENT '开始时间（香港时间，格式：YYYY-MM-DD HH:mm:ss）',
  `end_time` VARCHAR(50) NOT NULL COMMENT '结束时间（香港时间，格式：YYYY-MM-DD HH:mm:ss）',
  
  -- 内容信息
  `content` LONGTEXT NOT NULL COMMENT '操作内容（添加的文本或删除的文本）',
  `content_length` INT COMMENT '内容长度（字符数）',
  
  -- 元数据
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '记录创建时间',
  
  -- 索引
  INDEX `idx_pad_id` (`pad_id`) COMMENT '按 Pad ID 查询',
  INDEX `idx_pad_revision` (`pad_id`, `revision`) COMMENT '按 Pad ID 和版本号查询',
  INDEX `idx_behavior` (`behavior`) COMMENT '按操作类型查询',
  INDEX `idx_author` (`author`) COMMENT '按作者查询',
  INDEX `idx_seq_order` (`pad_id`, `seq_order`) COMMENT '按操作顺序查询'
  
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci 
  COMMENT='Pad版本变更详细记录表（对比分析用）' 
  ROW_FORMAT=DYNAMIC;

-- 示例查询
-- 1. 查询某个 Pad 的所有变更记录（按操作顺序）
-- SELECT * FROM pad_version_changes_compare WHERE pad_id = 'room-229' ORDER BY seq_order;

-- 2. 统计某个 Pad 的添加和删除操作数量
-- SELECT behavior, COUNT(*) as count FROM pad_version_changes_compare WHERE pad_id = 'room-229' GROUP BY behavior;

-- 3. 查询某个作者的所有操作
-- SELECT * FROM pad_version_changes_compare WHERE author = 'a.xxxxxx' ORDER BY start_time;

-- 4. 查询某个时间范围内的操作
-- SELECT * FROM pad_version_changes_compare WHERE pad_id = 'room-229' AND start_time >= '2025-01-01 00:00:00' AND end_time <= '2025-12-31 23:59:59';

-- 5. 统计每个作者的贡献（添加的字符数）
-- SELECT author, SUM(content_length) as total_chars FROM pad_version_changes_compare WHERE pad_id = 'room-229' AND behavior = 'add' GROUP BY author;



