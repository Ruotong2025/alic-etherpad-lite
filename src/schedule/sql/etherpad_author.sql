DROP TABLE IF EXISTS `etherpad_author`;
CREATE TABLE `etherpad_author`  (
  `author_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '作者 ID，去掉 globalAuthor: 前缀',
  `author_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL COMMENT '作者名称，JSON 中的 name 字段',
  `color_id` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL COMMENT '作者颜色，JSON 中的 colorId，用于 Etherpad 标识作者',
  `timestamp` bigint NULL DEFAULT NULL COMMENT '作者修改的时间',
  `created_time` datetime NULL DEFAULT NULL COMMENT '创建时间，JSON 中 timestamp 毫秒转 DATETIME',
  `padIDs` json NULL COMMENT '作者参与的 pad，JSON 对象，记录 pad ID 与 revision 数量',
  PRIMARY KEY (`author_id`) USING BTREE
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci COMMENT = 'Etherpad 作者信息表' ROW_FORMAT = DYNAMIC;
