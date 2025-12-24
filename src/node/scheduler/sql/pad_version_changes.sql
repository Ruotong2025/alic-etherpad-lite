DROP TABLE IF EXISTS `pad_version_changes`;
CREATE TABLE `pad_version_changes` (
  `pad_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Pad ID',
  `seq_order` int NOT NULL COMMENT '操作顺序（从1开始）',
  `behavior` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '操作类型：add 或 deleted',
  `author` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '作者ID',
  `content` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '操作内容',
  `add_start_time` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '内容添加开始时间（精确到毫秒）',
  `add_end_time` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '内容添加结束时间（精确到毫秒）',
  `delete_start_time` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '内容删除开始时间（精确到毫秒）',
  `delete_end_time` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '内容删除结束时间（精确到毫秒）',
  PRIMARY KEY (`pad_id`, `seq_order`) USING BTREE COMMENT 'pad_id和seq_order联合主键，保证唯一性'
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT = 'Pad版本变更详细记录表' ROW_FORMAT = Dynamic;



