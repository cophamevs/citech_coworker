/**
 * Memory layer — SQLite persistence for tasks, agent memories,
 * workflows, semantic memory, and usage tracking.
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

// ─── Event Bus (Phase 1) ─────────────────────────────────────────────────────
let _eventBus = null

/**
 * Inject the EventBus instance for event-driven notifications.
 * Called from index.js after initDB().
 */
export function setEventBus(bus) {
  _eventBus = bus
}

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

  // ── Phase 2: Workflow tables ──
  exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      steps       TEXT NOT NULL,
      created_at  DATETIME DEFAULT (datetime('now'))
    )
  `)
  exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id            TEXT PRIMARY KEY,
      workflow_id   TEXT NOT NULL,
      state         TEXT DEFAULT 'pending',
      input         TEXT,
      step_results  TEXT DEFAULT '[]',
      output        TEXT,
      error         TEXT,
      created_at    DATETIME DEFAULT (datetime('now')),
      updated_at    DATETIME DEFAULT (datetime('now'))
    )
  `)

  // ── Phase 3: Semantic memory ──
  exec(`
    CREATE TABLE IF NOT EXISTS semantic_memories (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT,
      content       TEXT NOT NULL,
      source        TEXT,
      scope         TEXT DEFAULT 'agent',
      confidence    REAL DEFAULT 1.0,
      metadata      TEXT DEFAULT '{}',
      accessed_at   DATETIME DEFAULT (datetime('now')),
      access_count  INTEGER DEFAULT 0,
      deleted       INTEGER DEFAULT 0,
      deleted_at    DATETIME,
      created_at    DATETIME DEFAULT (datetime('now'))
    )
  `)
  exec(`CREATE INDEX IF NOT EXISTS idx_semantic_agent ON semantic_memories(agent_id)`)
  exec(`CREATE INDEX IF NOT EXISTS idx_semantic_deleted ON semantic_memories(deleted)`)

  // Try FTS5, fallback silently if unavailable
  try {
    exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS semantic_fts USING fts5(
        content, content=semantic_memories, content_rowid=rowid
      )
    `)
    _fts5Available = true
  } catch {
    _fts5Available = false
    console.log('[memory] FTS5 not available — using LIKE fallback for semantic search')
  }

  // ── Phase 4: Usage tracking ──
  exec(`
    CREATE TABLE IF NOT EXISTS usage_records (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id       TEXT,
      model          TEXT,
      input_tokens   INTEGER DEFAULT 0,
      output_tokens  INTEGER DEFAULT 0,
      cost_usd       REAL DEFAULT 0,
      task_id        TEXT,
      created_at     DATETIME DEFAULT (datetime('now'))
    )
  `)
  exec(`CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage_records(agent_id)`)
  exec(`CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_records(created_at)`)

  // ── Migration: add columns that may be missing from older DBs ──
  migrateTasksTable()
}

let _fts5Available = false

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
 * Emits task.enqueued event.
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
  _eventBus?.publish('task.enqueued', { taskId: id, role, agentId, instruction: instruction.slice(0, 100) }, 'memory')
  return id
}

/**
 * Atomically claim the next pending task for an agent.
 * Picks highest-priority, oldest first. Optionally filters by role.
 * Emits task.claimed event.
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
  if (claimed) {
    _eventBus?.publish('task.claimed', { taskId: claimed.id, agentId }, 'memory')
  }
  return claimed || null
}

/**
 * Mark a task as done with result.
 * Emits task.completed event.
 */
export function completeTask(taskId, result) {
  run(
    `UPDATE tasks SET result = ?, status = 'done', done_at = datetime('now') WHERE id = ?`,
    result, taskId
  )
  const task = get('SELECT * FROM tasks WHERE id = ?', taskId)
  _eventBus?.publish('task.completed', { taskId, agentId: task?.agent_id, status: 'done' }, 'memory')
}

/**
 * Mark a task as failed with error message.
 * Emits task.failed event.
 */
export function failTask(taskId, error) {
  run(
    `UPDATE tasks SET error = ?, status = 'failed', done_at = datetime('now') WHERE id = ?`,
    error, taskId
  )
  const task = get('SELECT * FROM tasks WHERE id = ?', taskId)
  _eventBus?.publish('task.failed', { taskId, agentId: task?.agent_id, error }, 'memory')
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
 * Emits memory.updated event.
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
  _eventBus?.publish('memory.updated', { agentId, key, type: 'kv' }, 'memory')
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
 * Build the full context string (recent tasks + memories + semantic knowledge) for an agent.
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

  // Phase 3: Retrieve relevant semantic memories using last task instruction
  let semanticBlock = ''
  if (recent.length > 0) {
    const lastInstruction = recent[0].instruction
    try {
      const semanticResults = recallSemantic(lastInstruction, { agentId, limit: 5 })
      if (semanticResults.length > 0) {
        const lines = semanticResults.map(r => `- [${(r.confidence * 100).toFixed(0)}%] ${r.content.slice(0, 150)}`).join('\n')
        semanticBlock = `\n\n## Relevant Knowledge\n${lines}`
      }
    } catch { /* semantic search optional */ }
  }

  return `## Recent Tasks\n${taskSummary}\n\n${memBlock}${semanticBlock}`.trim()
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

// ─── Workflow Persistence (Phase 2) ───────────────────────────────────────────

export function saveWorkflowDef({ id = null, name, description = '', steps }) {
  const wfId = id || randomUUID()
  const stepsJson = typeof steps === 'string' ? steps : JSON.stringify(steps)
  // Upsert: replace if name conflict
  run(
    `INSERT OR REPLACE INTO workflows (id, name, description, steps) VALUES (?, ?, ?, ?)`,
    wfId, name, description, stepsJson
  )
  return wfId
}

export function getWorkflowDef(nameOrId) {
  const row = get(`SELECT * FROM workflows WHERE name = ? OR id = ?`, nameOrId, nameOrId)
  if (row && row.steps) {
    try { row.steps = JSON.parse(row.steps) } catch { /* keep as string */ }
  }
  return row
}

export function listWorkflowDefs() {
  return all(`SELECT id, name, description, created_at FROM workflows ORDER BY name ASC`)
}

export function saveWorkflowRun({ id = null, workflowId, input = '', state = 'pending' }) {
  const runId = id || randomUUID()
  run(
    `INSERT INTO workflow_runs (id, workflow_id, state, input) VALUES (?, ?, ?, ?)`,
    runId, workflowId, state, typeof input === 'string' ? input : JSON.stringify(input)
  )
  return runId
}

export function updateWorkflowRun(runId, { state, stepResults, output, error }) {
  const sets = []
  const params = []
  if (state !== undefined) { sets.push('state = ?'); params.push(state) }
  if (stepResults !== undefined) { sets.push('step_results = ?'); params.push(JSON.stringify(stepResults)) }
  if (output !== undefined) { sets.push('output = ?'); params.push(output) }
  if (error !== undefined) { sets.push('error = ?'); params.push(error) }
  sets.push("updated_at = datetime('now')")
  params.push(runId)
  run(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = ?`, ...params)
}

export function getWorkflowRun(runId) {
  const row = get(`SELECT * FROM workflow_runs WHERE id = ?`, runId)
  if (row) {
    try { row.step_results = JSON.parse(row.step_results || '[]') } catch { row.step_results = [] }
  }
  return row
}

export function listWorkflowRuns(limit = 20) {
  const rows = all(`SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT ?`, limit)
  for (const row of rows) {
    try { row.step_results = JSON.parse(row.step_results || '[]') } catch { row.step_results = [] }
  }
  return rows
}

// ─── Semantic Memory (Phase 3) ────────────────────────────────────────────────

/**
 * Store a semantic memory entry with full-text indexing.
 */
export function rememberSemantic({ agentId = null, content, source = 'task', scope = 'agent', metadata = {} }) {
  const id = randomUUID()
  const metaJson = typeof metadata === 'string' ? metadata : JSON.stringify(metadata)
  run(
    `INSERT INTO semantic_memories (id, agent_id, content, source, scope, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id, agentId, content, source, scope, metaJson
  )
  // Index in FTS5 if available
  if (_fts5Available) {
    try {
      run(`INSERT INTO semantic_fts (rowid, content) VALUES (last_insert_rowid(), ?)`, content)
    } catch { /* FTS insert failure is non-fatal */ }
  }
  _eventBus?.publish('memory.updated', { agentId, type: 'semantic', id }, 'memory')
  return id
}

/**
 * Recall semantic memories by search query.
 * Uses FTS5 MATCH if available, falls back to LIKE.
 */
export function recallSemantic(query, { agentId = null, limit = 10, minConfidence = 0.1 } = {}) {
  if (!query?.trim()) return []

  let rows
  const agentFilter = agentId ? `AND (sm.agent_id = ? OR sm.agent_id IS NULL)` : ''
  const agentParams = agentId ? [agentId] : []

  if (_fts5Available) {
    try {
      // FTS5 search
      const ftsQuery = query.trim().split(/\s+/).map(w => `"${w}"`).join(' OR ')
      rows = all(
        `SELECT sm.* FROM semantic_memories sm
         JOIN semantic_fts fts ON sm.rowid = fts.rowid
         WHERE fts.content MATCH ?
           AND sm.deleted = 0
           AND sm.confidence >= ?
           ${agentFilter}
         ORDER BY sm.confidence DESC, sm.accessed_at DESC
         LIMIT ?`,
        ftsQuery, minConfidence, ...agentParams, limit
      )
    } catch {
      rows = null // fallback to LIKE
    }
  }

  if (!rows) {
    // LIKE fallback
    const likePattern = `%${query.trim()}%`
    rows = all(
      `SELECT * FROM semantic_memories
       WHERE content LIKE ?
         AND deleted = 0
         AND confidence >= ?
         ${agentFilter}
       ORDER BY confidence DESC, accessed_at DESC
       LIMIT ?`,
      likePattern, minConfidence, ...agentParams, limit
    )
  }

  // Update access time and count for retrieved memories
  for (const row of rows) {
    try {
      run(
        `UPDATE semantic_memories SET accessed_at = datetime('now'), access_count = access_count + 1 WHERE id = ?`,
        row.id
      )
    } catch { /* non-fatal */ }
  }

  return rows
}

/**
 * Soft-delete a semantic memory.
 */
export function forgetSemantic(id) {
  run(
    `UPDATE semantic_memories SET deleted = 1, deleted_at = datetime('now') WHERE id = ?`,
    id
  )
}

/**
 * Run a raw SQL query (used by consolidation.js). Returns all rows.
 */
export function runQuery(sql, ...params) {
  return all(sql, ...params)
}

/**
 * Run a raw DML statement (used by consolidation.js).
 */
export function runExec(sql, ...params) {
  run(sql, ...params)
}

/** Expose FTS5 availability for consolidation */
export function isFts5Available() {
  return _fts5Available
}

// ─── Usage Tracking (Phase 4) ─────────────────────────────────────────────────

/**
 * Record a usage entry for token/cost tracking.
 */
export function recordUsage({ agentId, model = 'unknown', inputTokens = 0, outputTokens = 0, costUsd = 0, taskId = null }) {
  run(
    `INSERT INTO usage_records (agent_id, model, input_tokens, output_tokens, cost_usd, task_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    agentId, model, inputTokens, outputTokens, costUsd, taskId
  )
}

/**
 * Query total cost in the last N hours.
 */
export function queryHourlyCost(hours = 1) {
  const row = get(
    `SELECT COALESCE(SUM(cost_usd), 0) as total FROM usage_records
     WHERE created_at >= datetime('now', ? || ' hours')`,
    `-${hours}`
  )
  return row?.total ?? 0
}

/**
 * Query total cost in the last N days.
 */
export function queryDailyCost(days = 1) {
  const row = get(
    `SELECT COALESCE(SUM(cost_usd), 0) as total FROM usage_records
     WHERE created_at >= datetime('now', ? || ' days')`,
    `-${days}`
  )
  return row?.total ?? 0
}

/**
 * Query full usage summary.
 */
export function queryUsageSummary() {
  return {
    hourly: queryHourlyCost(1),
    daily: queryDailyCost(1),
    weekly: queryDailyCost(7),
    total: get(`SELECT COALESCE(SUM(cost_usd), 0) as total FROM usage_records`)?.total ?? 0,
    totalTokens: get(`SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total FROM usage_records`)?.total ?? 0,
  }
}

/**
 * Query usage breakdown by agent.
 */
export function queryUsageByAgent() {
  return all(
    `SELECT agent_id,
            SUM(input_tokens) as total_input,
            SUM(output_tokens) as total_output,
            SUM(cost_usd) as total_cost,
            COUNT(*) as request_count
     FROM usage_records
     GROUP BY agent_id
     ORDER BY total_cost DESC`
  )
}
