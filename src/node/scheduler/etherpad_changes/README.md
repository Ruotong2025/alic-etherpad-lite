## 📊 SQL Queries

⚠️ **Important:** Set this before running queries to avoid truncation:
```sql
SET SESSION group_concat_max_len = 10485760;  -- 10MB
```

### Query Full Text (with deletion markers)
```sql
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
```

### Query Pure Text (no deletion markers)
```sql
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
```

### 原理介绍
====================================================================================================
📚 segments 数组的文档位置顺序原理
====================================================================================================

## 核心原理

segments 数组的顺序 = **文档中文本出现的从左到右的顺序**

这个顺序是通过 **插入位置（position）** 来维护的。

---

## 详细说明

### 1️⃣ 初始化（版本0）

```javascript
initialize(text, authorId, timestamp) {
  this.segments = [{
    type: 'normal',
    content: text,  // 整个文档作为一个片段
    version: 0,
    author: authorId,
    timestamp: timestamp
  }];
}
```

**示例：**
文档内容: "Hello World"

segments = [
{ type: 'normal', content: 'Hello World', version: 0 }
]

---

### 2️⃣ 插入操作（_applyInsertion）

**关键：position 是在 normal 文本中的位置（从左到右计数）**

```javascript
_applyInsertion(position, content, version, authorId, timestamp) {
  let currentPos = 0;

  // 遍历所有片段，找到插入位置
  for (let i = 0; i < this.segments.length; i++) {
    const segment = this.segments[i];

    // 只计算 normal 片段的位置
    if (segment.type !== 'normal') {
      continue;  // 跳过 deleted 片段
    }

    const segmentEndPos = currentPos + segment.content.length;

    if (position === currentPos) {
      // 在片段开头插入 → splice(i, 0, newSegment)
      this.segments.splice(i, 0, newSegment);
      return;
    } else if (position > currentPos && position < segmentEndPos) {
      // 在片段中间插入 → 分割成 [before, new, after]
      this.segments.splice(i, 1, beforeSegment, newSegment, afterSegment);
      return;
    }

    currentPos = segmentEndPos;
  }

  // 如果位置 = 总长度，追加到末尾
  if (position === totalNormalLength) {
    this.segments.push(newSegment);
  }
}
```

**示例：在位置6插入 " Beautiful"**

原文档: "Hello World"
position = 6（在 "World" 前）

操作：
1. currentPos = 0
2. 检查片段0: "Hello World"
  - segmentEndPos = 11
  - position (6) > currentPos (0) && position (6) < segmentEndPos (11)
  - **在片段中间插入！**
3. 分割：
  - before = "Hello " (0-6)
  - new = " Beautiful" (插入内容)
  - after = "World" (6-11)

结果 segments = [
{ type: 'normal', content: 'Hello ', version: 0 },
{ type: 'normal', content: ' Beautiful', version: 1 },  ← 新插入
{ type: 'normal', content: 'World', version: 0 }
]

**文档顺序：从左到右 = "Hello " + " Beautiful" + "World" = "Hello  Beautiful World"**

---

### 3️⃣ 删除操作（_applyDeletion）

**关键：删除不改变 segments 的顺序，只改变 type**

```javascript
_applyDeletion(position, length, version, authorId, timestamp) {
  let currentPos = 0;

  for (let i = 0; i < this.segments.length; i++) {
    const segment = this.segments[i];

    // 只计算 normal 片段的位置
    if (segment.type !== 'normal') {
      continue;
    }

    const segmentStart = currentPos;
    const segmentEnd = currentPos + segment.content.length;

    // 计算删除范围与片段的交集
    if (有交集) {
      if (删除整个片段) {
        // 标记为 deleted，但保持在原位置
        segment.type = 'deleted';
        segment.deletedAt = version;
      } else if (删除部分) {
        // 分割成 [保留部分, 删除部分]
        this.segments.splice(i, 1, keepSegment, deletedSegment);
      }
    }

    currentPos = segmentEnd;
  }
}
```

**示例：删除位置6-16（" Beautiful"）**

原文档: "Hello  Beautiful World"
删除范围: [6, 16)

操作：
1. 检查片段0: "Hello " (位置0-6)
  - 删除范围在片段之后，继续
2. 检查片段1: " Beautiful" (位置6-16)
  - 删除范围完全覆盖！
  - **标记为 deleted**
3. 检查片段2: "World" (位置16-21)
  - 删除范围在片段之前，结束

结果 segments = [
{ type: 'normal', content: 'Hello ', version: 0 },
{ type: 'deleted', content: ' Beautiful', version: 1, deletedAt: 2 },  ← 标记为删除
{ type: 'normal', content: 'World', version: 0 }
]

**注意：deleted 片段仍然保持在原位置！**

---

### 4️⃣ 复杂示例：多次编辑

**版本0:** "ABC"
segments = [
{ type: 'normal', content: 'ABC', version: 0 }
]

**版本1:** 在位置1插入 "X"
position = 1（在 'B' 前）
结果: "AXBC"
segments = [
{ type: 'normal', content: 'A', version: 0 },
{ type: 'normal', content: 'X', version: 1 },  ← 插入到位置1
{ type: 'normal', content: 'BC', version: 0 }
]

**版本2:** 在位置3插入 "Y"
position = 3（在 'C' 前）
结果: "AXYBC"

计算位置：
- 片段0 'A': currentPos = 0, endPos = 1
- 片段1 'X': currentPos = 1, endPos = 2
- 片段2 'BC': currentPos = 2, endPos = 4
  - position (3) 在这个片段中间！
  - 分割: 'B' + 'Y' + 'C'

segments = [
{ type: 'normal', content: 'A', version: 0 },
{ type: 'normal', content: 'X', version: 1 },
{ type: 'normal', content: 'B', version: 0 },
{ type: 'normal', content: 'Y', version: 2 },  ← 插入到位置3
{ type: 'normal', content: 'C', version: 0 }
]

**版本3:** 删除位置1-3（"XB"）
结果: "AYC"

segments = [
{ type: 'normal', content: 'A', version: 0 },
{ type: 'deleted', content: 'X', version: 1, deletedAt: 3 },  ← 标记删除，保持位置
{ type: 'deleted', content: 'B', version: 0, deletedAt: 3 },  ← 标记删除，保持位置
{ type: 'normal', content: 'Y', version: 2 },
{ type: 'normal', content: 'C', version: 0 }
]

**文档位置顺序 = 数组顺序 = 从左到右的文本顺序**

---

## ✅ 总结

**segments 数组的顺序由以下因素决定：**

1. **初始顺序**：版本0的文本从左到右
2. **插入操作**：
  - 根据 position 找到插入点
  - 使用 splice() 在正确的索引位置插入
  - 如果在片段中间，分割成 [before, new, after]
3. **删除操作**：
  - 不改变数组顺序
  - 只改变 type 为 'deleted'
  - deleted 片段保持在原位置

**关键点：**
- position 始终是在 **normal 文本** 中的位置（跳过 deleted 片段）
- segments 数组的顺序 = **文档中文本的从左到右顺序**
- 这个顺序在整个编辑过程中保持一致

