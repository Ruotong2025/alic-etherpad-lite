# Etherpad Changes - Version Tracking System

A comprehensive toolkit for Etherpad version tracking, diff calculation, and change history management.

**Location:** `src/node/scheduler/etherpad_changes/`

---

## 📁 Scripts Overview

| Script | Function | Run From | Dependencies |
|--------|----------|----------|--------------|
| `PadContentRebuild.js` | Rebuild pad content from store | `src/` directory | Etherpad modules |
| `PadContentMerge.js` | Merge consecutive edits | Any | settings.json |
| `generatePadVersionSnapshots.js` | Generate version snapshots | Any | pad_version_contents, Python 3, NLTK |
| `exportToChangesTable.js` | Export to changes table | Any | pad_version_snapshots |
| `generatePadChanges.js` 🆕 | One-step changes generation (for comparison) | Any | pad_version_contents, Python 3, NLTK |
| `compare-changes-tables.js` 🆕 | Compare two changes tables | Any | MySQL |
| `SentenceSplitter.js` | Node.js wrapper for Python NLTK | N/A (library) | python-shell, sentence_splitter.py |
| `sentence_splitter.py` | Python NLTK sentence tokenizer | N/A (library) | NLTK |

### 1. `PadContentRebuild.js`
Rebuilds complete pad content from Etherpad's internal `store:*` data.
- Creates `pad_version_contents` table
- Applies changesets sequentially like timeslider
- Initializes version content data

### 2. `PadContentMerge.js`
Merges consecutive edits by the same author within short time windows.
- Creates `pad_version_contents_merge` table
- Reduces version fragmentation
- Improves processing performance

### 3. `generatePadVersionSnapshots.js` ⭐ (Compare Mode)
Core snapshot generation script using `diff-match-patch` algorithm with **NLTK sentence-level merge**.

**Data Flow:**
- **Data Source**: `pad_version_contents` (original versions)
- **Target Table**: `pad_version_snapshots` (standard snapshot table)

**Key Features:**
- ✅ Accurate text diff calculation
- ✅ Document segment management (normal + deleted)
- ✅ Operation history tracking (add/deleted)
- ✅ Hong Kong Time format (UTC+8)
- ✅ **NLTK-based sentence detection for smart merging**
- ✅ Python-Node.js integration via `python-shell`

**Merge Logic:**
When consecutive operations have the same `behavior` and `author`, the system attempts to merge them. However, if the merged content would create **2 or more sentences** (detected by NLTK), the operations are kept separate. This ensures each operation record represents a sentence-level edit.

**Example:**
```
Operation 1: "Hello world"        (1 sentence)
Operation 2: ". How are you?"     (would create 2 sentences)
Result: NOT merged (kept as separate operations)

Operation 1: "Hello"              (1 sentence)
Operation 2: " world"             (still 1 sentence)
Result: MERGED to "Hello world"
```

**Data Flow:**
```
pad_version_contents (原始版本)
       ↓
generatePadVersionSnapshots.js
       ↓
pad_version_snapshots (标准快照表)
       ↓
exportToChangesTable.js
       ↓
pad_version_changes (最终变更记录表)
```

### 4. `SentenceSplitter.js` & `sentence_splitter.py`
**New library components** for NLTK integration:
- `SentenceSplitter.js`: Node.js wrapper class that communicates with Python
- `sentence_splitter.py`: Python script using NLTK for sentence tokenization
- Supports English, Chinese, and mixed-language text
- Persistent Python process for performance

**API:**
```javascript
const SentenceSplitter = require('./SentenceSplitter');
const splitter = new SentenceSplitter();

// Count sentences in text
const count = await splitter.countSentences("Hello world. How are you?");
console.log(count); // 2

splitter.close(); // Clean up
```

### 5. `generatePadChanges.js` 🆕 (One-Step Generation)
Generates change records in one step, combining the functionality of `generatePadVersionSnapshots.js` + `exportToChangesTable.js`.

**⚠️ IMPORTANT:**
- **Data Source**: `pad_version_contents` (original versions)
- **Target Table**: `pad_version_changes_compare` (for comparison)
- **Purpose**: Verify algorithm correctness by comparing with standard two-step process

**Key Features:**
- ✅ Same diff algorithm as `generatePadVersionSnapshots.js`
- ✅ Same merge logic (NLTK sentence-level)
- ✅ Direct output to changes table (no intermediate snapshot table)
- ✅ Used for validation and comparison

**Usage:**
```bash
# Basic usage
node generatePadChanges.js room-229

# Debug mode
node generatePadChanges.js room-229 --debug
```

**Data Flow:**
```
pad_version_contents
    ↓
[generatePadChanges.js]
    ↓
pad_version_changes_compare
```

### 6. `compare-changes-tables.js` 🆕 (Verification Tool)
Compares `pad_version_changes` and `pad_version_changes_compare` tables to verify consistency.

**Features:**
- Compares record counts and statistics
- Validates reconstructed text
- Checks individual records
- Reports differences

**Usage:**
```bash
node compare-changes-tables.js room-229
```

**Typical Workflow:**
```bash
# Step 1: Standard two-step process
node generatePadVersionSnapshots.js room-229
node exportToChangesTable.js room-229

# Step 2: One-step process
node generatePadChanges.js room-229

# Step 3: Compare results
node compare-changes-tables.js room-229
```

### 7. `exportToChangesTable.js`
Exports operation history to structured change records.
- Parses `pad_version_snapshots.deletions_json`
- Creates `pad_version_changes` table
- Stores latest version's detailed change records

**Table Schema:**
```sql
CREATE TABLE pad_version_changes (
  id BIGINT AUTO_INCREMENT,
  pad_id VARCHAR(255),
  seq_order INT,                    -- Operation sequence
  behavior VARCHAR(20),              -- 'add' or 'deleted'
  author VARCHAR(255),               -- Author ID
  start_time VARCHAR(50),            -- Start time (HK Time)
  end_time VARCHAR(50),              -- End time (HK Time)
  content LONGTEXT,                  -- Operation content
  PRIMARY KEY (id),
  INDEX idx_pad_id(pad_id)
);
```

---

## 🔄 Data Flow

### Main Pipeline (Merged Versions)
```
Raw Data (store:*)
    ↓
[PadContentRebuild.js]
    ↓
pad_version_contents
    ↓
[PadContentMerge.js]
    ↓
pad_version_contents_merge
    ↓
[generatePadVersionSnapshots.js] ← Uses NLTK (sentence_splitter.py)
    ↓
pad_version_snapshots (with deletions_json)
    ↓
[exportToChangesTable.js]
    ↓
pad_version_changes
```

### Comparison Pipeline (Original Versions)
```
Raw Data (store:*)
    ↓
[PadContentRebuild.js]
    ↓
pad_version_contents (原始版本)
    ↓
[generatePadVersionSnapshots.js] ← Uses NLTK (sentence_splitter.py)
    ↓
pad_version_snapshots (标准快照表)
    ↓
[exportToChangesTable.js] ← Parse and flatten operations
    ↓
pad_version_changes (最终变更记录表)
```

---

## 🚀 Quick Start

### Prerequisites

Before running the scripts, ensure your environment is properly configured:

1. **Python 3.7+** with NLTK installed
2. **Node.js 14+** with required packages
3. **MySQL 5.7+** database accessible

**📖 For detailed setup instructions, see [ENVIRONMENT_SETUP.md](./ENVIRONMENT_SETUP.md)**

Quick setup:
```bash
# Install Python dependencies
pip3 install -r requirements.txt
python3 -c "import nltk; nltk.download('punkt')"

# Install Node.js dependencies
cd d:\ALIC\alic-etherpad-lite
pnpm add python-shell diff-match-patch

# Test NLTK integration
cd src/node/scheduler/etherpad_changes
node test-sentence-splitter.js
```

### Option 1: Compare Pipeline (Original Versions)

```bash
# Step 1: Rebuild pad content (if not already done)
cd d:\ALIC\alic-etherpad-lite\src
node --require tsx/cjs node/scheduler/etherpad_changes/PadContentRebuild.js room-229

# Step 2: Generate snapshots from original versions
cd node/scheduler/etherpad_changes
node generatePadVersionSnapshots.js room-229
# → Outputs to pad_version_snapshots

# Step 3: Export to changes table
node exportToChangesTable.js room-229
# → Outputs to pad_version_changes
```

### Option 2: Update Only (Existing Data)

```bash
cd d:\ALIC\alic-etherpad-lite\src\node\scheduler\etherpad_changes

# Regenerate snapshots (with NLTK)
node generatePadVersionSnapshots.js room-229

# Update changes table
node exportToChangesTable.js room-229
```

### Option 3: Test NLTK Integration

```bash
# Test sentence splitter
cd d:\ALIC\alic-etherpad-lite\src\node\scheduler\etherpad_changes
node test-sentence-splitter.js
```

---

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

Complete SQL queries: `C:\Users\Lenovo\Desktop\pad_version_changes_queries.sql`

---

## 🔧 Configuration

Database config (in each script):
```javascript
const DB_CONFIG = {
  host: '112.74.92.135',
  user: 'root',
  password: '1q2w3e4R',
  database: 'alic',
  charset: 'utf8mb4',
  port: 3306
};
```

### Path Notes
After moving to subfolder, paths have been updated:
- ✅ **PadContentMerge.js**: `settings.json` → `../../../../settings.json`
- ✅ **PadContentRebuild.js**: Uses `ep_etherpad-lite` modules (no change needed)
- ✅ **Other scripts**: Use independent DB config (no change needed)

---

## ⚠️ Important Notes

1. **PadContentRebuild.js** must run from `src/` directory (requires Etherpad modules)
2. Other scripts can run from any location (independent DB connections)
3. Execution order must follow data flow pipeline
4. All timestamps converted to Hong Kong Time (UTC+8)
5. Uses utf8mb4 encoding for emoji support
6. **GROUP_CONCAT limit**: MySQL default is 1024 bytes - must manually adjust

---

## 🐛 Troubleshooting

### Path Verification
```bash
cd d:\ALIC\alic-etherpad-lite\src\node\scheduler\etherpad_changes
node -p "require('path').resolve(__dirname, '../../../../settings.json')"
# Should output: D:\ALIC\alic-etherpad-lite\settings.json
```

### Debug Mode
```bash
node generatePadVersionSnapshotsV3.js --debug
```

### Common Issues
- **Cannot find settings.json**: Check path is `../../../../settings.json` (4 levels up)
- **Module not found**: `PadContentRebuild.js` must run from `src/` directory
- **GROUP_CONCAT truncation**: Run `SET SESSION group_concat_max_len = 10485760;` first

---

## 📅 Changelog

- **2025-10-26**: Fixed GROUP_CONCAT truncation issue
- **2025-10-26**: Removed revision field, store latest version only
- **2025-10-26**: Fixed Version 5 deletion marker placement
- **2025-10-26**: Integrated diff-match-patch algorithm
- **2025-10-24**: Initial version created
