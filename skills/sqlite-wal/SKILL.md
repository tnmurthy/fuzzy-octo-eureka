---
name: sqlite-wal
description: Guidelines for native Node 22 node:sqlite DatabaseSync with WAL mode and transaction safety.
triggers: [sqlite, wal, database, db, pragma, query, migration]
file_patterns: ["*.db", "*sqlite*", "*ledger*"]
---

# SQLite WAL Operations Guide

## Core Principles
1. Always enable WAL mode immediately after initialization:
   ```javascript
   db.exec('PRAGMA journal_mode = WAL;');
   db.exec('PRAGMA synchronous = NORMAL;');
   ```
2. Use prepared statements with parameter binding (? or @param) to prevent SQL injection.
3. Always close prepared statements or database instances cleanly during teardown.
4. For multi-statement modifications, wrap in transactions to preserve consistency.
