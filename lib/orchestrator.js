import { AgentSpawner } from './agent-spawner.js'
import { enqueueTask, getTask, getCompletedTasksForNotify, saveTask, updateTask, buildContextPrompt } from './memory.js'
import { withRetry } from './retry.js'



/**
 * Orchestrator — writes tasks to DB, watches for results
 */
export class Orchestrator {
    /**
     * @param {import('./registry.js').AgentRegistry} registry
     * @param {Object} config
     */
    constructor(registry, config = {}) {
        this.registry = registry
        this.config = config
        this._portCounter = config.portStart || 4096
        this._watcherTimer = null
        // Use SQLite-compatible format (space separator, no Z suffix)
        this._lastWatchTime = new Date().toISOString().replace('T', ' ').replace('Z', '')
        this._onTaskComplete = null  // callback: (task) => void
        this._notifiedTaskIds = new Set()  // prevent re-notification
    }

    // ─── Async Task Submission (DB-Centric) ───────────────────────────────

    /**
     * Submit a task to the DB queue (non-blocking).
     * Returns the taskId immediately. Agent will pick it up via worker loop.
     * @param {string} instruction
     * @param {{ role?: string, telegramChatId?: string, telegramMsgId?: string, priority?: number }} opts
     * @returns {string} taskId
     */
    submitTask(instruction, opts = {}) {
        const taskId = enqueueTask({
            instruction,
            role: opts.role || null,
            priority: opts.priority || 0,
            telegramChatId: opts.telegramChatId || null,
            telegramMsgId: opts.telegramMsgId || null
        })
        console.log(`[orchestrator] Task ${taskId} enqueued (role: ${opts.role || 'any'})`)
        return taskId
    }

    // ─── Watcher: poll DB for completed tasks ─────────────────────────────

    /**
     * Start watching the DB for completed tasks.
     * @param {(task: Object) => void} onComplete — called for each completed/failed task
     * @param {number} intervalMs — poll interval
     */
    startWatcher(onComplete, intervalMs = 2000) {
        this._onTaskComplete = onComplete
        this._lastWatchTime = new Date().toISOString().replace('T', ' ').replace('Z', '')
        this._notifiedTaskIds.clear()
        this._watcherTimer = setInterval(() => this._watcherTick(), intervalMs)
        console.log(`[orchestrator] Watcher started (poll every ${intervalMs}ms)`)
    }

    stopWatcher() {
        if (this._watcherTimer) {
            clearInterval(this._watcherTimer)
            this._watcherTimer = null
            console.log('[orchestrator] Watcher stopped')
        }
    }

    async _watcherTick() {
        if (!this._onTaskComplete) return

        try {
            const tasks = getCompletedTasksForNotify(this._lastWatchTime)
            // Filter out already-notified tasks
            const newTasks = tasks.filter(t => !this._notifiedTaskIds.has(t.id))

            if (newTasks.length > 0) {
                console.log(`[orchestrator] Watcher found ${newTasks.length} new completed task(s)`)
            }
            for (const task of newTasks) {
                try {
                    console.log(`[orchestrator] Notifying result for task ${task.id.slice(0, 8)} (status: ${task.status})`)
                    this._notifiedTaskIds.add(task.id)
                    await this._onTaskComplete(task)
                } catch (err) {
                    console.error(`[orchestrator] Callback error for task ${task.id}: ${err.message}`)
                }
            }
            // Update watermark
            if (tasks.length > 0) {
                this._lastWatchTime = tasks[tasks.length - 1].done_at
            }
            // Prevent memory leak — cap at 1000 tracked IDs
            if (this._notifiedTaskIds.size > 1000) {
                const ids = [...this._notifiedTaskIds]
                this._notifiedTaskIds = new Set(ids.slice(-500))
            }
        } catch (err) {
            console.error(`[orchestrator] Watcher tick error: ${err.message}`)
        }
    }

    /**
     * Get task status (for inline queries, status checks)
     */
    getTaskStatus(taskId) {
        return getTask(taskId)
    }

    // ─── Sync Task (Legacy / fallback) ────────────────────────────────────

    /**
     * Submit task and wait for result (blocking).
     * Used as fallback when async pattern is not suitable.
     * @returns {Promise<{ taskId: string, result: string, agentId: string }>}
     */
    async submitTaskSync(instruction, opts = {}) {
        const role = opts.role || 'orchestrator'

        // Find or spawn an agent
        const agent = opts.agentId
            ? this.registry.getById(opts.agentId)
            : (this.registry.getIdle(role) || this.registry.getIdle() || await this._spawnAgent(role))

        if (!agent) {
            throw new Error(`No agent available for role: ${role}`)
        }

        // Persist task (status = running)
        const taskId = saveTask({ agentId: agent.agentId, role, instruction })

        try {
            const outcome = await withRetry(
                () => agent._executeViaOpenCode(instruction),
                `task-${taskId}`,
                {
                    maxRetries: this.config.maxRetries || 3,
                    timeout: (this.config.taskTimeout || 300) * 1000
                }
            )

            if (outcome.type === 'delegate') {
                console.log(`[orchestrator] Delegating to role=${outcome.role}: ${outcome.instruction}`)
                const sub = await this.submitTaskSync(outcome.instruction, { role: outcome.role })
                const result = `[Delegated to ${outcome.role}]\n${sub.result}`
                updateTask(taskId, { result, status: 'done' })
                return { taskId, result, agentId: agent.agentId }
            }

            updateTask(taskId, { result: outcome.result, status: 'done' })
            return { taskId, result: outcome.result, agentId: agent.agentId }

        } catch (err) {
            updateTask(taskId, { result: err.message, status: 'failed' })
            throw err
        }
    }

    /**
     * Dynamically spawn a new agent for the given role
     */
    async _spawnAgent(role) {
        const port = this._portCounter++
        const agentId = `agent-${port}`
        const workdir = this.config.workdir || process.cwd()

        const memory = buildContextPrompt(agentId, this.config.memoryInjectCount || 5)

        const agent = new AgentSpawner({ agentId, port, role, workdir, memoryContext: memory })
        await agent.start()
        this.registry.register(agent)

        console.log(`[orchestrator] Spawned new ${role} agent: ${agentId} on port ${port}`)
        return agent
    }
}
