# Pad 版本变更数据生成方案

## 📋 方案概述

本方案用于从 `pad_version_contents_merge` 表生成详细的版本变更数据，包括完整快照和精确的变更记录，支持任意版本的完整恢复。

## 🏗️ 数据流程架构

```
pad_version_contents_merge (已合并的版本数据)
    ↓ 逐版本对比处理
pad_version_snapshots (单一最新快照) + pad_version_changes (所有变更记录)
    ↓ 基于快照恢复
输出: 任意版本的完整内容
```

## 🗄️ 数据库表结构

### 表1: pad_version_snapshots (最新完整快照)

存储每个pad的最新完整快照，包含所有删除标记。

```sql
CREATE TABLE `pad_version_snapshots` (
  `pad_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL PRIMARY KEY COMMENT 'Pad ID',
  `latest_revision` int NOT NULL COMMENT '最新处理到的版本号',
  `full_content_with_deleted` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '包含删除标记的完整内容',
  `update_time` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT = 'Pad版本完整快照表';
```

### 表2: pad_version_changes (变更记录)

存储所有版本的变更记录，每个变更一条记录。

```sql
CREATE TABLE `pad_version_changes` (
  `pad_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Pad ID',
  `revision` int NOT NULL COMMENT '版本号',
  `change_type` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '变更类型 add/delete',
  `change_content` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '变更的具体内容',
  `change_position` int COMMENT '在完整快照中的字符位置',
  `author` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '作者ID',
  `timestamp` bigint COMMENT '操作时间戳',
  `update_time` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  INDEX `idx_pad_revision`(`pad_id`, `revision`),
  INDEX `idx_change_type`(`change_type`),
  INDEX `idx_author`(`author`)
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci COMMENT = 'Pad版本变更记录表';
```

## 🔄 核心处理逻辑

### 1. 逐版本构建快照

每处理一个版本变更，立即更新快照：

```
初始快照: ""
V1 → V2: 添加内容A → 快照: "A"
V2 → V3: 删除内容A，添加内容B → 快照: "[deleted:A]B"
V3 → V4: 添加内容C → 快照: "[deleted:A]BC"
V4 → V5: 删除内容B → 快照: "[deleted:A][deleted:B]C"
```

### 2. 增量更新策略

- **实时更新**: 每处理一个版本变更，立即更新快照
- **完整信息**: 快照始终包含当前版本的实际内容 + 所有历史删除内容的标记
- **统一基准**: 所有位置计算都基于包含删除标记的完整快照

### 3. 变更记录存储

- **精确位置**: 每个变更都记录其在最终快照中的精确位置
- **完整信息**: 包含变更类型、内容、作者、时间戳等完整信息
- **支持查询**: 支持按版本、作者、类型等多维度查询

## 🛠️ 使用方法

### 生成变更数据

```bash
# 处理单个pad
node src/node/scheduler/generatePadChanges.js <padId>

# 示例
node src/node/scheduler/generatePadChanges.js room-229
```

## 📊 处理流程示例

### 输入数据 (pad_version_contents_merge)
```
V1: "ABC"
V2: "AXBC"
V3: "AXC"
V4: "AXYC"
```

### 处理过程
```
处理 V1→V2:
- 差异: 添加 "X" at position 1
- 快照更新: "ABC" → "AXBC"
- 记录变更: {revision:2, type:'add', content:'X', position:1}

处理 V2→V3:
- 差异: 删除 "B" at position 2
- 快照更新: "AXBC" → "AX[deleted:B]C"
- 记录变更: {revision:3, type:'delete', content:'B', position:2}

处理 V3→V4:
- 差异: 添加 "Y" at position 2
- 快照更新: "AX[deleted:B]C" → "AX[deleted:B]YC"
- 记录变更: {revision:4, type:'add', content:'Y', position:13}
```

### 最终结果
```
pad_version_snapshots:
- pad_id: "test"
- latest_revision: 4
- full_content_with_deleted: "AX[deleted:B]YC"

pad_version_changes:
- {revision:2, type:'add', content:'X', position:1}
- {revision:3, type:'delete', content:'B', position:2}
- {revision:4, type:'add', content:'Y', position:13}
```

## 🔍 查询示例

### 重建完整快照
```sql
SELECT full_content_with_deleted
FROM pad_version_snapshots
WHERE pad_id = 'room-229';
```

### 查看特定版本的变更
```sql
SELECT * FROM pad_version_changes
WHERE pad_id = 'room-229' AND revision = 5
ORDER BY change_position;
```

### 按作者统计变更
```sql
SELECT
  author,
  change_type,
  COUNT(*) as count
FROM pad_version_changes
WHERE pad_id = 'room-229'
GROUP BY author, change_type;
```

### 查看变更时间线
```sql
SELECT
  revision,
  change_type,
  change_content,
  author,
  FROM_UNIXTIME(timestamp/1000) as change_time
FROM pad_version_changes
WHERE pad_id = 'room-229'
ORDER BY revision, change_position;
```

## ✨ 方案优势

1. **位置统一**: 所有位置都基于同一个完整快照，确保一致性
2. **删除可定位**: 删除内容通过标记保持位置信息，支持精确恢复
3. **增量更新**: 每个版本增量更新，处理效率高
4. **完整恢复**: 可以恢复任意历史版本的完整内容
5. **查询灵活**: 支持多维度查询和统计分析
6. **数据完整**: 保留所有变更的完整上下文信息

## 🔧 技术实现

### 关键算法

1. **版本差异计算**: 使用改进的LCS算法计算版本间差异
2. **快照增量更新**: 实时维护包含删除标记的完整快照
3. **位置精确计算**: 基于统一快照计算变更的精确位置
4. **版本恢复算法**: 根据变更历史恢复任意版本内容

### 性能优化

1. **增量处理**: 只处理变更的部分，避免全量重建
2. **索引优化**: 合理设计数据库索引，提高查询效率
3. **内存管理**: 大文本处理时的内存优化
4. **批量操作**: 批量插入变更记录，提高写入效率

## 📝 注意事项

1. **删除标记格式**: 使用 `[deleted:content]` 格式标记删除内容
2. **位置计算基准**: 所有位置都基于包含删除标记的完整快照
3. **版本顺序**: 必须按版本顺序处理，确保快照正确更新
4. **内容过滤**: 自动过滤只有空白字符变更的记录
5. **数据一致性**: 处理过程中确保快照和变更记录的一致性

## 🚀 扩展功能

1. **批量处理**: 支持批量处理多个pad
2. **增量同步**: 支持增量同步新版本
3. **数据导出**: 支持导出变更数据为各种格式
4. **可视化分析**: 提供变更数据的可视化分析工具
5. **API接口**: 提供RESTful API接口供外部调用
