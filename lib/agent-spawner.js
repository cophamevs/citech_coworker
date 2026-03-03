import { spawn } from 'child_process'
import { OpencodeClient } from '@opencode-ai/sdk'
import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'
import { loadSkills, formatSkillsPrompt } from './skills.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function loadRolePrompt(role, vars = {}) {
    const promptPath = join(__dirname, '..', 'roles', `${role}.md`)
    let text = await readFile(promptPath, 'utf-8')
    for (const [key, value] of Object.entries(vars)) {
        text = text.replaceAll(`{{${key}}}`, value)
    }
    return text
}

function waitForReady(proc, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Agent process did not become ready within ${timeoutMs}ms`))
        }, timeoutMs)
        const onData = (data) => {
            const text = data.toString()
            if (text.includes('Listening') || text.includes('ready') || text.includes('started')) {
                clearTimeout(timer)
                proc.stdout.off('data', onData)
                resolve()
            }
        }
        proc.stdout.on('data', onData)
        // Fallback: resolve after 3s regardless
        setTimeout(() => {
            clearTimeout(timer)
            proc.stdout.off('data', onData)
            resolve()
        }, 3000)
    })
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
    constructor({ agentId, port, role, workdir, memoryContext = '' }) {
        this.agentId = agentId
        this.port = port
        this.role = role
        this.workdir = resolve(workdir)
        this.memoryContext = memoryContext
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

        await waitForReady(this.process)

        // ✅ Dùng OpencodeClient từ SDK
        this.client = new OpencodeClient({ baseUrl: `http://127.0.0.1:${this.port}` })

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
                noReply: true,
                parts: [{ type: 'text', text: rolePrompt + skillsPrompt }]
            }
        })

        this.status = 'idle'
        this._log(`Agent ready (role: ${this.role})`)
        return this
    }

    async sendTask(instruction) {
        if (this.status !== 'idle') {
            throw new Error(`Agent ${this.agentId} is not idle (status: ${this.status})`)
        }
        this.status = 'busy'
        this._log(`Received task: ${instruction.slice(0, 80)}...`)

        try {
            let stream

            this._log(`Starting stream via fetch SSE`)
            const response = await fetch(
                `http://127.0.0.1:${this.port}/session/${this.sessionId}/message`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'text/event-stream'
                    },
                    body: JSON.stringify({ parts: [{ type: 'text', text: instruction }] })
                }
            )

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${await response.text()}`)
            }

            // Nếu server trả JSON thay vì SSE (do cấu hình back-end)
            if (response.headers.get('content-type')?.includes('application/json')) {
                this._log(`Server returned JSON. Parsing full response.`)
                const data = await response.json()
                // Opencode v2: message content is not straightforwardly here, but we can return it if it is format.
                // Assuming empty result since parsing JSON isn't the primary flow
                return { type: 'done', result: '[Task completed but response format is unsupported JSON]' }
            }

            stream = parseSseStream(response)

            // ── Đọc events ──────────────────────────────────────────────────
            let fullText = ''
            let done = false

            for await (const event of stream) {
                this._log(`[event] ${event.type}`)

                // SDK format: event.type + event.part / event.message
                if (event.type === 'message.part.updated') {
                    const part = event.part || event.properties?.part
                    if (part?.type === 'text' && part?.text) {
                        fullText = part.text
                    }
                }

                // Fetch SSE format: event.properties.field + delta
                if (event.type === 'message.part.delta') {
                    if (event.properties?.field === 'text') {
                        fullText += event.properties.delta || ''
                    }
                }

                // message.completed — assistant turn xong (SDK format)
                if (event.type === 'message.completed') {
                    const parts = event.message?.parts || []
                    const text = parts.filter(p => p.type === 'text').map(p => p.text || '').join('\n')
                    if (text) fullText = text
                    this._log(`Task finished (message.completed), length: ${fullText.length}`)
                    done = true
                    break
                }

                // session.idle — server báo session rảnh (fetch SSE format)
                if (event.type === 'session.idle' ||
                    (event.type === 'session.status' && event.properties?.status?.type === 'idle')) {
                    this._log(`Task finished (session.idle), length: ${fullText.length}`)
                    done = true
                    break
                }

                if (event.type === 'session.error') {
                    throw new Error(event.error || event.properties?.error || 'Unknown session error')
                }
            }

            if (!fullText.trim()) this._log(`Warning: empty result from agent`)

            const delegateTag = parseDelegate(fullText)
            if (delegateTag) return { type: 'delegate', ...delegateTag }
            return { type: 'done', result: fullText }

        } finally {
            this.status = 'idle'
        }
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

    async stop() { this.kill() }

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
}

export function parseDelegate(text) {
    const match = text.match(/\[DELEGATE:(\w+):(.+?)\]/s)
    if (match) return { role: match[1], instruction: match[2].trim() }
    return null
}