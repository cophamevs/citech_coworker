import { AgentSpawner } from './agent-spawner.js'
import { saveTask, updateTask, buildContextPrompt } from './memory.js'
import { withRetry } from './retry.js'



/**
 * Orchestrator — owns the registry reference and config, dispatches tasks
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
    }

    /**
     * Submit a task: send to specific agent if designated, otherwise to orchestrator
     * @param {string} instruction
     * @param {{ role?: string, agentId?: string }} [opts]
     * @returns {Promise<{ taskId: string, result: string, agentId: string }>}
     */
    async submitTask(instruction, opts = {}) {
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
            // Send with retry + timeout
            const outcome = await withRetry(
                () => agent.sendTask(instruction),
                `task-${taskId}`,
                {
                    maxRetries: this.config.maxRetries || 3,
                    timeout: (this.config.taskTimeout || 300) * 1000
                }
            )

            // Handle delegate (multi-agent hand-off)
            if (outcome.type === 'delegate') {
                console.log(`[orchestrator] Delegating to role=${outcome.role}: ${outcome.instruction}`)
                const sub = await this.submitTask(outcome.instruction, { role: outcome.role })
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
     * @param {string} role
     * @returns {Promise<import('./agent-spawner.js').AgentSpawner>}
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
