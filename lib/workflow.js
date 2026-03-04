/**
 * Workflow Engine — multi-step task pipelines with variable interpolation,
 * fan-out/collect parallelism, conditional/loop steps.
 *
 * Step modes: sequential, fan_out, collect, conditional, loop
 * Error modes: fail, skip, retry (with max retries)
 *
 * Inspired by openfang workflow.rs (lines 66-549).
 */
import {
    saveWorkflowDef, getWorkflowDef, listWorkflowDefs,
    saveWorkflowRun, updateWorkflowRun, getWorkflowRun, listWorkflowRuns
} from './memory.js'

// ─── Workflow Engine ────────────────────────────────────────────────────────

export class WorkflowEngine {
    /**
     * @param {{ eventBus?: import('./event-bus.js').EventBus, maxRetainedRuns?: number }} opts
     */
    constructor({ eventBus = null, maxRetainedRuns = 200 } = {}) {
        this._eventBus = eventBus
        this._maxRetainedRuns = maxRetainedRuns
        this._workflows = new Map()  // name → workflow definition (in-memory cache)
    }

    // ─── Registry ────────────────────────────────────────────────────────

    /**
     * Register a workflow definition (in-memory cache + DB persistence).
     */
    register(workflow) {
        if (!workflow.name) throw new Error('Workflow must have a name')
        if (!workflow.steps || !workflow.steps.length) throw new Error('Workflow must have steps')

        // Normalize steps
        for (const step of workflow.steps) {
            step.mode = step.mode || step.stepMode || 'sequential'
            step.errorMode = step.errorMode || step.error_mode || 'fail'
            step.maxRetries = step.maxRetries || step.max_retries || 3
            step.role = step.role || step.agent_role || null
            step.prompt = step.prompt || step.instruction || ''
            step.condition = step.condition || null
            step.maxIterations = step.maxIterations || step.max_iterations || 10
            step.untilContains = step.untilContains || step.until_contains || null
        }

        this._workflows.set(workflow.name, workflow)

        // Persist to DB
        saveWorkflowDef({
            name: workflow.name,
            description: workflow.description || '',
            steps: workflow.steps,
        })

        console.log(`[workflow] Registered: ${workflow.name} (${workflow.steps.length} steps)`)
        return workflow
    }

    listWorkflows() {
        // Merge in-memory + DB
        const dbList = listWorkflowDefs()
        const result = []
        const seen = new Set()

        for (const wf of this._workflows.values()) {
            result.push({ name: wf.name, description: wf.description || '', steps: wf.steps.length })
            seen.add(wf.name)
        }

        for (const row of dbList) {
            if (!seen.has(row.name)) {
                let stepCount = 0
                try {
                    const steps = typeof row.steps === 'string' ? JSON.parse(row.steps) : row.steps
                    stepCount = steps?.length || 0
                } catch { /* fallback */ }
                result.push({ name: row.name, description: row.description || '', steps: stepCount })
            }
        }

        return result
    }

    findWorkflow(name) {
        // Check in-memory cache first
        if (this._workflows.has(name)) return this._workflows.get(name)
        // Fallback to DB
        const row = getWorkflowDef(name)
        if (row) {
            const wf = { name: row.name, description: row.description, steps: row.steps }
            this._workflows.set(name, wf)
            return wf
        }
        return null
    }

    // ─── Execution ────────────────────────────────────────────────────────

    /**
     * Create a new workflow run.
     * @param {string} workflowIdOrName
     * @param {string} input
     * @returns {{ runId: string, workflow: Object }}
     */
    createRun(workflowIdOrName, input) {
        const workflow = this.findWorkflow(workflowIdOrName)
        if (!workflow) throw new Error(`Workflow not found: ${workflowIdOrName}`)

        const wfDef = getWorkflowDef(workflow.name)
        const workflowId = wfDef?.id || workflow.name

        const runId = saveWorkflowRun({ workflowId, input, state: 'pending' })

        // Evict old runs
        this._evictOldRuns()

        return { runId, workflow }
    }

    /**
     * Execute a workflow run.
     * @param {string} runId
     * @param {(prompt: string, role: string) => Promise<string>} sendToAgent
     * @returns {Promise<{ output: string, stepResults: Array }>}
     */
    async executeRun(runId, sendToAgent) {
        const run = getWorkflowRun(runId)
        if (!run) throw new Error(`Run not found: ${runId}`)

        const wfDef = getWorkflowDef(run.workflow_id)
        if (!wfDef) throw new Error(`Workflow definition not found for run: ${runId}`)

        const workflow = typeof wfDef.steps === 'string' ? JSON.parse(wfDef.steps) : wfDef.steps
        const steps = Array.isArray(workflow) ? workflow : workflow.steps || []

        updateWorkflowRun(runId, { state: 'running' })
        this._eventBus?.publish('workflow.started', { runId, workflowName: wfDef.name }, 'workflow')

        const variables = { input: run.input || '' }
        const stepResults = []

        try {
            for (let i = 0; i < steps.length; i++) {
                const step = steps[i]
                const stepName = step.name || `step-${i + 1}`
                const mode = step.mode || 'sequential'

                this._eventBus?.publish('workflow.step.started', {
                    runId, stepIndex: i, stepName, mode
                }, 'workflow')

                let result
                try {
                    switch (mode) {
                        case 'fan_out':
                            result = await this._executeFanOut(step, variables, sendToAgent)
                            break
                        case 'collect':
                            result = await this._executeCollect(step, variables, stepResults, sendToAgent)
                            break
                        case 'conditional':
                            result = await this._executeConditional(step, variables, stepResults, sendToAgent)
                            break
                        case 'loop':
                            result = await this._executeLoop(step, variables, sendToAgent)
                            break
                        default: // sequential
                            result = await this._executeStepWithErrorMode(step, variables, sendToAgent)
                            break
                    }
                } catch (stepErr) {
                    this._eventBus?.publish('workflow.step.failed', {
                        runId, stepIndex: i, stepName, error: stepErr.message
                    }, 'workflow')

                    if (step.errorMode === 'skip') {
                        result = `[SKIPPED: ${stepErr.message}]`
                    } else {
                        throw stepErr
                    }
                }

                stepResults.push({ step: stepName, role: step.role, output: result })
                variables[stepName] = result
                variables.previous = result

                updateWorkflowRun(runId, { stepResults })

                this._eventBus?.publish('workflow.step.completed', {
                    runId, stepIndex: i, stepName, outputLength: (result || '').length
                }, 'workflow')
            }

            // Final output = last step's result
            const output = stepResults.length > 0 ? stepResults[stepResults.length - 1].output : ''
            updateWorkflowRun(runId, { state: 'completed', output, stepResults })

            this._eventBus?.publish('workflow.completed', {
                runId, workflowName: wfDef.name, stepCount: stepResults.length
            }, 'workflow')

            return { output, stepResults }

        } catch (err) {
            updateWorkflowRun(runId, { state: 'failed', error: err.message, stepResults })

            this._eventBus?.publish('workflow.failed', {
                runId, workflowName: wfDef.name, error: err.message
            }, 'workflow')

            throw err
        }
    }

    // ─── Step Execution Modes ─────────────────────────────────────────────

    /**
     * Execute a step with error mode handling (fail/skip/retry).
     */
    async _executeStepWithErrorMode(step, variables, sendToAgent) {
        const prompt = this._interpolate(step.prompt, variables)
        const errorMode = step.errorMode || 'fail'
        const maxRetries = step.maxRetries || 3

        if (errorMode === 'retry') {
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    return await sendToAgent(prompt, step.role || 'orchestrator')
                } catch (err) {
                    if (attempt >= maxRetries) throw err
                    console.log(`[workflow] Step retry ${attempt}/${maxRetries}: ${err.message}`)
                    await new Promise(r => setTimeout(r, 1000 * attempt))
                }
            }
        }

        return await sendToAgent(prompt, step.role || 'orchestrator')
    }

    /**
     * Fan-out: run multiple prompts in parallel (one per sub-prompt).
     */
    async _executeFanOut(step, variables, sendToAgent) {
        const prompts = Array.isArray(step.prompts)
            ? step.prompts.map(p => this._interpolate(p, variables))
            : [this._interpolate(step.prompt, variables)]

        const promises = prompts.map(p => sendToAgent(p, step.role || 'orchestrator'))
        const results = await Promise.allSettled(promises)

        return results.map((r, i) =>
            r.status === 'fulfilled' ? r.value : `[ERROR: ${r.reason?.message || 'unknown'}]`
        ).join('\n---\n')
    }

    /**
     * Collect: gather results from previous fan-out steps.
     */
    async _executeCollect(step, variables, stepResults, sendToAgent) {
        // Collect all previous step results into context
        const collected = stepResults
            .map((sr, i) => `### ${sr.step}\n${sr.output}`)
            .join('\n\n')

        variables.collected = collected
        const prompt = this._interpolate(step.prompt || 'Summarize the following results:\n\n{{collected}}', variables)
        return await sendToAgent(prompt, step.role || 'orchestrator')
    }

    /**
     * Conditional: skip if previous output doesn't contain condition string.
     */
    async _executeConditional(step, variables, stepResults, sendToAgent) {
        const condition = step.condition
        const prevOutput = variables.previous || ''

        if (condition && !prevOutput.toLowerCase().includes(condition.toLowerCase())) {
            return `[SKIPPED: condition "${condition}" not met in previous output]`
        }

        return await this._executeStepWithErrorMode(step, variables, sendToAgent)
    }

    /**
     * Loop: repeat until output matches condition or max iterations.
     */
    async _executeLoop(step, variables, sendToAgent) {
        const maxIterations = step.maxIterations || 10
        const untilContains = step.untilContains
        let lastOutput = ''

        for (let i = 0; i < maxIterations; i++) {
            variables.iteration = String(i + 1)
            variables.lastOutput = lastOutput

            lastOutput = await this._executeStepWithErrorMode(step, variables, sendToAgent)

            if (untilContains && lastOutput.toLowerCase().includes(untilContains.toLowerCase())) {
                return lastOutput
            }
        }

        return lastOutput  // max iterations reached
    }

    // ─── Utilities ────────────────────────────────────────────────────────

    /**
     * Interpolate variables: {{input}}, {{varName}}, {{previous}}
     */
    _interpolate(template, variables) {
        if (!template) return ''
        return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
            return variables[key] !== undefined ? variables[key] : `{{${key}}}`
        })
    }

    /**
     * Evict old runs to prevent DB bloat.
     */
    _evictOldRuns() {
        try {
            const runs = listWorkflowRuns(this._maxRetainedRuns + 50)
            if (runs.length > this._maxRetainedRuns) {
                // Keep only the most recent _maxRetainedRuns
                // listWorkflowRuns already returns sorted by created_at DESC
                // The excess ones are at the end
                // For now, just log — actual eviction would need a DELETE query
                console.log(`[workflow] ${runs.length} runs tracked (max: ${this._maxRetainedRuns})`)
            }
        } catch { /* non-fatal */ }
    }
}
