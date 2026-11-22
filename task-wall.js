// task-wall.js - Dynamic Event-Driven Task Wall & Deadlock Watchdog
// Inspired by AI Team OS (CronusL-1141/AI-company) task loop & board architecture.
//
// Manages fine-grained multi-agent task boards, dependency resolution,
// deadlock detection, and timeout watchdog patrols.

'use strict';

const crypto = require('crypto');

function createTaskWall({ tasks = [] } = {}) {
  // Map of taskId -> task object
  const taskMap = new Map();

  for (const t of tasks) {
    taskMap.set(t.id, { ...t });
  }

  /**
   * Creates a new task on the wall.
   */
  function createTask({
    id = null,
    title,
    description = '',
    assignedTo = null,
    dependencies = [],
    metadata = {}
  }) {
    if (!title) throw new Error('title is required for task');

    const taskId = id || 'task-' + crypto.randomBytes(4).toString('hex');
    const task = {
      id: taskId,
      title: title.trim(),
      description: description.trim(),
      status: dependencies.length > 0 ? 'blocked' : 'pending',
      assignedTo,
      dependencies: Array.isArray(dependencies) ? Array.from(new Set(dependencies)) : [],
      metadata,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    taskMap.set(taskId, task);
    _reconcileTaskState(taskId);
    return taskMap.get(taskId);
  }

  /**
   * Internal helper to reconcile blocked/pending states based on dependency completion.
   */
  function _reconcileTaskState(taskId) {
    const task = taskMap.get(taskId);
    if (!task || task.status === 'done' || task.status === 'in_progress') return;

    if (!task.dependencies || task.dependencies.length === 0) {
      if (task.status === 'blocked') task.status = 'pending';
      return;
    }

    const unfinished = task.dependencies.filter((depId) => {
      const dep = taskMap.get(depId);
      return !dep || dep.status !== 'done';
    });

    if (unfinished.length > 0) {
      task.status = 'blocked';
    } else if (task.status === 'blocked') {
      task.status = 'pending';
    }
  }

  /**
   * Reconciles all dependent tasks when a task is updated or marked done.
   */
  function _reconcileAll() {
    for (const [id] of taskMap) {
      _reconcileTaskState(id);
    }
  }

  /**
   * Claims a task for an agent/worker.
   */
  function claimTask(taskId, workerId) {
    const task = taskMap.get(taskId);
    if (!task) return { ok: false, error: 'Task not found' };

    _reconcileTaskState(taskId);

    if (task.status === 'blocked') {
      const blocking = task.dependencies.filter((d) => {
        const dep = taskMap.get(d);
        return !dep || dep.status !== 'done';
      });
      return {
        ok: false,
        error: 'Task is blocked by unfinished dependencies',
        blockedBy: blocking
      };
    }

    if (task.status === 'in_progress' && task.assignedTo !== workerId) {
      return { ok: false, error: `Task already claimed by ${task.assignedTo}` };
    }

    task.status = 'in_progress';
    task.assignedTo = workerId;
    task.updatedAt = new Date().toISOString();

    return { ok: true, task };
  }

  /**
   * Updates task status or attributes.
   */
  function updateTask(taskId, updates = {}) {
    const task = taskMap.get(taskId);
    if (!task) return { ok: false, error: 'Task not found' };

    if (updates.status) task.status = updates.status;
    if (updates.assignedTo !== undefined) task.assignedTo = updates.assignedTo;
    if (updates.result !== undefined) task.result = updates.result;
    if (updates.metadata) task.metadata = { ...task.metadata, ...updates.metadata };

    task.updatedAt = new Date().toISOString();

    // If marked done, unblock dependent tasks
    if (task.status === 'done') {
      _reconcileAll();
    }

    return { ok: true, task };
  }

  /**
   * Detects circular dependencies (deadlocks) in the task graph.
   * Uses Depth-First Search with visited and recursion stacks.
   */
  function detectDeadlocks() {
    const visited = new Set();
    const recStack = new Set();
    const cycles = [];

    function dfs(taskId, pathArr) {
      visited.add(taskId);
      recStack.add(taskId);
      pathArr.push(taskId);

      const task = taskMap.get(taskId);
      if (task && Array.isArray(task.dependencies)) {
        for (const depId of task.dependencies) {
          if (!visited.has(depId) && taskMap.has(depId)) {
            dfs(depId, [...pathArr]);
          } else if (recStack.has(depId)) {
            const cycleStartIdx = pathArr.indexOf(depId);
            const cycle = pathArr.slice(cycleStartIdx).concat(depId);
            cycles.push(cycle);
          }
        }
      }

      recStack.delete(taskId);
    }

    for (const [id] of taskMap) {
      if (!visited.has(id)) {
        dfs(id, []);
      }
    }

    return {
      hasDeadlock: cycles.length > 0,
      cycles
    };
  }

  /**
   * Watchdog: checks for stalled tasks in progress past threshold.
   */
  function checkStalls(timeoutMs = 600000) {
    const now = Date.now();
    const stalled = [];

    for (const [, task] of taskMap) {
      if (task.status === 'in_progress') {
        const lastUpdated = new Date(task.updatedAt).getTime();
        const duration = now - lastUpdated;
        if (duration >= timeoutMs) {
          stalled.push({
            taskId: task.id,
            title: task.title,
            assignedTo: task.assignedTo,
            durationMs: duration
          });
        }
      }
    }

    return stalled;
  }

  function getTasks() {
    return Array.from(taskMap.values());
  }

  function getSummary() {
    const counts = { pending: 0, in_progress: 0, blocked: 0, done: 0 };
    for (const [, task] of taskMap) {
      counts[task.status] = (counts[task.status] || 0) + 1;
    }
    return {
      total: taskMap.size,
      counts
    };
  }

  return {
    createTask,
    claimTask,
    updateTask,
    detectDeadlocks,
    checkStalls,
    getTasks,
    getSummary
  };
}

module.exports = {
  createTaskWall
};
