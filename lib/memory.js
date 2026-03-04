/**
 * Memory layer — SQLite persistence for tasks and agent memories.
 *
 * Strategy (in order of preference):
 *  1. node:sqlite  (built-in, Node.js >= 22.5, no deps)
 *  2. node-sqlite3-wasm (pure WASM, works on any platform/arch)
 */
import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { dirname, resolve } from 'path'

let db = null
let adapter = null   // 'node' | 'wasm'

// ─── Adapter abstraction ──────────────────────────────────────────────────────

/** Execute a DDL statement (no params) */
function exec(sql) {
  if (adapter === 'node') {
    db.exec(sql)
  } else {
    db.run(sql)
  }
}

/** Execute a DML statement with positional params */
function run(sql, ...params) {
  if (adapter === 'node') {
    db.prepare(sql).run(...params)
  } else {
    db.run(sql, params)
  }
}

/** Query all rows */
function all(sql, ...params) {
  if (adapter === 'node') {
    return db.prepare(sql).all(...params)
  } else {
    const stmt = db.prepare(sql)
    if (params.length) stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  }
}

/** Query single row */
function get(sql, ...params) {
  return all(sql, ...params)[0] ?? null
}

// ─── Schema ───────────────────────────────────────────────────────────────────

function createSchema() {
  exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id               TEXT PRIMARY KEY,
      parent_id        TEXT,
      agent_id         TEXT,
      role             TEXT,
      instruction      TEXT NOT NULL,
      result           TEXT,
      error            TEXT,
      status           TEXT DEFAULT 'pending',
      priority         INTEGER DEFAULT 0,
      telegram_chat_id TEXT,
      telegram_msg_id  TEXT,
      created_at       DATETIME DEFAULT (datetime('now')),
      started_at       DATETIME,
      done_at          DATETIME
    )
  `)
  exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      expires_at  DATETIME,
      created_at  DATETIME DEFAULT (datetime('now'))
    )
  `)
  exec(`CREATE INDEX IF NOT EXISTS idx_tasks_agent    ON tasks(agent_id)`)
  exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status)`)
  exec(`CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id)`)

  // ── Migration: add columns that may be missing from older DBs ──
  migrateTasksTable()
}

function migrateTasksTable() {
  const cols = all(`PRAGMA table_info(tasks)`)
  const existing = new Set(cols.map(c => c.name))

  // ── Fix agent_id NOT NULL → nullable (SQLite can't ALTER COLUMN) ──
  const agentCol = cols.find(c => c.name === 'agent_id')
  if (agentCol && agentCol.notnull) {
    console.log('[memory] Migrating tasks table: agent_id NOT NULL → nullable...')
    exec(`ALTER TABLE tasks RENAME TO tasks_old`)
    exec(`
      CREATE TABLE tasks (
        id               TEXT PRIMARY KEY,
        parent_id        TEXT,
        agent_id         TEXT,
        role             TEXT,
        instruction      TEXT NOT NULL,
        result           TEXT,
        error            TEXT,
        status           TEXT DEFAULT 'pending',
        priority         INTEGER DEFAULT 0,
        telegram_chat_id TEXT,
        telegram_msg_id  TEXT,
        created_at       DATETIME DEFAULT (datetime('now')),
        started_at       DATETIME,
        done_at          DATETIME
      )
    `)
    // Copy old data (only columns that exist in old table)
    const oldCols = all(`PRAGMA table_info(tasks_old)`)
    const oldColNames = oldCols.map(c => c.name)
    const sharedCols = oldColNames.filter(c => ['id', 'agent_id', 'role', 'instruction', 'result', 'status', 'created_at', 'done_at'].includes(c))
    exec(`INSERT INTO tasks (${sharedCols.join(',')}) SELECT ${sharedCols.join(',')} FROM tasks_old`)
    exec(`DROP TABLE tasks_old`)
    exec(`CREATE INDEX IF NOT EXISTS idx_tasks_agent    ON tasks(agent_id)`)
    exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status)`)
    console.log('[memory] Migration complete: tasks table recreated')
    return  // schema is already up to date
  }

  // ── Add missing columns ──
  const additions = [
    ['parent_id', 'TEXT'],
    ['error', 'TEXT'],
    ['priority', 'INTEGER DEFAULT 0'],
    ['telegram_chat_id', 'TEXT'],
    ['telegram_msg_id', 'TEXT'],
    ['started_at', 'DATETIME'],
  ]
  for (const [col, type] of additions) {
    if (!existing.has(col)) {
      exec(`ALTER TABLE tasks ADD COLUMN ${col} ${type}`)
      console.log(`[memory] Migrated: added column tasks.${col}`)
    }
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Initialize the SQLite database. Must be awaited once at startup.
 * @param {string} dbFile  path to .db file
 */
export async function initDB(dbFile = './data/oc-plugin.db') {
  const absPath = resolve(dbFile)
  mkdirSync(dirname(absPath), { recursive: true })

  // Try Node.js built-in sqlite (v22.5+)
  try {
    const mod = await import('node:sqlite')
    db = new mod.DatabaseSync(absPath)
    adapter = 'node'
    console.log('[memory] Using node:sqlite (built-in)')
  } catch {
    // Fallback: node-sqlite3-wasm (pure WASM, no native compilation needed)
    try {
      const { Database } = await import('node-sqlite3-wasm')
      db = new Database(absPath)
      adapter = 'wasm'
      console.log('[memory] Using node-sqlite3-wasm (WASM fallback)')
    } catch (err) {
      throw new Error(`[memory] No SQLite backend available: ${err.message}`)
    }
  }

  createSchema()
  return db
}

/** Close the database connection */
export function closeDB() {
  if (db?.close) db.close()
  db = null
}

// ─── Tasks API (Legacy — backward-compatible) ────────────────────────────────

/**
 * Insert a new task record with status='running' (legacy direct-call pattern)
 */
export function saveTask({ agentId, role = null, instruction }) {
  const id = randomUUID()
  run(
    `INSERT INTO tasks (id, agent_id, role, instruction, status) VALUES (?, ?, ?, ?, 'running')`,
    id, agentId, role, instruction
  )
  return id
}

/**
 * Mark a task as done/failed and store the result text (legacy)
 */
export function updateTask(taskId, { result = null, status = 'done' }) {
  run(
    `UPDATE tasks SET result = ?, status = ?, done_at = datetime('now') WHERE id = ?`,
    result, status, taskId
  )
}

export function getRecentTasks(limit = 10, agentId = null) {
  if (agentId) {
    return all(
      `SELECT * FROM tasks WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`,
      agentId, limit
    )
  }
  return all(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`, limit)
}

export function getTask(taskId) {
  return get('SELECT * FROM tasks WHERE id = ?', taskId)
}

// ─── Tasks API (DB-Centric Queue) ────────────────────────────────────────────

/**
 * Enqueue a new task into the DB (status='pending').
 * @returns {string} task UUID
 */
export function enqueueTask({
  instruction,
  role = null,
  agentId = null,
  parentId = null,
  priority = 0,
  telegramChatId = null,
  telegramMsgId = null
}) {
  const id = randomUUID()
  run(
    `INSERT INTO tasks (id, parent_id, agent_id, role, instruction, status, priority, telegram_chat_id, telegram_msg_id)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    id, parentId, agentId, role, instruction, priority, telegramChatId, telegramMsgId
  )
  return id
}

/**
 * Atomically claim the next pending task for an agent.
 * Picks highest-priority, oldest first. Optionally filters by role.
 * @returns {Object|null} task row or null if none available
 */
export function claimTask(agentId, role = null) {
  const roleFilter = role ? `AND (role = ? OR role IS NULL)` : ''
  const params = role
    ? [role]
    : []

  const task = get(
    `SELECT * FROM tasks
     WHERE status = 'pending' ${roleFilter}
     ORDER BY priority DESC, created_at ASC
     LIMIT 1`,
    ...params
  )

  if (!task) return null

  // Claim it
  run(
    `UPDATE tasks SET agent_id = ?, status = 'running', started_at = datetime('now') WHERE id = ? AND status = 'pending'`,
    agentId, task.id
  )

  // Verify we actually got it (no race condition)
  const claimed = get(`SELECT * FROM tasks WHERE id = ? AND agent_id = ?`, task.id, agentId)
  return claimed || null
}

/**
 * Mark a task as done with result.
 */
export function completeTask(taskId, result) {
  run(
    `UPDATE tasks SET result = ?, status = 'done', done_at = datetime('now') WHERE id = ?`,
    result, taskId
  )
}

/**
 * Mark a task as failed with error message.
 */
export function failTask(taskId, error) {
  run(
    `UPDATE tasks SET error = ?, status = 'failed', done_at = datetime('now') WHERE id = ?`,
    error, taskId
  )
}

/**
 * Get all tasks with a given status.
 */
export function getTasksByStatus(status, limit = 50) {
  return all(`SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?`, status, limit)
}

/**
 * Get tasks that have been running too long (stuck).
 * @param {number} maxMinutes — max allowed run time in minutes
 */
export function getStuckTasks(maxMinutes = 10) {
  return all(
    `SELECT * FROM tasks
     WHERE status = 'running'
       AND started_at < datetime('now', ? || ' minutes')`,
    `-${maxMinutes}`
  )
}

/**
 * Reset stuck tasks back to 'pending' so they can be re-claimed.
 */
export function resetStuckTasks(maxMinutes = 10) {
  run(
    `UPDATE tasks SET status = 'pending', agent_id = NULL, started_at = NULL
     WHERE status = 'running'
       AND started_at < datetime('now', ? || ' minutes')`,
    `-${maxMinutes}`
  )
}

/**
 * Get recently completed tasks that have a telegram_chat_id (for notification).
 * Returns tasks completed since `sinceIso` that haven't been notified yet.
 */
export function getCompletedTasksForNotify(sinceIso) {
  return all(
    `SELECT * FROM tasks
     WHERE status IN ('done', 'failed')
       AND done_at >= ?
       AND telegram_chat_id IS NOT NULL
     ORDER BY done_at ASC`,
    sinceIso
  )
}

// ─── Memories API ─────────────────────────────────────────────────────────────

/**
 * Store a key-value memory entry.
 * agentId = null  → shared memory visible to all agents
 * @param {{ agentId?: string|null, key: string, value: string, expiresIn?: number }} opts
 */
export function saveMemory({ agentId = null, key, value, expiresIn = null }) {
  const expiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null
  run(
    `INSERT INTO memories (agent_id, key, value, expires_at) VALUES (?, ?, ?, ?)`,
    agentId, key, value, expiresAt
  )
}

/**
 * Build the memory block string to inject into role prompts.
 * Returns the N most recent non-expired entries for the agent + shared entries.
 * @param {string} agentId
 * @param {number} limit
 * @returns {string}
 */
export function buildMemoryBlock(agentId, limit = 5) {
  const now = new Date().toISOString()
  const rows = all(
    `SELECT key, value FROM memories
     WHERE (agent_id = ? OR agent_id IS NULL)
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY created_at DESC LIMIT ?`,
    agentId, now, limit
  )
  if (!rows.length) return ''
  const lines = rows.map(r => `- ${r.key}: ${r.value}`).join('\n')
  return `## Your Recent Memory (last ${rows.length} items)\n${lines}`
}

/**
 * Build the full context string (recent tasks + memories) for an agent.
 * Called when spawning an agent to pre-populate its system prompt.
 * @param {string} agentId
 * @param {number} memoryInjectCount
 * @returns {string}
 */
export function buildContextPrompt(agentId, memoryInjectCount = 5) {
  const recent = getRecentTasks(5, agentId).filter(t => t.status === 'done')
  const memBlock = buildMemoryBlock(agentId, memoryInjectCount)

  const taskSummary = recent.length
    ? recent.map(t => `- ${t.instruction} → ${(t.result ?? '').slice(0, 100)}`).join('\n')
    : 'No recent tasks.'

  return `## Recent Tasks\n${taskSummary}\n\n${memBlock}`.trim()
}

/**
 * Delete old memory entries for an agent, keeping the most recent N.
 * @param {string} agentId
 * @param {number} keepCount
 */
export function pruneMemory(agentId, keepCount = 50) {
  run(
    `DELETE FROM memories
     WHERE agent_id = ?
       AND id NOT IN (
         SELECT id FROM memories WHERE agent_id = ?
         ORDER BY created_at DESC LIMIT ?
       )`,
    agentId, agentId, keepCount
  )
}
