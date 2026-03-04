/**
 * Workflow Loader — loads workflow definitions from YAML files
 * in the workflows/ directory.
 *
 * Same pattern as skills.js loader.
 */
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import yaml from 'js-yaml'

/**
 * Load all workflow YAML files from a directory.
 * @param {string} workflowsDir - absolute path to workflows/ directory
 * @returns {Promise<Array<{ name: string, description: string, steps: Array }>>}
 */
export async function loadWorkflows(workflowsDir) {
    const workflows = []
    try {
        const files = await readdir(workflowsDir)
        for (const file of files) {
            if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
            try {
                const content = await readFile(join(workflowsDir, file), 'utf-8')
                const parsed = yaml.load(content)

                if (!parsed?.name || !parsed?.steps) {
                    console.warn(`[workflow-loader] Skipping ${file}: missing 'name' or 'steps'`)
                    continue
                }

                // Normalize step fields (snake_case → camelCase)
                const steps = (parsed.steps || []).map(normalizeStep)

                workflows.push({
                    name: parsed.name,
                    description: parsed.description || '',
                    steps,
                })

                console.log(`[workflow-loader] Loaded: ${parsed.name} from ${file}`)
            } catch (err) {
                console.error(`[workflow-loader] Error parsing ${file}: ${err.message}`)
            }
        }
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.log(`[workflow-loader] No workflows directory found at ${workflowsDir}`)
        } else {
            console.warn(`[workflow-loader] Could not load workflows: ${err.message}`)
        }
    }
    return workflows
}

/**
 * Normalize a single step definition (snake_case → camelCase).
 */
function normalizeStep(step) {
    return {
        name: step.name || step.step_name || undefined,
        mode: step.mode || step.step_mode || 'sequential',
        role: step.role || step.agent_role || null,
        prompt: step.prompt || step.instruction || '',
        prompts: step.prompts || undefined,
        errorMode: step.errorMode || step.error_mode || 'fail',
        maxRetries: step.maxRetries || step.max_retries || 3,
        condition: step.condition || null,
        maxIterations: step.maxIterations || step.max_iterations || 10,
        untilContains: step.untilContains || step.until_contains || null,
    }
}
