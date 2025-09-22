DROP TABLE IF EXISTS `etherpad_pad_version`;
CREATE TABLE `etherpad_pad_version`  (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `pad_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Pad ID (如: room-229)',
  `revision` int NOT NULL COMMENT '版本号',
  `content` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL COMMENT '文本内容',
  `author` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL COMMENT '作者ID',
  `timestamp` bigint NULL DEFAULT NULL COMMENT '时间戳',
  `changeset` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL COMMENT '变更集',
  `create_time` datetime NULL DEFAULT CURRENT_TIMESTAMP COMMENT '数据创建时间',
  `change_description` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL COMMENT '变更内容描述',
  `change_position` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL COMMENT '变更位置(如: 第3行第5个词)',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `uk_pad_revision`(`pad_id` ASC, `revision` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 3349 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT = 'Pad版本数据表' ROW_FORMAT = DYNAMIC;
