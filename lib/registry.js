/**
 * AgentRegistry — holds all AgentSpawner instances, tracks status
 */
export class AgentRegistry {
    constructor() {
        /** @type {Map<string, import('./agent-spawner.js').AgentSpawner>} */
        this.agents = new Map()
    }

    /**
     * Register an agent instance
     * @param {import('./agent-spawner.js').AgentSpawner} agent
     */
    register(agent) {
        this.agents.set(agent.agentId, agent)
    }

    /**
     * Remove an agent from the registry
     * @param {string} agentId
     */
    unregister(agentId) {
        this.agents.delete(agentId)
    }

    /**
     * Get first idle agent, optionally filtered by role
     * @param {string|null} role
     * @returns {import('./agent-spawner.js').AgentSpawner|null}
     */
    getIdle(role = null) {
        for (const agent of this.agents.values()) {
            if (agent.status === 'idle') {
                if (!role || agent.role === role) return agent
            }
        }
        return null
    }

    /**
     * Get agent by ID
     * @param {string} agentId
     * @returns {import('./agent-spawner.js').AgentSpawner|undefined}
     */
    getById(agentId) {
        return this.agents.get(agentId)
    }

    /**
     * Get all agents as plain objects (for status reporting)
     * @returns {Array<{id, role, port, status, workdir}>}
     */
    getAll() {
        return [...this.agents.values()].map((a) => ({
            id: a.agentId,
            role: a.role,
            port: a.port,
            status: a.status,
            workdir: a.workdir
        }))
    }

    /**
     * Get all raw AgentSpawner instances
     * @returns {import('./agent-spawner.js').AgentSpawner[]}
     */
    getInstances() {
        return [...this.agents.values()]
    }

    /** Total number of registered agents */
    get size() {
        return this.agents.size
    }
}
