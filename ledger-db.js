// ledger-db.js - High-Performance Local SQLite WAL Ledger
// Inspired by AI Team OS (CronusL-1141/AI-company) SQLite WAL persistence.
//
// Uses Node 22 native node:sqlite DatabaseSync with Write-Ahead Logging (WAL)
// for sub-millisecond atomic audit logs, task states, and decision records.

'use strict';

const path = require('path');
const crypto = require('crypto');

let DatabaseSync;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (_) {
  DatabaseSync = null;
}

const DEFAULT_DB_PATH = path.resolve(__dirname, 'arunachala-ledger.db');

function createLedgerDB({ dbPath = DEFAULT_DB_PATH } = {}) {
  if (!DatabaseSync) {
    throw new Error('node:sqlite DatabaseSync is not available in this Node runtime');
  }

  const db = new DatabaseSync(dbPath);

  // Configure high-performance Write-Ahead Logging (WAL)
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      run_id TEXT,
      payload TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_records (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      assigned_to TEXT,
      dependencies TEXT,
      metadata TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decision_records (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      driver TEXT,
      approver TEXT,
      verdict TEXT,
      rule_text TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS direction_rules (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      target_id TEXT,
      title TEXT NOT NULL,
      rule_text TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      superseded_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Prepared statements
  const insertEventStmt = db.prepare(`
    INSERT INTO audit_events (id, type, run_id, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const selectEventsStmt = db.prepare(`
    SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?
  `);

  const selectRunEventsStmt = db.prepare(`
    SELECT * FROM audit_events WHERE run_id = ? ORDER BY created_at ASC
  `);

  const upsertTaskStmt = db.prepare(`
    INSERT INTO task_records (id, title, status, assigned_to, dependencies, metadata, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      status=excluded.status,
      assigned_to=excluded.assigned_to,
      dependencies=excluded.dependencies,
      metadata=excluded.metadata,
      updated_at=excluded.updated_at
  `);

  const selectTasksStmt = db.prepare(`SELECT * FROM task_records ORDER BY updated_at DESC`);

  const upsertDecisionStmt = db.prepare(`
    INSERT INTO decision_records (id, title, driver, approver, verdict, rule_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      driver=excluded.driver,
      approver=excluded.approver,
      verdict=excluded.verdict,
      rule_text=excluded.rule_text
  `);

  const selectDecisionsStmt = db.prepare(`SELECT * FROM decision_records ORDER BY created_at DESC`);

  const upsertDirectionRuleStmt = db.prepare(`
    INSERT INTO direction_rules (id, scope, target_id, title, rule_text, active, superseded_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      scope=excluded.scope,
      target_id=excluded.target_id,
      title=excluded.title,
      rule_text=excluded.rule_text,
      active=excluded.active,
      superseded_by=excluded.superseded_by,
      updated_at=excluded.updated_at
  `);

  const selectDirectionRulesStmt = db.prepare(`SELECT * FROM direction_rules ORDER BY created_at DESC`);

  function logEvent({ type, runId = null, payload = {} }) {
    const id = 'evt_' + crypto.randomBytes(6).toString('hex');
    const createdAt = new Date().toISOString();
    insertEventStmt.run(id, type, runId, JSON.stringify(payload), createdAt);
    return { id, type, runId, createdAt };
  }

  function getEvents({ runId = null, limit = 50 } = {}) {
    if (runId) {
      return selectRunEventsStmt.all(runId).map((row) => ({
        ...row,
        payload: JSON.parse(row.payload || '{}')
      }));
    }
    return selectEventsStmt.all(limit).map((row) => ({
      ...row,
      payload: JSON.parse(row.payload || '{}')
    }));
  }

  function saveTask(task) {
    const updatedAt = task.updatedAt || new Date().toISOString();
    upsertTaskStmt.run(
      task.id,
      task.title,
      task.status || 'pending',
      task.assignedTo || null,
      JSON.stringify(task.dependencies || []),
      JSON.stringify(task.metadata || {}),
      updatedAt
    );
    return task;
  }

  function loadTasks() {
    return selectTasksStmt.all().map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      assignedTo: row.assigned_to,
      dependencies: JSON.parse(row.dependencies || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
      updatedAt: row.updated_at
    }));
  }

  function saveDecision(decision) {
    const createdAt = decision.date || new Date().toISOString();
    upsertDecisionStmt.run(
      decision.id,
      decision.title,
      decision.driver || 'Specialist',
      decision.approver || 'Chairman',
      decision.verdict || 'RATIFIED',
      decision.summary || decision.rule || '',
      createdAt
    );
    return decision;
  }

  function loadDecisions() {
    return selectDecisionsStmt.all().map((row) => ({
      id: row.id,
      title: row.title,
      driver: row.driver,
      approver: row.approver,
      verdict: row.verdict,
      rule: row.rule_text,
      createdAt: row.created_at
    }));
  }

  function saveDirectionRule(rule) {
    const createdAt = rule.createdAt || new Date().toISOString();
    const updatedAt = rule.updatedAt || new Date().toISOString();
    upsertDirectionRuleStmt.run(
      rule.id,
      rule.scope || 'global',
      rule.targetId || null,
      rule.title,
      rule.ruleText,
      rule.active !== false ? 1 : 0,
      rule.supersededBy || null,
      createdAt,
      updatedAt
    );
    return rule;
  }

  function loadDirectionRules(filter = {}) {
    const rows = selectDirectionRulesStmt.all();
    return rows.map((row) => ({
      id: row.id,
      scope: row.scope,
      targetId: row.target_id,
      title: row.title,
      ruleText: row.rule_text,
      active: Boolean(row.active),
      supersededBy: row.superseded_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })).filter((r) => {
      if (filter.activeOnly && !r.active) return false;
      if (filter.scope && r.scope !== filter.scope) return false;
      if (filter.targetId && r.targetId !== filter.targetId) return false;
      return true;
    });
  }

  function close() {
    try {
      db.close();
    } catch (_) {}
  }

  return {
    logEvent,
    getEvents,
    saveTask,
    loadTasks,
    saveDecision,
    loadDecisions,
    saveDirectionRule,
    loadDirectionRules,
    close
  };
}

module.exports = {
  createLedgerDB,
  DEFAULT_DB_PATH
};
