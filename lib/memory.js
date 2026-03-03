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
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL,
      role        TEXT,
      instruction TEXT NOT NULL,
      result      TEXT,
      status      TEXT DEFAULT 'pending',
      created_at  DATETIME DEFAULT (datetime('now')),
      done_at     DATETIME
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

// ─── Tasks API ────────────────────────────────────────────────────────────────

/**
 * Insert a new task record with status='running'
 * @param {{ agentId: string, role?: string, instruction: string }} opts
 * @returns {string} generated task UUID
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
 * Mark a task as done/failed and store the result text
 * @param {string} taskId
 * @param {{ result?: string, status?: string }} opts
 */
export function updateTask(taskId, { result = null, status = 'done' }) {
  run(
    `UPDATE tasks SET result = ?, status = ?, done_at = datetime('now') WHERE id = ?`,
    result, status, taskId
  )
}

/**
 * Fetch N most recent tasks, optionally filtered to one agent
 * @param {number} limit
 * @param {string|null} agentId
 */
export function getRecentTasks(limit = 10, agentId = null) {
  if (agentId) {
    return all(
      `SELECT * FROM tasks WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`,
      agentId, limit
    )
  }
  return all(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`, limit)
}

/** Fetch a single task by ID */
export function getTask(taskId) {
  return get('SELECT * FROM tasks WHERE id = ?', taskId)
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
