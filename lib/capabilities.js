/**
 * Capability Manager — tool/permission enforcement per agent.
 *
 * Each agent can be granted a set of capabilities from its manifest.
 * Wildcard '*' grants all capabilities.
 *
 * Inspired by openfang capabilities.rs.
 */

export class CapabilityManager {
    constructor() {
        this._grants = new Map()  // agentId → Set<string>
    }

    /**
     * Grant capabilities to an agent.
     * @param {string} agentId
     * @param {string[]} capabilities - list of capability strings (e.g., 'code.write', '*')
     */
    grant(agentId, capabilities = []) {
        const existing = this._grants.get(agentId) || new Set()
        for (const cap of capabilities) {
            existing.add(cap)
        }
        this._grants.set(agentId, existing)
    }

    /**
     * Check if an agent has the required capability.
     * @param {string} agentId
     * @param {string} required - capability to check
     * @returns {boolean}
     */
    check(agentId, required) {
        const caps = this._grants.get(agentId)
        if (!caps) return false

        // Wildcard grants everything
        if (caps.has('*')) return true

        // Exact match
        if (caps.has(required)) return true

        // Category wildcard: 'code.*' grants 'code.read', 'code.write', etc.
        const parts = required.split('.')
        if (parts.length > 1) {
            const categoryWildcard = parts[0] + '.*'
            if (caps.has(categoryWildcard)) return true
        }

        return false
    }

    /**
     * List all capabilities for an agent.
     * @param {string} agentId
     * @returns {string[]}
     */
    list(agentId) {
        const caps = this._grants.get(agentId)
        return caps ? [...caps] : []
    }

    /**
     * Load capabilities from agent manifests.
     * @param {Array<{ id: string, capabilities: string[] }>} manifests
     */
    loadFromManifests(manifests) {
        for (const manifest of manifests) {
            if (manifest.id && manifest.capabilities) {
                this.grant(manifest.id, manifest.capabilities)
                console.log(`[capabilities] ${manifest.id}: ${manifest.capabilities.join(', ')}`)
            }
        }
    }
}
