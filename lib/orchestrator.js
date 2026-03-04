import { AgentSpawner } from './agent-spawner.js'
import { enqueueTask, getTask, getCompletedTasksForNotify, saveTask, updateTask, buildContextPrompt } from './memory.js'
import { withRetry } from './retry.js'



/**
 * Orchestrator — writes tasks to DB, watches for results.
 * Phase 1: event-driven watcher via EventBus (replaces polling).
 * Phase 2: workflow execution via WorkflowEngine.
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
        this._eventBus = null
        this._watcherUnsubs = []  // event bus unsubscribe functions
        this.workflowEngine = null  // set from index.js
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

    // ─── Watcher: event-driven (Phase 1) with polling fallback ────────────

    /**
     * Start watching for completed tasks.
     * Uses EventBus (event-driven) if available, falls back to polling.
     * @param {(task: Object) => void} onComplete — called for each completed/failed task
     * @param {number|import('./event-bus.js').EventBus} intervalMsOrEventBus
     */
    startWatcher(onComplete, intervalMsOrEventBus = 2000) {
        this._onTaskComplete = onComplete
        this._lastWatchTime = new Date().toISOString().replace('T', ' ').replace('Z', '')
        this._notifiedTaskIds.clear()

        // Phase 1: Event-driven watcher
        if (intervalMsOrEventBus && typeof intervalMsOrEventBus === 'object' && intervalMsOrEventBus.on) {
            this._eventBus = intervalMsOrEventBus
            const unsub1 = this._eventBus.on('task.completed', (event) => {
                this._handleTaskEvent(event.payload.taskId)
            })
            const unsub2 = this._eventBus.on('task.failed', (event) => {
                this._handleTaskEvent(event.payload.taskId)
            })
            this._watcherUnsubs = [unsub1, unsub2]
            console.log(`[orchestrator] Watcher started (event-driven)`)
        } else {
            // Legacy polling fallback
            const intervalMs = typeof intervalMsOrEventBus === 'number' ? intervalMsOrEventBus : 2000
            this._watcherTimer = setInterval(() => this._watcherTick(), intervalMs)
            console.log(`[orchestrator] Watcher started (poll every ${intervalMs}ms)`)
        }
    }

    stopWatcher() {
        // Unsubscribe event bus listeners
        for (const unsub of this._watcherUnsubs) {
            unsub()
        }
        this._watcherUnsubs = []

        if (this._watcherTimer) {
            clearInterval(this._watcherTimer)
            this._watcherTimer = null
        }
        console.log('[orchestrator] Watcher stopped')
    }

    /**
     * Handle a task completion/failure event (event-driven path).
     */
    async _handleTaskEvent(taskId) {
        if (!this._onTaskComplete) return
        if (this._notifiedTaskIds.has(taskId)) return

        try {
            const task = getTask(taskId)
            if (!task) return
            if (!task.telegram_chat_id) return  // only notify Telegram tasks
            if (!['done', 'failed'].includes(task.status)) return

            this._notifiedTaskIds.add(taskId)
            console.log(`[orchestrator] Notifying result for task ${taskId.slice(0, 8)} (status: ${task.status})`)
            await this._onTaskComplete(task)

            // Prevent memory leak
            if (this._notifiedTaskIds.size > 1000) {
                const ids = [...this._notifiedTaskIds]
                this._notifiedTaskIds = new Set(ids.slice(-500))
            }
        } catch (err) {
            console.error(`[orchestrator] Event handler error for task ${taskId}: ${err.message}`)
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

    // ─── Workflow Submission (Phase 2) ─────────────────────────────────────

    /**
     * Submit a workflow for execution.
     * @param {string} workflowIdOrName
     * @param {string} input
     * @param {{ telegramChatId?: string }} opts
     * @returns {Promise<{ runId: string, output: string }>}
     */
    async submitWorkflow(workflowIdOrName, input, opts = {}) {
        if (!this.workflowEngine) {
            throw new Error('Workflow engine not initialized')
        }

        const { runId, workflow } = this.workflowEngine.createRun(workflowIdOrName, input)
        console.log(`[orchestrator] Workflow run ${runId} created: ${workflow.name}`)

        // Build sendToAgent callback — routes to idle agents via registry
        const sendToAgent = async (prompt, role) => {
            const result = await this.submitTaskSync(prompt, { role })
            return result.result
        }

        // Execute asynchronously
        const executePromise = this.workflowEngine.executeRun(runId, sendToAgent)
            .then(({ output }) => {
                console.log(`[orchestrator] Workflow run ${runId} completed (${(output || '').length} chars)`)
                // Notify via Telegram if chat ID provided
                if (opts.telegramChatId && this._onTaskComplete) {
                    this._onTaskComplete({
                        id: runId,
                        status: 'done',
                        instruction: `Workflow: ${workflow.name}`,
                        result: output,
                        agent_id: 'workflow',
                        telegram_chat_id: opts.telegramChatId,
                    }).catch(err => console.error(`[orchestrator] Workflow notification error: ${err.message}`))
                }
            })
            .catch(err => {
                console.error(`[orchestrator] Workflow run ${runId} failed: ${err.message}`)
                if (opts.telegramChatId && this._onTaskComplete) {
                    this._onTaskComplete({
                        id: runId,
                        status: 'failed',
                        instruction: `Workflow: ${workflow.name}`,
                        error: err.message,
                        agent_id: 'workflow',
                        telegram_chat_id: opts.telegramChatId,
                    }).catch(e => console.error(`[orchestrator] Workflow notification error: ${e.message}`))
                }
            })

        return { runId, executePromise }
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
