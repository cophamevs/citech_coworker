/**
 * Event Bus — central publish/subscribe hub for all system events.
 * Replaces double-polling (orchestrator watcher + agent worker loop)
 * with event-driven architecture.
 *
 * Inspired by openfang EventBus (event_bus.rs).
 */
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

// ─── Event Type Constants ────────────────────────────────────────────────────

export const EventType = {
    // Task lifecycle (emitted from memory.js)
    TASK_ENQUEUED:     'task.enqueued',
    TASK_CLAIMED:      'task.claimed',
    TASK_COMPLETED:    'task.completed',
    TASK_FAILED:       'task.failed',

    // Agent lifecycle (emitted from agent-spawner.js and registry.js)
    AGENT_STARTED:     'agent.started',
    AGENT_IDLE:        'agent.idle',
    AGENT_BUSY:        'agent.busy',
    AGENT_OFFLINE:     'agent.offline',
    AGENT_ERROR:       'agent.error',

    // Workflow lifecycle (emitted from workflow.js)
    WORKFLOW_STARTED:       'workflow.started',
    WORKFLOW_STEP_STARTED:  'workflow.step.started',
    WORKFLOW_STEP_COMPLETED:'workflow.step.completed',
    WORKFLOW_STEP_FAILED:   'workflow.step.failed',
    WORKFLOW_COMPLETED:     'workflow.completed',
    WORKFLOW_FAILED:        'workflow.failed',

    // Memory events (emitted from memory.js)
    MEMORY_UPDATED:    'memory.updated',

    // System events
    SYSTEM_HEARTBEAT:  'system.heartbeat',
    SYSTEM_SHUTDOWN:   'system.shutdown',
}

// ─── EventBus Class ──────────────────────────────────────────────────────────

export class EventBus {
    /**
     * @param {{ historySize?: number }} opts
     */
    constructor({ historySize = 500 } = {}) {
        this._emitter = new EventEmitter()
        this._emitter.setMaxListeners(50)
        this._history = []
        this._historySize = historySize
    }

    /**
     * Publish an event to the bus.
     * Stores in ring buffer history, then emits to type-specific and wildcard listeners.
     * @param {string} type - Event type from EventType constants
     * @param {Object} payload - Event-specific data
     * @param {string} source - Who emitted this event
     * @returns {Object} The full event object
     */
    publish(type, payload = {}, source = 'system') {
        const event = {
            id: randomUUID(),
            type,
            payload,
            source,
            timestamp: new Date().toISOString(),
        }

        // Ring buffer
        this._history.push(event)
        if (this._history.length > this._historySize) {
            this._history.shift()
        }

        // Emit to type-specific listeners
        this._emitter.emit(type, event)
        // Emit to wildcard listeners
        this._emitter.emit('*', event)

        return event
    }

    /**
     * Subscribe to a specific event type.
     * @param {string} type
     * @param {Function} handler - (event) => void
     * @returns {Function} Unsubscribe function
     */
    on(type, handler) {
        this._emitter.on(type, handler)
        return () => this._emitter.off(type, handler)
    }

    /**
     * Subscribe once to a specific event type.
     * @param {string} type
     * @param {Function} handler
     */
    once(type, handler) {
        this._emitter.once(type, handler)
    }

    /**
     * Subscribe to ALL events (wildcard).
     * @param {Function} handler
     * @returns {Function} Unsubscribe function
     */
    onAll(handler) {
        this._emitter.on('*', handler)
        return () => this._emitter.off('*', handler)
    }

    /**
     * Get recent event history.
     * @param {number} limit
     * @returns {Array}
     */
    history(limit = 20) {
        return this._history.slice(-limit)
    }

    /**
     * Destroy all listeners and clear history.
     */
    destroy() {
        this._emitter.removeAllListeners()
        this._history = []
    }
}
