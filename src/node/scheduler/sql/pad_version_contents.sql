-- Pad 版本内容表
-- 存储每个版本的完整文本内容

DROP TABLE IF EXISTS `pad_version_contents`;

CREATE TABLE `pad_version_contents` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '自增ID',
  `pad_id` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Pad ID',
  `revision` INT NOT NULL COMMENT '版本号',
  `content` LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '版本内容（完整文本）',
  `author_id` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '作者ID',
  `timestamp` BIGINT NOT NULL COMMENT '时间戳（毫秒）',
  `formatted_timestamp` VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '格式化时间戳（香港时区，格式：YYYY-MM-DD HH:mm:ss.SSS）',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '记录创建时间',
  `updated_at` TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP COMMENT '记录更新时间',
  
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE KEY `uk_pad_revision` (`pad_id`, `revision`) USING BTREE COMMENT '防止重复版本',
  KEY `idx_pad_id` (`pad_id`) USING BTREE COMMENT '按 Pad ID 查询',
  KEY `idx_timestamp` (`timestamp`) USING BTREE COMMENT '按时间戳查询',
  KEY `idx_formatted_timestamp` (`formatted_timestamp`) USING BTREE COMMENT '按格式化时间查询'
) ENGINE=InnoDB 
  DEFAULT CHARSET=utf8mb4 
  COLLATE=utf8mb4_unicode_ci 
  COMMENT='Pad版本内容表（存储每个版本的完整文本）' 
  ROW_FORMAT=DYNAMIC;

-- 示例查询
-- 1. 查询某个 Pad 的所有版本
-- SELECT pad_id, revision, formatted_timestamp, author_id, SUBSTRING(content, 1, 50) AS content_preview
-- FROM pad_version_contents
-- WHERE pad_id = 'room-229'
-- ORDER BY revision;

-- 2. 查询某个时间段的版本
-- SELECT pad_id, revision, formatted_timestamp, author_id
-- FROM pad_version_contents
-- WHERE formatted_timestamp BETWEEN '2025-09-20 00:00:00.000' AND '2025-09-21 00:00:00.000'
-- ORDER BY formatted_timestamp;

