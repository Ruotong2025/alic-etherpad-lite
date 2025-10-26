# Etherpad Changes - Version Tracking System

A comprehensive toolkit for Etherpad version tracking, diff calculation, and change history management.

**Location:** `src/node/scheduler/etherpad_changes/`

---

## 📁 Scripts Overview

| Script | Function | Run From | Dependencies |
|--------|----------|----------|--------------|
| `PadContentRebuild.js` | Rebuild pad content from store | `src/` directory | Etherpad modules |
| `PadContentMerge.js` | Merge consecutive edits | Any | settings.json |
| `generatePadVersionSnapshotsV3.js` | Generate version snapshots | Any | pad_version_contents_merge |
| `exportToChangesTable.js` | Export to changes table | Any | pad_version_snapshots |

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

### 3. `generatePadVersionSnapshotsV3.js` ⭐
Core snapshot generation script using `diff-match-patch` algorithm.
- Creates `pad_version_snapshots` table
- Tracks complete operation history (JSON format)
- Records author and timestamp for each add/delete operation

**Key Features:**
- ✅ Accurate text diff calculation
- ✅ Document segment management (normal + deleted)
- ✅ Operation history tracking (add/deleted)
- ✅ Hong Kong Time format (UTC+8)
- ✅ Automatic consecutive operation merging

### 4. `generatePadChanges.js`
Generates specific changes between versions from snapshot data.

### 5. `exportToChangesTable.js`
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
[generatePadVersionSnapshotsV3.js]
    ↓
pad_version_snapshots (with deletions_json)
    ↓
[exportToChangesTable.js]
    ↓
pad_version_changes
```

---

## 🚀 Quick Start

### Option 1: Full Pipeline (First Run)

```bash
# Step 1: Rebuild pad content
cd d:\ALIC\alic-etherpad-lite\src
node --require tsx/cjs node/scheduler/etherpad_changes/PadContentRebuild.js room-229

# Step 2: Merge consecutive edits
cd node/scheduler/etherpad_changes
node PadContentMerge.js room-229

# Step 3: Generate version snapshots
node generatePadVersionSnapshotsV3.js room-229

# Step 4: Export to changes table
node exportToChangesTable.js room-229
```

### Option 2: Update Only (Existing Data)

```bash
cd d:\ALIC\alic-etherpad-lite\src\node\scheduler\etherpad_changes

# Regenerate snapshots
node generatePadVersionSnapshotsV3.js room-229

# Update changes table
node exportToChangesTable.js room-229
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
