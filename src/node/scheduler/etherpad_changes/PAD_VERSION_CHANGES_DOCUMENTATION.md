# Pad Version Changes 表文档

## 📋 目录

- [概述](#概述)
- [表结构](#表结构)
- [字段说明](#字段说明)
- [数据流程](#数据流程)
- [排序规则](#排序规则)
- [合并规则](#合并规则)
- [SQL 查询示例](#sql-查询示例)
- [数据复原](#数据复原)
- [时间精度](#时间精度)

---

## 概述

`pad_version_changes` 表记录了 Etherpad 文档的详细编辑历史，包括每次添加（add）和删除（deleted）操作。该表通过解析 `pad_version_snapshots` 表中的 `deletions_json` 字段生成，提供了文档演变的完整时间线。

### 核心特性

- ✅ **毫秒级时间精度**：所有时间戳精确到毫秒（格式：`YYYY-MM-DD HH:mm:ss.SSS`）
- ✅ **智能合并**：相邻的相同作者、相同行为的操作会被智能合并
- ✅ **文档位置顺序**：按照文档的物理位置排序，反映真实的编辑流程
- ✅ **完整时间范围**：记录每个操作的开始和结束时间

---

## 表结构

```sql
CREATE TABLE IF NOT EXISTS pad_version_changes (
  id BIGINT AUTO_INCREMENT,
  pad_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Pad ID',
  seq_order INT NOT NULL COMMENT '操作顺序（从1开始）',
  behavior VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '操作类型：add 或 deleted',
  author VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '作者ID',
  content LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '操作内容',
  add_start_time VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '内容添加开始时间（精确到毫秒）',
  add_end_time VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '内容添加结束时间（精确到毫秒）',
  delete_start_time VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '内容删除开始时间（精确到毫秒）',
  delete_end_time VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '内容删除结束时间（精确到毫秒）',
  PRIMARY KEY (id) USING BTREE,
  INDEX idx_pad_id(pad_id ASC) USING BTREE
) COMMENT='Pad版本变更详细记录表（增量更新）' ROW_FORMAT=Dynamic;
```

---

## 字段说明

### 基础字段

| 字段名 | 类型 | 说明 | 示例 |
|--------|------|------|------|
| `id` | BIGINT | 主键，自增ID | `1`, `2`, `3` |
| `pad_id` | VARCHAR(255) | Pad的唯一标识符 | `room-229`, `room-243` |
| `seq_order` | INT | 操作的顺序号，从1开始递增 | `1`, `2`, `3` |
| `behavior` | VARCHAR(20) | 操作类型：`add`（添加）或 `deleted`（删除） | `add`, `deleted` |
| `author` | VARCHAR(255) | 执行操作的作者ID | `a.rVEwX679hNTTNivd` |
| `content` | LONGTEXT | 操作涉及的文本内容 | `Hong Kong is a vibrant city.` |

### 时间字段

所有时间字段均为 **香港时区（UTC+8）**，格式为 `YYYY-MM-DD HH:mm:ss.SSS`（精确到毫秒）。

| 字段名 | 适用操作 | 说明 | 示例 |
|--------|----------|------|------|
| `add_start_time` | `add`, `deleted` | 内容**首次添加**的开始时间 | `2025-09-17 23:39:12.431` |
| `add_end_time` | `add`, `deleted` | 内容**首次添加**的结束时间 | `2025-09-17 23:39:15.892` |
| `delete_start_time` | `deleted` | 内容**被删除**的开始时间 | `2025-09-20 22:15:52.139` |
| `delete_end_time` | `deleted` | 内容**被删除**的结束时间 | `2025-09-20 22:15:55.678` |

#### 时间字段的含义

```
┌─────────────────────────────────────────────────────────────┐
│                    操作类型：add                              │
├─────────────────────────────────────────────────────────────┤
│  add_start_time ────────► add_end_time                      │
│       │                        │                             │
│       └────────────────────────┘                             │
│         用户输入这段文本的时间范围                              │
│                                                              │
│  delete_start_time: NULL                                     │
│  delete_end_time: NULL                                       │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                  操作类型：deleted                            │
├─────────────────────────────────────────────────────────────┤
│  add_start_time ────────► add_end_time                      │
│       │                        │                             │
│       └────────────────────────┘                             │
│      这段文本最初被添加的时间范围                               │
│                                                              │
│  delete_start_time ────────► delete_end_time                │
│       │                           │                          │
│       └───────────────────────────┘                          │
│       这段文本被删除的时间范围                                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 数据流程

```
┌──────────────────────┐
│  pad_version_contents │  原始版本数据
│  (每个版本一行)        │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────┐
│  generatePadVersionSnapshots.js                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ 1. 读取所有版本                                      │  │
│  │ 2. 使用 diff-match-patch 计算差异                   │  │
│  │ 3. 构建 segments 数组（normal + deleted）           │  │
│  │ 4. 验证快照完整性                                    │  │
│  │ 5. 构建操作历史并智能合并                            │  │
│  │ 6. 生成 deletions_json                              │  │
│  └────────────────────────────────────────────────────┘  │
└──────────┬───────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────┐
│ pad_version_snapshots │  快照数据（包含 deletions_json）
│  (每个 pad 一行)      │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────┐
│  exportToChangesTable.js                                 │
│  ┌────────────────────────────────────────────────────┐  │
│  │ 1. 读取 deletions_json                              │  │
│  │ 2. 解析 JSON 数组                                    │  │
│  │ 3. 为每个操作分配 seq_order                          │  │
│  │ 4. 映射时间字段                                      │  │
│  │ 5. 插入到 pad_version_changes 表                    │  │
│  └────────────────────────────────────────────────────┘  │
└──────────┬───────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────┐
│  pad_version_changes  │  最终的变更记录表
│  (每个操作一行)        │
└──────────────────────┘
```

---

## 排序规则

### `seq_order` 的确定逻辑

`seq_order` 反映了文档的**物理位置顺序**，而非时间顺序。这样可以准确还原文档的结构。

```
文档结构示例：
┌─────────────────────────────────────────────────────────┐
│ seq_order: 1  │  behavior: add                          │
│ content: "Hong Kong is a vibrant city."                 │
│ position: 0-31                                          │
├─────────────────────────────────────────────────────────┤
│ seq_order: 2  │  behavior: deleted                      │
│ content: "It has a rich history."                       │
│ position: 32-56 (已删除，但占据位置)                     │
├─────────────────────────────────────────────────────────┤
│ seq_order: 3  │  behavior: add                          │
│ content: "The city offers amazing food."                │
│ position: 57-88                                         │
└─────────────────────────────────────────────────────────┘
```

### 排序原则

1. **位置优先**：按照内容在文档中的物理位置排序
2. **删除占位**：`deleted` 片段占据位置，后续的 `add` 操作会排在其后
3. **版本递增**：同一位置的多个操作按版本号排序

### 排序流程图

```
开始处理版本 N
    │
    ▼
计算与版本 N-1 的差异
    │
    ├─► 发现插入操作 ──► 在 segments 数组的对应位置插入
    │                   （如果位置有 deleted 片段，插入到其后）
    │
    ├─► 发现删除操作 ──► 将对应的 normal 片段标记为 deleted
    │                   （保留在原位置，不移除）
    │
    ▼
继续处理版本 N+1
```

---

## 合并规则

为了减少冗余记录并提高可读性，系统会智能合并相邻的操作。合并过程使用 **NLTK (Natural Language Toolkit)** 进行句子边界检测，确保合并后的内容仍然是单个句子。

### 合并条件详解

两个相邻操作会被合并，当且仅当**同时满足**以下所有条件：

| 序号 | 条件 | 检查方式 | 说明 |
|------|------|----------|------|
| 1️⃣ | **相同 behavior** | `current.behavior === operation.behavior` | 都是 `add` 或都是 `deleted` |
| 2️⃣ | **相同 author** | `current.author === operation.author` | 由同一作者执行 |
| 3️⃣ | **时间接近** | 计算时间间隔（毫秒） | 时间间隔 ≤ 10分钟（600,000毫秒） |
| 4️⃣ | **单句话** | 使用 NLTK 句子分割器 | 合并后的内容仍然是单个句子 |

### 条件详细说明

#### 条件 1️⃣: 相同 behavior

```javascript
// 代码检查
if (current.behavior !== operation.behavior) {
  // ❌ 不合并：一个是 add，一个是 deleted
  return false;
}
```

**示例**:
- ✅ `add` + `add` → 可以继续检查
- ✅ `deleted` + `deleted` → 可以继续检查
- ❌ `add` + `deleted` → 直接不合并

#### 条件 2️⃣: 相同 author

```javascript
// 代码检查
if (current.author !== operation.author) {
  // ❌ 不合并：不同作者的编辑
  return false;
}
```

**示例**:
- ✅ `a.rVEwX679hNTTNivd` + `a.rVEwX679hNTTNivd` → 可以继续检查
- ❌ `a.rVEwX679hNTTNivd` + `a.ni6xvsCFoJs9Rr1v` → 直接不合并

#### 条件 3️⃣: 时间接近

时间检查逻辑根据操作类型不同：

**对于 `add` 操作**:
```javascript
const currentStartTime = new Date(current.add_start_time).getTime();
const operationEndTime = new Date(operation.add_end_time).getTime();
const timeGap = Math.abs(operationEndTime - currentStartTime);

// 检查条件
if (currentStartTime <= operationEndTime && timeGap <= 600000) {
  // ✅ 时间条件满足
}
```

**对于 `deleted` 操作**:
```javascript
const currentEndTime = new Date(current.delete_end_time).getTime();
const operationStartTime = new Date(operation.delete_start_time).getTime();
const timeGap = Math.abs(operationStartTime - currentEndTime);

// 检查条件
if (operationStartTime <= currentEndTime && timeGap <= 600000) {
  // ✅ 时间条件满足
}
```

**示例**:
```
✅ 可合并：
  操作1 add_end_time:   22:47:32.456
  操作2 add_start_time: 22:47:33.789  (间隔 1.333 秒)

❌ 不合并：
  操作1 add_end_time:   22:47:00.000
  操作2 add_start_time: 23:00:00.000  (间隔 13 分钟)
```

#### 条件 4️⃣: 单句话（NLTK 句子分割）

这是最关键的条件，使用 Python NLTK 库进行智能句子边界检测。

```javascript
// 合并内容
const mergedContent = current.content + operation.content;

// 调用 NLTK 句子分割器
const sentenceCount = await this.sentenceSplitter.countSentences(mergedContent);

if (sentenceCount === 1) {
  // ✅ 合并后仍是单句话，可以合并
} else {
  // ❌ 合并后变成多句话，不合并
}
```

**NLTK 句子分割器工作原理**:

```python
# Python 端代码（sentence_splitter.py）
import nltk
from nltk.tokenize import sent_tokenize

def count_sentences(text):
    """使用 NLTK 计算句子数量"""
    sentences = sent_tokenize(text)
    return len(sentences)
```

**示例**:

```
✅ 单句话 - 可以合并：
  "Hong Kong" + " is a vibrant city."
  → "Hong Kong is a vibrant city."  (1 句)

❌ 多句话 - 不合并：
  "Hong Kong is great." + " I love it."
  → "Hong Kong is great. I love it."  (2 句)

✅ 单句话（带逗号）- 可以合并：
  "Hong Kong is a city" + ", which is very beautiful."
  → "Hong Kong is a city, which is very beautiful."  (1 句)

❌ 多句话（带问号）- 不合并：
  "What is Hong Kong?" + " It is a city."
  → "What is Hong Kong? It is a city."  (2 句)
```

### 时间间隔计算

#### 对于 `add` 操作

```
前一条操作的 add_start_time ≤ 后一条操作的 add_end_time
且
|后一条的 add_end_time - 前一条的 add_start_time| ≤ 600,000ms
```

```
操作1: add_start_time ────────► add_end_time
                                      │
                                      ▼
操作2:                        add_start_time ────────► add_end_time
                                      │
                                      └─ 时间间隔 ≤ 10分钟 ✅ 可合并
```

#### 对于 `deleted` 操作

```
后一条操作的 delete_start_time ≤ 前一条操作的 delete_end_time
且
|后一条的 delete_start_time - 前一条的 delete_end_time| ≤ 600,000ms
```

```
操作1: delete_start_time ────────► delete_end_time
                                           │
                                           ▼
操作2:                        delete_start_time ────────► delete_end_time
                                           │
                                           └─ 时间间隔 ≤ 10分钟 ✅ 可合并
```

### 合并后的时间处理

#### `add` 操作合并

```
合并前：
  操作1: add_start_time = 2025-10-21 22:47:30.123
         add_end_time   = 2025-10-21 22:47:32.456
  操作2: add_start_time = 2025-10-21 22:47:33.789
         add_end_time   = 2025-10-21 22:47:35.012

合并后：
  add_start_time = min(操作1.add_start_time, 操作2.add_start_time)
                 = 2025-10-21 22:47:30.123
  add_end_time   = max(操作1.add_end_time, 操作2.add_end_time)
                 = 2025-10-21 22:47:35.012
```

#### `deleted` 操作合并

```
合并前：
  操作1: add_start_time    = 2025-09-17 23:39:10.100
         add_end_time      = 2025-09-17 23:39:12.200
         delete_start_time = 2025-09-20 22:15:50.300
         delete_end_time   = 2025-09-20 22:15:52.400
  
  操作2: add_start_time    = 2025-09-17 23:39:13.500
         add_end_time      = 2025-09-17 23:39:15.600
         delete_start_time = 2025-09-20 22:15:53.700
         delete_end_time   = 2025-09-20 22:15:55.800

合并后：
  add_start_time    = min(操作1.add_start_time, 操作2.add_start_time)
                    = 2025-09-17 23:39:10.100
  add_end_time      = max(操作1.add_end_time, 操作2.add_end_time)
                    = 2025-09-17 23:39:15.600
  delete_start_time = min(操作1.delete_start_time, 操作2.delete_start_time)
                    = 2025-09-20 22:15:50.300
  delete_end_time   = max(操作1.delete_end_time, 操作2.delete_end_time)
                    = 2025-09-20 22:15:55.800
```

### 合并流程图（详细版）

```
┌─────────────────────────────────────────────────────────────────────┐
│                        开始遍历 segments                              │
│                    (按文档位置顺序遍历)                                │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │  读取下一个 segment   │
                  │  (operation)         │
                  └──────────┬───────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │ 是否有 current 操作？ │
                  └──────────┬───────────┘
                             │
               ┌─────────────┴─────────────┐
               │ 否 (第一个操作)            │ 是 (已有 current)
               ▼                           ▼
        ┌─────────────┐         ┌──────────────────────────────┐
        │ 设为 current │         │ 🔍 检查合并条件 1️⃣:           │
        │ 继续下一个   │         │ behavior 是否相同？           │
        └─────────────┘         │ current.behavior === operation.behavior │
                                └──────────┬───────────────────┘
                                           │
                              ┌────────────┴────────────┐
                              │ 否 (不同类型)            │ 是 (相同类型)
                              ▼                         ▼
                   ┌──────────────────┐    ┌──────────────────────────────┐
                   │ ❌ 不合并         │    │ 🔍 检查合并条件 2️⃣:           │
                   │ 保存 current     │    │ author 是否相同？             │
                   │ operation → current│  │ current.author === operation.author │
                   └──────────────────┘    └──────────┬───────────────────┘
                              │                        │
                              │           ┌────────────┴────────────┐
                              │           │ 否 (不同作者)            │ 是 (相同作者)
                              │           ▼                         ▼
                              │ ┌──────────────────┐    ┌──────────────────────────────┐
                              │ │ ❌ 不合并         │    │ 🔍 检查合并条件 3️⃣:           │
                              │ │ 保存 current     │    │ 时间是否接近？                │
                              │ │ operation → current│  │ (根据 behavior 类型计算)      │
                              │ └──────────────────┘    └──────────┬───────────────────┘
                              │           │                        │
                              │           │           ┌────────────┴────────────┐
                              │           │           │ 否 (时间间隔>10分钟)     │ 是 (时间接近)
                              │           │           ▼                         ▼
                              │           │ ┌──────────────────┐    ┌──────────────────────────────┐
                              │           │ │ ❌ 不合并         │    │ 🔍 检查合并条件 4️⃣:           │
                              │           │ │ 保存 current     │    │ 合并后是否仍是单句话？         │
                              │           │ │ operation → current│  │                              │
                              │           │ └──────────────────┘    │ mergedContent =              │
                              │           │           │             │   current.content +          │
                              │           │           │             │   operation.content          │
                              │           │           │             │                              │
                              │           │           │             │ ⚙️ 调用 NLTK 句子分割器:      │
                              │           │           │             │ sentenceCount =              │
                              │           │           │             │   countSentences(mergedContent)│
                              │           │           │             └──────────┬───────────────────┘
                              │           │           │                        │
                              │           │           │           ┌────────────┴────────────┐
                              │           │           │           │ 否 (多句话)              │ 是 (单句话)
                              │           │           │           ▼                         ▼
                              │           │           │ ┌──────────────────┐    ┌──────────────────────────────┐
                              │           │           │ │ ❌ 不合并         │    │ ✅ 合并成功！                 │
                              │           │           │ │ 保存 current     │    │                              │
                              │           │           │ │ operation → current│  │ 1. 合并内容:                  │
                              │           │           │ └──────────────────┘    │    current.content +=        │
                              │           │           │           │             │      operation.content       │
                              │           │           │           │             │                              │
                              │           │           │           │             │ 2. 更新时间范围:              │
                              │           │           │           │             │    add_start_time = min(...)  │
                              │           │           │           │             │    add_end_time = max(...)    │
                              │           │           │           │             │    (deleted 操作同样处理      │
                              │           │           │           │             │     delete_start/end_time)   │
                              │           │           │           │             │                              │
                              │           │           │           │             │ 3. 继续处理下一个 segment     │
                              │           │           │           │             └──────────────────────────────┘
                              │           │           │           │                        │
                              └───────────┴───────────┴───────────┴────────────────────────┘
                                                      │
                                                      ▼
                                           ┌──────────────────────┐
                                           │ 是否还有更多 segment？ │
                                           └──────────┬───────────┘
                                                      │
                                        ┌─────────────┴─────────────┐
                                        │ 是                        │ 否
                                        │                           ▼
                                        │              ┌──────────────────────────┐
                                        │              │ 保存最后的 current 到结果 │
                                        │              │ 返回合并后的操作历史       │
                                        │              └──────────────────────────┘
                                        │
                                        └──► 继续循环
```

### 合并决策树

```
                                  开始检查
                                     │
                      ┌──────────────┴──────────────┐
                      ▼                             ▼
            1️⃣ behavior 相同？                    ❌ 不合并
                      │ ✅
                      ▼
            2️⃣ author 相同？                      ❌ 不合并
                      │ ✅
                      ▼
            3️⃣ 时间接近 (≤10分钟)？               ❌ 不合并
                      │ ✅
                      ▼
            4️⃣ NLTK: 合并后是单句话？             ❌ 不合并
                      │ ✅
                      ▼
                  ✅ 执行合并
```

### 合并条件总结表

| 条件 | 检查内容 | 检查方式 | 通过条件 | 失败结果 |
|------|---------|---------|---------|---------|
| 1️⃣ **behavior** | 操作类型 | `current.behavior === operation.behavior` | 都是 `add` 或都是 `deleted` | ❌ 不合并，保存 current |
| 2️⃣ **author** | 作者ID | `current.author === operation.author` | 作者ID完全相同 | ❌ 不合并，保存 current |
| 3️⃣ **时间** | 时间间隔 | 根据 behavior 计算毫秒差 | ≤ 600,000ms (10分钟) | ❌ 不合并，保存 current |
| 4️⃣ **句子** | 句子数量 | NLTK `sent_tokenize()` | 合并后 = 1 句 | ❌ 不合并，保存 current |

**注意**: 
- 所有条件必须**同时满足**才能合并
- 任何一个条件不满足，立即停止检查，不合并
- 合并后更新时间范围（使用 `min` 和 `max`）

### 合并示例

#### 示例 1：成功合并

```
合并前：
┌──────────────────────────────────────────────────────────┐
│ seq_order: 1  │  behavior: add  │  author: user_A        │
│ content: "Hong Kong"                                     │
│ add_start_time: 2025-10-21 22:47:30.123                 │
│ add_end_time:   2025-10-21 22:47:32.456                 │
├──────────────────────────────────────────────────────────┤
│ seq_order: 2  │  behavior: add  │  author: user_A        │
│ content: " is a vibrant city."                           │
│ add_start_time: 2025-10-21 22:47:33.789                 │
│ add_end_time:   2025-10-21 22:47:35.012                 │
└──────────────────────────────────────────────────────────┘

合并后：
┌──────────────────────────────────────────────────────────┐
│ seq_order: 1  │  behavior: add  │  author: user_A        │
│ content: "Hong Kong is a vibrant city."                  │
│ add_start_time: 2025-10-21 22:47:30.123                 │
│ add_end_time:   2025-10-21 22:47:35.012                 │
└──────────────────────────────────────────────────────────┘
```

#### 示例 2：不合并（不同作者）

```
┌──────────────────────────────────────────────────────────┐
│ seq_order: 1  │  behavior: add  │  author: user_A        │
│ content: "Hong Kong"                                     │
├──────────────────────────────────────────────────────────┤
│ seq_order: 2  │  behavior: add  │  author: user_B  ❌    │
│ content: " is great."                                    │
└──────────────────────────────────────────────────────────┘
```

#### 示例 3：不合并（时间间隔过长）

```
┌──────────────────────────────────────────────────────────┐
│ seq_order: 1  │  behavior: add  │  author: user_A        │
│ add_end_time: 2025-10-21 22:47:00.000                   │
├──────────────────────────────────────────────────────────┤
│ seq_order: 2  │  behavior: add  │  author: user_A        │
│ add_start_time: 2025-10-21 23:00:00.000  ❌ (13分钟后)   │
└──────────────────────────────────────────────────────────┘
```

#### 示例 4：不合并（合并后变成多句话）

```
┌──────────────────────────────────────────────────────────┐
│ seq_order: 1  │  behavior: add  │  author: user_A        │
│ content: "Hong Kong is great."                           │
├──────────────────────────────────────────────────────────┤
│ seq_order: 2  │  behavior: add  │  author: user_A        │
│ content: " I love it."  ❌ (合并后变成2句话)              │
└──────────────────────────────────────────────────────────┘
```

---

## SQL 查询示例

### 1. 查询指定 Pad 的所有变更记录（按顺序）

```sql
SELECT 
  seq_order,
  behavior,
  author,
  SUBSTRING(content, 1, 50) AS content_preview,
  add_start_time,
  add_end_time,
  delete_start_time,
  delete_end_time
FROM pad_version_changes
WHERE pad_id = 'room-229'
ORDER BY seq_order ASC;
```

### 2. 查询某个作者的所有操作

```sql
SELECT 
  seq_order,
  behavior,
  SUBSTRING(content, 1, 50) AS content_preview,
  add_start_time
FROM pad_version_changes
WHERE pad_id = 'room-229'
  AND author = 'a.rVEwX679hNTTNivd'
ORDER BY seq_order ASC;
```

### 3. 查询所有删除操作

```sql
SELECT 
  seq_order,
  author,
  SUBSTRING(content, 1, 50) AS content_preview,
  add_start_time AS originally_added,
  delete_start_time AS deleted_at
FROM pad_version_changes
WHERE pad_id = 'room-229'
  AND behavior = 'deleted'
ORDER BY seq_order ASC;
```

### 4. 统计每个作者的操作次数

```sql
SELECT 
  author,
  COUNT(*) AS total_operations,
  SUM(CASE WHEN behavior = 'add' THEN 1 ELSE 0 END) AS add_count,
  SUM(CASE WHEN behavior = 'deleted' THEN 1 ELSE 0 END) AS delete_count
FROM pad_version_changes
WHERE pad_id = 'room-229'
GROUP BY author
ORDER BY total_operations DESC;
```

### 5. 查询某个时间段内的操作

```sql
SELECT 
  seq_order,
  behavior,
  author,
  SUBSTRING(content, 1, 50) AS content_preview,
  add_start_time
FROM pad_version_changes
WHERE pad_id = 'room-229'
  AND add_start_time >= '2025-09-20 00:00:00.000'
  AND add_start_time <= '2025-09-30 23:59:59.999'
ORDER BY seq_order ASC;
```

### 6. 查询操作的时间间隔

```sql
SELECT 
  t1.seq_order,
  t1.behavior,
  t1.add_start_time,
  t2.add_start_time AS next_add_start_time,
  TIMESTAMPDIFF(SECOND, 
    STR_TO_DATE(t1.add_start_time, '%Y-%m-%d %H:%i:%s.%f'),
    STR_TO_DATE(t2.add_start_time, '%Y-%m-%d %H:%i:%s.%f')
  ) AS seconds_gap
FROM pad_version_changes t1
LEFT JOIN pad_version_changes t2 
  ON t1.pad_id = t2.pad_id 
  AND t1.seq_order + 1 = t2.seq_order
WHERE t1.pad_id = 'room-229'
ORDER BY t1.seq_order ASC;
```

---

## 数据复原

### 复原当前可见文本

要复原文档的当前可见内容（即排除所有 `deleted` 操作），使用以下 SQL：

```sql
SELECT 
  seq_order,
  content
FROM pad_version_changes
WHERE pad_id = 'room-229'
  AND behavior = 'add'
ORDER BY seq_order ASC;
```

### 复原包含删除标记的完整文档

如果需要看到完整的编辑历史（包括已删除的内容），可以使用以下格式：

```sql
SELECT 
  seq_order,
  CASE 
    WHEN behavior = 'deleted' THEN CONCAT('[DELETED: ', content, ']')
    ELSE content
  END AS formatted_content,
  behavior,
  author,
  add_start_time,
  delete_start_time
FROM pad_version_changes
WHERE pad_id = 'room-229'
ORDER BY seq_order ASC;
```

输出示例：

```
seq_order | formatted_content                                    | behavior
----------|------------------------------------------------------|----------
1         | [DELETED: This pad text is synchronized...]         | deleted
2         | [DELETED: *...]                                      | deleted
3         | 欢迎来到香港...                                        | add
4         | 香港是一个充满活力的国际大都市...                        | add
```

### 使用程序复原文档

```javascript
const mysql = require('mysql2/promise');

async function restoreDocument(padId) {
  const connection = await mysql.createConnection({
    host: '112.74.92.135',
    user: 'root',
    password: '1q2w3e4R',
    database: 'alic',
    charset: 'utf8mb4'
  });
  
  const [rows] = await connection.execute(
    `SELECT seq_order, behavior, content 
     FROM pad_version_changes 
     WHERE pad_id = ? 
     ORDER BY seq_order ASC`,
    [padId]
  );
  
  let document = '';
  
  for (const row of rows) {
    if (row.behavior === 'add') {
      document += row.content;
    }
    // deleted 操作不添加到最终文档
  }
  
  await connection.end();
  return document;
}

// 使用示例
restoreDocument('room-229').then(doc => {
  console.log('复原的文档内容：');
  console.log(doc);
});
```

---

## 时间精度

### 时间格式

所有时间字段使用统一格式：`YYYY-MM-DD HH:mm:ss.SSS`

- **时区**：香港时区（UTC+8）
- **精度**：毫秒（3位小数）
- **示例**：`2025-09-17 23:39:12.431`

### 时间解析

#### JavaScript 解析

```javascript
const timeStr = '2025-09-17 23:39:12.431';
const date = new Date(timeStr);
const milliseconds = date.getTime();

console.log(milliseconds); // 1726588752431
```

#### MySQL 解析

```sql
-- 转换为 DATETIME
SELECT STR_TO_DATE('2025-09-17 23:39:12.431', '%Y-%m-%d %H:%i:%s.%f') AS parsed_datetime;

-- 计算时间差（秒）
SELECT TIMESTAMPDIFF(SECOND, 
  STR_TO_DATE('2025-09-17 23:39:12.431', '%Y-%m-%d %H:%i:%s.%f'),
  STR_TO_DATE('2025-09-17 23:39:15.892', '%Y-%m-%d %H:%i:%s.%f')
) AS seconds_diff;
-- 结果: 3
```

#### Python 解析

```python
from datetime import datetime

time_str = '2025-09-17 23:39:12.431'
dt = datetime.strptime(time_str, '%Y-%m-%d %H:%M:%S.%f')
milliseconds = int(dt.timestamp() * 1000)

print(milliseconds)  # 1726588752431
```

### 验证时间精度

运行以下 SQL 验证所有时间戳都包含毫秒：

```sql
SELECT 
  COUNT(*) AS total_records,
  SUM(CASE WHEN add_start_time LIKE '%.___' THEN 1 ELSE 0 END) AS add_start_with_ms,
  SUM(CASE WHEN add_end_time LIKE '%.___' THEN 1 ELSE 0 END) AS add_end_with_ms,
  SUM(CASE WHEN delete_start_time LIKE '%.___' THEN 1 ELSE 0 END) AS delete_start_with_ms,
  SUM(CASE WHEN delete_end_time LIKE '%.___' THEN 1 ELSE 0 END) AS delete_end_with_ms
FROM pad_version_changes
WHERE pad_id = 'room-229';
```

预期结果：所有计数应该与对应的记录数匹配（100%）。

---

## 附录

### 相关脚本

| 脚本名称 | 功能 | 使用方法 |
|---------|------|---------|
| `generatePadVersionSnapshots.js` | 生成版本快照 | `node generatePadVersionSnapshots.js <padId>` |
| `exportToChangesTable.js` | 导出到变更表 | `node exportToChangesTable.js <padId>` |
| `test_millisecond_precision.js` | 测试毫秒精度 | `node test_millisecond_precision.js` |

### 数据表关系

```
pad_version_contents (原始版本数据)
    │
    ├─► generatePadVersionSnapshots.js
    │
    ▼
pad_version_snapshots (快照 + deletions_json)
    │
    ├─► exportToChangesTable.js
    │
    ▼
pad_version_changes (详细变更记录)
```

### 常见问题

#### Q1: 为什么 `deleted` 操作也有 `add_start_time` 和 `add_end_time`？

**A**: 因为被删除的内容曾经是被添加的。这两个字段记录了该内容**最初被添加时**的时间，帮助追踪内容的完整生命周期。

#### Q2: 如何判断一段内容被删除了多久？

**A**: 计算 `delete_start_time` 和 `add_start_time` 的时间差：

```sql
SELECT 
  content,
  add_start_time,
  delete_start_time,
  TIMESTAMPDIFF(DAY, 
    STR_TO_DATE(add_start_time, '%Y-%m-%d %H:%i:%s.%f'),
    STR_TO_DATE(delete_start_time, '%Y-%m-%d %H:%i:%s.%f')
  ) AS days_before_deletion
FROM pad_version_changes
WHERE pad_id = 'room-229'
  AND behavior = 'deleted'
ORDER BY days_before_deletion DESC;
```

#### Q3: 为什么 `seq_order` 不是按时间顺序？

**A**: `seq_order` 反映的是**文档的物理位置顺序**，而非时间顺序。这样设计是为了能够准确还原文档的结构。如果需要按时间顺序查看，可以使用 `add_start_time` 排序。

#### Q4: 合并操作会丢失信息吗？

**A**: 不会。合并时会保留时间范围（使用 `min` 和 `max`），所以时间信息是完整的。内容也是完整拼接的。

---

## 更新日志

| 日期 | 版本 | 更新内容 |
|------|------|---------|
| 2025-11-08 | v1.0 | 初始版本，包含毫秒精度支持 |

---

**文档维护**: Etherpad Changes Team  
**最后更新**: 2025-11-08

