/**
 * Agent Manifest — single source of truth per agent via YAML files.
 *
 * Loads YAML manifests from agents/ directory and normalizes them
 * into a standard format. Falls back to config.json if no manifests found.
 */
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import yaml from 'js-yaml'

/**
 * Load all agent manifest YAML files from a directory.
 * @param {string} agentsDir - absolute path to agents/ directory
 * @returns {Promise<Array<Object>>} normalized agent definitions
 */
export async function loadManifests(agentsDir) {
    const manifests = []

    try {
        const files = await readdir(agentsDir)
        for (const file of files) {
            if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue

            try {
                const content = await readFile(join(agentsDir, file), 'utf-8')
                const parsed = yaml.load(content)

                // Validate required fields
                if (!parsed?.id) {
                    console.warn(`[manifest] Skipping ${file}: missing required 'id' field`)
                    continue
                }
                if (!parsed?.role) {
                    console.warn(`[manifest] Skipping ${file}: missing required 'role' field`)
                    continue
                }

                // Normalize the manifest
                const manifest = {
                    id: parsed.id,
                    role: parsed.role,
                    name: parsed.name || parsed.id,
                    port: parsed.port || null,
                    workdir: parsed.workdir || `./workspace/${parsed.id}`,
                    model: parsed.model || null,
                    agentMode: parsed.agentMode || 'build', // plan or build
                    capabilities: parsed.capabilities || ['*'],
                    budget: {
                        hourly: parsed.budget?.hourly || null,
                        daily: parsed.budget?.daily || null,
                    },
                    variables: parsed.variables || {},
                }

                manifests.push(manifest)
                console.log(`[manifest] Loaded: ${manifest.id} (${manifest.role}) from ${file}`)
            } catch (err) {
                console.error(`[manifest] Error parsing ${file}: ${err.message}`)
            }
        }
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.log(`[manifest] No agents directory found at ${agentsDir}`)
        } else {
            console.warn(`[manifest] Could not load manifests: ${err.message}`)
        }
    }

    return manifests
}
