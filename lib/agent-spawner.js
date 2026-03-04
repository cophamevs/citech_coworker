import { spawn } from 'child_process'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'
import { loadSkills, formatSkillsPrompt } from './skills.js'
import { claimTask, completeTask, failTask, enqueueTask, recordUsage } from './memory.js'
import { estimateCost } from './metering.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function loadRolePrompt(role, vars = {}) {
    const promptPath = join(__dirname, '..', 'roles', `${role}.md`)
    let text = await readFile(promptPath, 'utf-8')
    for (const [key, value] of Object.entries(vars)) {
        text = text.replaceAll(`{{${key}}}`, value)
    }
    return text
}

async function waitForHttpReady(proc, port, timeoutMs = 60_000) {
    const startTime = Date.now()
    while (Date.now() - startTime < timeoutMs) {
        if (proc.exitCode !== null) {
            throw new Error(`Agent process exited prematurely with code ${proc.exitCode}`)
        }
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`)
            if (res.ok) return true

            // If /health is not implemented but server responds, that's also fine
            if (res.status === 404 || res.status === 401 || res.status === 403) return true
        } catch (err) {
            // Connection refused, server not up yet
        }
        await new Promise(r => setTimeout(r, 1000))
    }
    throw new Error(`Agent process did not bind to port ${port} within ${timeoutMs}ms`)
}

/**
 * Parse SSE stream từ fetch Response
 * Dùng khi SDK không support async iterable
 */
async function* parseSseStream(response) {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()
        for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const raw = line.slice(6).trim()
            if (!raw || raw === '[DONE]') continue
            try { yield JSON.parse(raw) } catch { continue }
        }
    }
}

export class AgentSpawner {
    constructor({ agentId, port, role, workdir, memoryContext = '', agentMode = 'build' }) {
        this.agentId = agentId
        this.port = port
        this.role = role
        this.workdir = resolve(workdir)
        this.memoryContext = memoryContext
        this.agentMode = agentMode
        this.client = null
        this.process = null
        this.sessionId = null
        this.status = 'offline'
        this._isShuttingDown = false
        this._logs = []
    }

    async start() {
        this.status = 'starting'
        this._log(`Starting opencode serve on port ${this.port}`)

        this.process = spawn('opencode', ['serve', '--port', String(this.port)], {
            cwd: this.workdir,
            detached: false,
            stdio: 'pipe',
            shell: process.platform === 'win32'
        })

        this.process.stdout.on('data', (d) => this._log(`[stdout] ${d.toString().trim()}`))
        this.process.stderr.on('data', (d) => this._log(`[stderr] ${d.toString().trim()}`))
        this.process.on('exit', (code) => {
            this._log(`Process exited with code ${code}`)
            if (!this._isShuttingDown) this.status = 'offline'
        })

        await waitForHttpReady(this.process, this.port)

        // ✅ Dùng OpencodeClient từ SDK
        this.client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${this.port}` })

        // Initialize user properties
        try {
            const userPropsRes = await this.client.user.getProperties()
            if (userPropsRes?.data) {
                this._log(`User properties initialized.`)
            }
        } catch (e) {
            this._log(`Could not initialize properties: ${e.message}`)
        }
        // ───────────────────────────────────────────────────────────────────

        // ── Dọn sessions cũ của agent này ──────────────────────────────────
        try {
            const sessions = await this.client.session.list()
            const old = (sessions.data || []).filter(s =>
                s.title?.includes(this.agentId)
            )
            for (const s of old) {
                await this.client.session.delete({ path: { id: s.id } })
                this._log(`Deleted old session: ${s.id} (${s.title})`)
            }
            if (old.length > 0) this._log(`Cleaned up ${old.length} old session(s)`)
        } catch (err) {
            this._log(`Warning: session cleanup failed: ${err.message}`)
        }
        // ───────────────────────────────────────────────────────────────────

        const session = await this.client.session.create({
            body: { title: `${this.agentId} - ${this.role}` }
        })
        this.sessionId = session.data.id
        this._log(`Session created: ${this.sessionId}`)

        const rolePrompt = await loadRolePrompt(this.role, {
            WORKDIR: this.workdir,
            MEMORY: this.memoryContext,
            ALLOWED_HOSTS: process.env.ALLOWED_HOSTS || 'localhost'
        })

        const skillsDir = join(__dirname, '..', 'skills')
        const skills = await loadSkills(skillsDir)
        const skillsPrompt = formatSkillsPrompt(skills)

        await this.client.session.prompt({
            path: { id: this.sessionId },
            body: {
                agent: this.agentMode,
                noReply: true,
                parts: [{ type: 'text', text: rolePrompt + skillsPrompt }]
            }
        })

        this.status = 'idle'
        this._log(`Agent ready (role: ${this.role})`)
        return this
    }

    async _executeViaOpenCode(instruction) {
        if (this.status !== 'idle') {
            throw new Error(`Agent ${this.agentId} is not idle (status: ${this.status})`)
        }
        this.status = 'busy'
        this._log(`Received task: ${instruction.slice(0, 80)}...`)

        try {
            // ── Step 1: POST message để trigger task ─────────────────────────
            this._log(`POSTing message to session ${this.sessionId}`)
            const postRes = await fetch(
                `http://127.0.0.1:${this.port}/session/${this.sessionId}/message`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        agent: this.agentMode,
                        parts: [{ type: 'text', text: instruction }]
                    })
                }
            )

            if (!postRes.ok) {
                throw new Error(`HTTP ${postRes.status}: ${await postRes.text()}`)
            }

            // Consume POST response (JSON: { info, parts })
            const postData = await postRes.json()
            this._log(`[POST response] ${JSON.stringify(postData).slice(0, 300)}`)

            // ── Step 2: Listen to global /event SSE for session status ───────
            this._log(`Connecting to global /event SSE stream...`)
            const abortController = new AbortController()
            const eventRes = await fetch(
                `http://127.0.0.1:${this.port}/event`,
                {
                    method: 'GET',
                    headers: { 'Accept': 'text/event-stream' },
                    signal: abortController.signal
                }
            )

            if (!eventRes.ok) {
                this._log(`Failed to connect /event: ${eventRes.status}. Falling back to polling...`)
                return await this._pollForResult()
            }

            const stream = parseSseStream(eventRes)
            let fullText = ''
            let done = false
            let _tokenUsage = { inputTokens: 0, outputTokens: 0, model: 'unknown' }
            const INACTIVITY_TIMEOUT = 90_000   // 90s không có event liên quan → coi như xong
            const MAX_TOTAL_TIMEOUT = 300_000   // 5 phút tổng cộng

            let inactivityTimer
            let totalTimer
            let aborted = false

            const cleanup = () => {
                if (inactivityTimer) clearTimeout(inactivityTimer)
                if (totalTimer) clearTimeout(totalTimer)
                if (!aborted) {
                    aborted = true
                    try { abortController.abort() } catch { }
                }
            }

            const resetInactivityTimer = () => {
                if (inactivityTimer) clearTimeout(inactivityTimer)
                inactivityTimer = setTimeout(() => {
                    this._log(`Event stream inactivity timeout (${INACTIVITY_TIMEOUT / 1000}s). Aborting...`)
                    cleanup()
                }, INACTIVITY_TIMEOUT)
            }

            totalTimer = setTimeout(() => {
                this._log(`Event stream total timeout (${MAX_TOTAL_TIMEOUT / 1000}s). Aborting...`)
                cleanup()
            }, MAX_TOTAL_TIMEOUT)

            try {
                resetInactivityTimer()

                for await (const event of stream) {
                    // Chỉ care events cho session của mình
                    const eventSessionId = event.properties?.sessionID ||
                        event.properties?.info?.sessionID ||
                        event.properties?.part?.sessionID
                    if (eventSessionId && eventSessionId !== this.sessionId) continue

                    resetInactivityTimer()
                    this._log(`[event] ${event.type}`)

                    // ── Text content updates ────────────────────────────────
                    if (event.type === 'message.part.updated') {
                        const part = event.properties?.part
                        if (part?.type === 'text' && part?.text) {
                            fullText = part.text
                        }
                    }

                    // ── Message completed ────────────────────────────────────
                    if (event.type === 'message.updated') {
                        const info = event.properties?.info
                        if (info?.role === 'assistant' && info?.time?.completed) {
                            this._log(`Assistant message completed`)
                            // Phase 4: Extract token usage
                            if (info.usage) {
                                _tokenUsage.inputTokens = info.usage.input || info.usage.prompt_tokens || 0
                                _tokenUsage.outputTokens = info.usage.output || info.usage.completion_tokens || 0
                            }
                            if (info.model) {
                                _tokenUsage.model = info.model
                            }
                            // Don't break yet — wait for session.idle
                        }
                    }

                    // ── Session idle → task done ────────────────────────────
                    if (event.type === 'session.status') {
                        const status = event.properties?.status
                        if (status?.type === 'idle') {
                            this._log(`Session idle. fullText length: ${fullText.length}`)
                            done = true
                            break
                        }
                        if (status?.type === 'retry') {
                            const attempt = status.attempt || 1
                            const errMsg = status.message || 'Rate limit / quota exceeded'
                            const nextTs = status.next  // unix ms timestamp for next retry
                            this._log(`Session retry #${attempt}: ${errMsg}`)

                            // Quota/billing errors → throw ngay (retry cũng không fix)
                            const isFatal = /usage exceeded|credits|quota|billing|pay/i.test(errMsg)
                            const MAX_RETRIES = 3

                            if (isFatal || attempt >= MAX_RETRIES) {
                                cleanup()
                                throw new Error(`⚠️ ${errMsg} (after ${attempt} attempt${attempt > 1 ? 's' : ''})`)
                            }

                            // Transient error → đợi đến next retry timestamp rồi tiếp tục listen
                            if (nextTs) {
                                const waitMs = Math.max(0, nextTs - Date.now())
                                this._log(`Waiting ${Math.ceil(waitMs / 1000)}s for retry #${attempt + 1}...`)
                            }
                            // Continue listening — server sẽ tự retry
                        }
                    }

                    if (event.type === 'session.error') {
                        const err = event.properties?.error
                        const errMsg = err?.data?.message || err?.message || 'Unknown session error'
                        cleanup()
                        throw new Error(`Session error: ${errMsg}`)
                    }
                }
            } catch (streamErr) {
                if (streamErr.name === 'AbortError') {
                    this._log(`Event stream aborted (timeout). fullText so far: ${fullText.length}`)
                } else {
                    cleanup()
                    throw streamErr
                }
            } finally {
                cleanup()
            }

            // ── Step 3: Record usage and return result ──────────────────────
            // Phase 4: Record token usage and cost
            if (_tokenUsage.inputTokens > 0 || _tokenUsage.outputTokens > 0) {
                try {
                    const { costUsd } = estimateCost(_tokenUsage.model, _tokenUsage.inputTokens, _tokenUsage.outputTokens)
                    recordUsage({
                        agentId: this.agentId,
                        model: _tokenUsage.model,
                        inputTokens: _tokenUsage.inputTokens,
                        outputTokens: _tokenUsage.outputTokens,
                        costUsd,
                    })
                    this._log(`Usage: ${_tokenUsage.inputTokens}+${_tokenUsage.outputTokens} tokens, $${costUsd.toFixed(6)}`)
                } catch (err) {
                    this._log(`Warning: usage recording failed: ${err.message}`)
                }
            }

            if (fullText.trim()) {
                this._log(`Got result from event stream, length: ${fullText.length}`)
                const delegateTag = parseDelegate(fullText)
                if (delegateTag) return { type: 'delegate', ...delegateTag }
                return { type: 'done', result: fullText }
            }

            // Fallback: poll messages nếu stream không có text
            return await this._pollForResult()

        } finally {
            this.status = 'idle'
        }
    }

    /**
     * Fallback: poll GET /session/{id}/message to extract the last assistant response.
     */
    async _pollForResult() {
        this._log(`Polling session messages for result...`)
        for (let attempt = 0; attempt < 5; attempt++) {
            if (attempt > 0) {
                this._log(`Poll attempt ${attempt + 1}/5, waiting 3s...`)
                await new Promise(r => setTimeout(r, 3000))
            }
            try {
                const res = await fetch(
                    `http://127.0.0.1:${this.port}/session/${this.sessionId}/message`,
                    { method: 'GET', headers: { 'Accept': 'application/json' } }
                )
                if (res.ok) {
                    const messages = await res.json()
                    this._log(`[poll #${attempt + 1}] got ${Array.isArray(messages) ? messages.length : '?'} messages`)
                    const text = this._extractTextFromMessages(messages)
                    if (text) {
                        this._log(`Extracted text from poll, length: ${text.length}`)
                        const delegateTag = parseDelegate(text)
                        if (delegateTag) return { type: 'delegate', ...delegateTag }
                        return { type: 'done', result: text }
                    }
                }
            } catch (err) {
                this._log(`Poll failed: ${err.message}`)
            }
        }
        this._log(`Warning: no result after all poll attempts`)
        return { type: 'done', result: '[Agent completed but no text response could be extracted]' }
    }

    async markShuttingDown() {
        this._isShuttingDown = true
        this.status = 'shutting_down'
    }

    kill() {
        this._isShuttingDown = true
        this.process?.kill('SIGTERM')
        this.status = 'offline'
    }

    async stop() {
        this.stopWorkerLoop()
        this.kill()
    }

    // ── Worker Loop (DB-Centric, event-driven or polling) ─────────────────

    /**
     * Start processing pending tasks.
     * Phase 1: If eventBus provided, subscribe to task.enqueued events.
     * Otherwise falls back to polling every intervalMs.
     * @param {number|import('./event-bus.js').EventBus} intervalMsOrEventBus
     */
    startWorkerLoop(intervalMsOrEventBus = 3000) {
        if (this._workerTimer || this._workerUnsub) return

        // Phase 1: Event-driven worker
        if (intervalMsOrEventBus && typeof intervalMsOrEventBus === 'object' && intervalMsOrEventBus.on) {
            this._workerUnsub = intervalMsOrEventBus.on('task.enqueued', (event) => {
                const taskRole = event.payload?.role
                // Filter: only react to tasks matching our role (or unspecified role)
                if (taskRole && taskRole !== this.role) return
                this._workerTick()
            })
            console.log(`[${this.agentId}] Worker loop started (event-driven)`)
            // Also run immediately to catch any pending tasks
            this._workerTick()
        } else {
            // Legacy polling fallback
            const intervalMs = typeof intervalMsOrEventBus === 'number' ? intervalMsOrEventBus : 3000
            console.log(`[${this.agentId}] Worker loop started (poll every ${intervalMs}ms)`)
            this._workerTimer = setInterval(() => this._workerTick(), intervalMs)
            // Also run immediately
            this._workerTick()
        }
    }

    stopWorkerLoop() {
        if (this._workerUnsub) {
            this._workerUnsub()
            this._workerUnsub = null
        }
        if (this._workerTimer) {
            clearInterval(this._workerTimer)
            this._workerTimer = null
        }
        this._log(`Worker loop stopped`)
    }

    async _workerTick() {
        if (this.status !== 'idle') return

        try {
            const task = claimTask(this.agentId, this.role)
            if (!task) return  // no pending tasks

            console.log(`[${this.agentId}] 📥 Claimed task ${task.id}: ${task.instruction.slice(0, 60)}...`)

            try {
                const outcome = await this._executeViaOpenCode(task.instruction)

                if (outcome.type === 'delegate') {
                    console.log(`[${this.agentId}] 🔄 Delegating to role=${outcome.role}`)
                    enqueueTask({
                        instruction: outcome.instruction,
                        role: outcome.role,
                        parentId: task.id,
                        telegramChatId: task.telegram_chat_id,
                        telegramMsgId: task.telegram_msg_id,
                        priority: (task.priority || 0) + 1
                    })
                    completeTask(task.id, `[Delegated to ${outcome.role}]`)
                } else {
                    completeTask(task.id, outcome.result)
                }

                console.log(`[${this.agentId}] ✅ Task ${task.id} completed (${(outcome.result || '').length} chars)`)
            } catch (err) {
                console.log(`[${this.agentId}] ❌ Task ${task.id} failed: ${err.message}`)
                failTask(task.id, err.message)
            }
        } catch (err) {
            console.error(`[${this.agentId}] Worker tick error: ${err.message}`)
        }
    }

    // ── Utilities ─────────────────────────────────────────────────────────

    isAlive() {
        return this.process && !this.process.killed && this.status !== 'offline'
    }

    getLogs(tail = 20) {
        return this._logs.slice(-tail)
    }

    _log(msg) {
        const line = `[${new Date().toISOString()}] [${this.agentId}] ${msg}`
        this._logs.push(line)
        if (this._logs.length > 200) this._logs.shift()
        if (process.env.LOG_LEVEL === 'debug') console.log(line)
    }

    /**
     * Extract text content from a JSON response object.
     * Handles multiple possible response structures from OpenCode API.
     */
    _extractTextFromJson(data) {
        // Case 1: Direct text field
        if (typeof data === 'string') return data
        if (data?.text) return data.text

        // Case 2: Array of events (like SSE events bundled as JSON)
        if (Array.isArray(data)) {
            let text = ''
            for (const event of data) {
                const extracted = this._extractTextFromEvent(event)
                if (extracted) text = extracted   // take latest
            }
            if (text) return text
        }

        // Case 3: Single event object
        if (data?.type) {
            const extracted = this._extractTextFromEvent(data)
            if (extracted) return extracted
        }

        // Case 4: Response with parts array (message object)
        if (data?.parts) {
            return this._extractTextFromParts(data.parts)
        }

        // Case 5: Response with data wrapper (SDK format: { data: ... })
        if (data?.data) {
            return this._extractTextFromJson(data.data)
        }

        // Case 6: Response with messages array
        if (data?.messages) {
            return this._extractTextFromMessages(data)
        }

        return null
    }

    /**
     * Extract text from a single SSE-like event object.
     */
    _extractTextFromEvent(event) {
        // message.part.updated with TextPart
        if (event.type === 'message.part.updated') {
            const part = event.part || event.properties?.part
            if (part?.type === 'text' && part?.text) return part.text
        }

        // message.completed
        if (event.type === 'message.completed') {
            const parts = event.message?.parts || event.properties?.parts || []
            const text = parts.filter(p => p.type === 'text').map(p => p.text || '').join('\n')
            if (text) return text
        }

        return null
    }

    /**
     * Extract text from parts array (TextPart[]).
     */
    _extractTextFromParts(parts) {
        if (!Array.isArray(parts)) return null
        const texts = parts
            .filter(p => p.type === 'text' && p.text)
            .map(p => p.text)
        return texts.length > 0 ? texts.join('\n') : null
    }

    /**
     * Extract text from a polled messages response.
     * OpenCode format: Array<{ info: Message, parts: Array<Part> }>
     * Also handles: { data: [...] }, flat array of messages, etc.
     */
    _extractTextFromMessages(data) {
        let messagesList = Array.isArray(data) ? data
            : (data?.data || data?.messages || [])

        if (!Array.isArray(messagesList)) return null

        // Find the last assistant message (iterate backwards)
        for (let i = messagesList.length - 1; i >= 0; i--) {
            const entry = messagesList[i]

            // OpenCode format: { info: Message, parts: Part[] }
            if (entry?.info?.role === 'assistant' && entry?.parts) {
                const text = this._extractTextFromParts(entry.parts)
                if (text) return text
            }

            // Flat message format: { role: 'assistant', parts: [...] }
            if (entry?.role === 'assistant') {
                if (entry.parts) {
                    const text = this._extractTextFromParts(entry.parts)
                    if (text) return text
                }
                if (entry.content) return entry.content
                if (entry.text) return entry.text
            }
        }

        return null
    }
}

export function parseDelegate(text) {
    const match = text.match(/\[DELEGATE:(\w+):(.+?)\]/s)
    if (match) return { role: match[1], instruction: match[2].trim() }
    return null
}