/**
 * Heartbeat engine — monitors agents, recovers stuck tasks,
 * runs memory consolidation, resubscribes to SSE events
 */
import { resetStuckTasks } from './memory.js'
import { consolidateMemories } from './consolidation.js'

export class Heartbeat {
    /**
     * @param {import('./registry.js').AgentRegistry} registry
     * @param {number} intervalMs
     * @param {{ eventBus?: import('./event-bus.js').EventBus }} opts
     */
    constructor(registry, intervalMs = 30_000, { eventBus = null } = {}) {
        this.registry = registry
        this.intervalMs = intervalMs
        this._timer = null
        this._eventSubs = new Map()  // agentId → AbortController
        this._tickCount = 0
        this._eventBus = eventBus
    }

    /** Start the heartbeat loop */
    start() {
        this._timer = setInterval(() => this._tick(), this.intervalMs)
        console.log(`[heartbeat] Started (interval: ${this.intervalMs}ms)`)
    }

    /** Stop the heartbeat loop */
    stop() {
        if (this._timer) {
            clearInterval(this._timer)
            this._timer = null
        }
        // Abort all event subscriptions
        for (const [id, ac] of this._eventSubs) {
            ac.abort()
        }
        this._eventSubs.clear()
        console.log('[heartbeat] Stopped')
    }

    /** Internal: check each agent, recover stuck tasks, run consolidation */
    async _tick() {
        this._tickCount++

        // ── Recover stuck tasks (running > 10 minutes) ──
        try {
            resetStuckTasks(10)
        } catch (err) {
            console.warn(`[heartbeat] Stuck task recovery failed: ${err.message}`)
        }

        // ── Phase 3: Run memory consolidation every ~60 minutes ──
        // At 30s interval, 120 ticks = 60 minutes
        if (this._tickCount % 120 === 0) {
            try {
                consolidateMemories()
            } catch (err) {
                console.warn(`[heartbeat] Memory consolidation failed: ${err.message}`)
            }
        }

        // ── Check agent health ──
        for (const agent of this.registry.getInstances()) {
            if (agent._isShuttingDown) continue

            try {
                // Ping agent via SDK — list sessions is a lightweight call
                await agent.client.session.list()
            } catch (err) {
                console.warn(`[heartbeat] Agent ${agent.agentId} unreachable (${err.message}), restarting...`)
                try {
                    await agent.stop()
                    await agent.start()
                    // Pass eventBus for event-driven worker loop
                    agent.startWorkerLoop(this._eventBus || 3000)
                    console.log(`[heartbeat] Agent ${agent.agentId} restarted successfully`)
                } catch (restartErr) {
                    console.error(`[heartbeat] Failed to restart agent ${agent.agentId}: ${restartErr.message}`)
                }
            }
        }
    }

    /**
     * Subscribe to realtime SSE events from a single agent
     * Calls onEvent(agentId, event) for each incoming event
     * Auto-reconnects if subscription drops
     * @param {import('../lib/agent-spawner.js').AgentSpawner} agent
     * @param {Function} onEvent
     */
    async subscribeEvents(agent, onEvent) {
        const agentId = agent.agentId

        const run = async () => {
            const ac = new AbortController()
            this._eventSubs.set(agentId, ac)

            try {
                const events = await agent.client.event.subscribe({ signal: ac.signal })
                for await (const event of events) {
                    onEvent(agentId, event)
                }
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.warn(`[heartbeat] Event subscription for ${agentId} dropped: ${err.message}. Reconnecting in 5s...`)
                    setTimeout(run, 5000)
                }
            }
        }

        await run()
    }
}

