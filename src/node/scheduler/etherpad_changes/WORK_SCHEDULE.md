# Etherpad Changes - Monthly Work Schedule

**Duration:** 1 Month  
**Weekly Hours:** 17 hours  
**Total Hours:** ~68 hours

---

## Week 1: Foundation & Setup (17 hours)

### Day 1-2: Environment Setup (6h)
- Database configuration and connection testing
- Review Etherpad changeset architecture
- Set up development environment
- Test data backup and restore procedures

### Day 3-4: Data Extraction (7h)
- Implement `PadContentRebuild.js`
- Extract version data from store
- Apply changesets sequentially
- Create `pad_version_contents` table
- Initial data validation

### Day 5: Optimization (4h)
- Implement `PadContentMerge.js`
- Merge consecutive edits
- Create `pad_version_contents_merge` table
- Performance testing

---

## Week 2: Core Diff Engine (17 hours)

### Day 1-2: Diff Algorithm (8h)
- Integrate `diff-match-patch` library
- Implement text diff calculation
- Build document segment manager
- Handle insertions and deletions
- Position tracking and validation

### Day 3-4: Snapshot Generation (7h)
- Implement `generatePadVersionSnapshotsV3.js`
- Apply diffs to build snapshots
- Track operation history (JSON)
- Time format conversion (UTC+8)
- Merge consecutive operations

### Day 5: Testing & Debug (2h)
- Validation logic
- Edge case handling
- Debug mode implementation

---

## Week 3: Data Export & Queries (17 hours)

### Day 1-2: Export Module (6h)
- Implement `exportToChangesTable.js`
- Parse `deletions_json` field
- Create `pad_version_changes` table
- Insert operation records
- Data integrity checks

### Day 3-4: SQL Queries (7h)
- Design query templates
- Handle GROUP_CONCAT limitations
- Full text with deletion markers
- Pure text without markers
- JSON output format
- Performance optimization

### Day 5: Documentation (4h)
- Technical documentation
- API usage examples
- SQL query library
- Troubleshooting guide

---

## Week 4: Testing & Refinement (17 hours)

### Day 1-2: Comprehensive Testing (8h)
- Unit tests for each module
- Integration testing
- Performance benchmarking
- Large dataset testing
- Edge case validation

### Day 3: Bug Fixes (4h)
- Fix GROUP_CONCAT truncation
- Correct deletion marker placement
- Path configuration issues
- Time zone conversion bugs

### Day 4: Code Review & Optimization (3h)
- Code quality review
- Performance profiling
- Memory optimization
- Error handling improvements

### Day 5: Final Documentation (2h)
- Complete README
- Work schedule summary
- Deployment guide
- Maintenance procedures

---

## Deliverables

### Scripts (5 files)
- ✅ PadContentRebuild.js
- ✅ PadContentMerge.js
- ✅ generatePadVersionSnapshotsV3.js
- ✅ generatePadChanges.js
- ✅ exportToChangesTable.js

### Database Tables (4 tables)
- ✅ pad_version_contents
- ✅ pad_version_contents_merge
- ✅ pad_version_snapshots
- ✅ pad_version_changes

### Documentation (2 files)
- ✅ README.md (Technical guide)
- ✅ pad_version_changes_queries.sql (SQL templates)

### Key Features
- ✅ Accurate diff calculation
- ✅ Operation history tracking
- ✅ Author and timestamp recording
- ✅ Hong Kong Time formatting
- ✅ Consecutive operation merging
- ✅ Deletion marker support
- ✅ Query optimization

---

## Success Metrics

- **Code Quality**: Clean, maintainable, well-documented
- **Performance**: Process 100+ versions in < 10 seconds
- **Accuracy**: 100% text reconstruction validation
- **Usability**: Simple command-line interface
- **Reliability**: Proper error handling and logging

