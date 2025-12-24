DROP TABLE IF EXISTS `etherpad_pad_info`;
CREATE TABLE `etherpad_pad_info`  (
  `pad_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT 'Pad ID，去掉 pad: 前缀',
  `room_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL COMMENT 'roomName：房间名称，从 URL 参数获取',
  `full_text` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT 'atext.text：文本内容，pad 的全文本（带换行符），用户编辑内容',
  `attribs` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL COMMENT 'atext.attribs：文本属性，每个字符的属性编码，用于标记作者、样式等',
  `pool` json NULL COMMENT 'pool.numToAttrib：属性池，数字映射到属性名和作者 ID，例如 \"0\":[\"author\",\"a.jCyj8rIjIeyLD9CR\"] 表示作者',
  `next_num` int NULL DEFAULT NULL COMMENT 'pool.nextNum：下一个属性编号，用于分配新属性',
  `head` int NULL DEFAULT NULL COMMENT 'head：当前 head revision ID，pad 的最新修订号',
  `chat_head` int NULL DEFAULT NULL COMMENT 'chatHead：chat 历史 head，如果启用 pad 聊天功能，记录聊天的最新 revision',
  `public_status` tinyint(1) NULL DEFAULT NULL COMMENT 'publicStatus：是否公开，布尔值，pad 是否对公众可见',
  `saved_revisions` json NULL COMMENT 'savedRevisions：已保存的修订，数组，保存的历史 revision ID',
  `create_time` datetime NULL DEFAULT CURRENT_TIMESTAMP COMMENT '数据创建时间',
  `update_time` datetime NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '数据更新时间',
  PRIMARY KEY (`pad_id`) USING BTREE COMMENT 'pad_id作为主键，保证唯一性'
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci COMMENT = 'Pad基础信息表' ROW_FORMAT = DYNAMIC;
