# OpenCode Multi-Agent Plugin Layer

> Control multiple OpenCode AI agents via HTTP API, Telegram, and CLI.

## Architecture

```
[Telegram / CLI]
       │
       ▼
┌─────────────────────────────────────┐
│         Orchestrator (Node.js)      │
│  ┌──────────────┐  ┌─────────────┐  │
│  │ Task Router  │  │  Registry   │  │
│  └──────────────┘  └─────────────┘  │
│  ┌──────────────────────────────┐   │
│  │      Memory (SQLite)         │   │
│  └──────────────────────────────┘   │
└───────────┬───────────┬─────────────┘
            │           │
      @opencode/sdk  @opencode/sdk
            │           │
     [opencode serve  [opencode serve
       --port 4096]    --port 4097]
       (agent-01)      (agent-02)
       role: coder     role: sysadmin
```

## Quick Start

### 1. Prerequisites

```bash
# Install opencode globally
npm install -g opencode-ai

# Check it's available
opencode --version
```

### 2. Setup

```bash
cd oc-plugin
npm install

# Copy and edit environment config
cp .env.example .env
# → Set TELEGRAM_TOKEN if you want Telegram integration
```

### 3. Run

```bash
# Start the full system (spawns configured agents + Telegram bot)
npm start

# Or for development (auto-restart on file change)
npm run dev
```

### 4. Use via CLI

```bash
# Submit a task (role auto-detected from keywords)
node index.js task "fix the login bug in auth.js"
node index.js task "check disk usage on /var/log"
node index.js task "explain how JWT refresh tokens work"

# Force a specific role
node index.js task "deploy updates to prod" --role sysadmin

# List agent status
node index.js status

# View recent task history
node index.js history --limit 5

# View logs for agent-01
node index.js logs agent-01 --tail 30

# Store a shared memory entry
node index.js memory set "prod-server" "192.168.1.100"

# Spawn additional agent
node index.js spawn --role researcher
```

### 5. Telegram Bot

Once `TELEGRAM_TOKEN` is set in `.env`:

| Command | Description |
|---|---|
| `/task <instruction>` | Submit task to best available agent |
| `/status` | View all agents and their status |
| `/history` | Show last 10 completed tasks |
| `/help` | Command reference |

## Configuration (`config.json`)

| Key | Default | Description |
|---|---|---|
| `shutdown_timeout` | 60 | Seconds to wait for tasks to finish on shutdown |
| `heartbeat_interval` | 30 | Seconds between agent health checks |
| `task_timeout` | 300 | Max seconds per task before timeout |
| `max_retries` | 3 | Retry attempts on transient errors |
| `memory_limit_per_agent` | 50 | Max memory entries stored per agent |
| `memory_inject_count` | 5 | Memory entries injected into role prompt |
| `agents` | `[...]` | List of agents to spawn at startup |

## Multi-Agent Delegation

Agents can hand off work to each other using a special tag in their response:

```
[DELEGATE:sysadmin:check available disk space on /var/log]
```

The orchestrator detects this tag and dispatches a sub-task to a `sysadmin` agent automatically.

## File Structure

```
oc-plugin/
├── index.js                ← entry point (run this)
├── config.json             ← agent pool + system config
├── .env                    ← secrets (TELEGRAM_TOKEN, etc.)
├── lib/
│   ├── agent-spawner.js    ← spawns opencode serve, manages sessions
│   ├── registry.js         ← tracks all live agents
│   ├── orchestrator.js     ← task routing + delegation
│   ├── memory.js           ← SQLite persistence (tasks + memories)
│   ├── heartbeat.js        ← health monitoring + auto-restart
│   ├── retry.js            ← retry/timeout logic
│   └── security.js         ← rate limiting, input validation, auth
├── adapters/
│   ├── telegram.js         ← Telegram bot interface
│   └── cli.js              ← CLI interface
└── roles/
    ├── coder.md            ← system prompt: coder role
    ├── sysadmin.md         ← system prompt: sysadmin role
    └── researcher.md       ← system prompt: researcher role
```

## SQLite Database

Stored at `./data/oc-plugin.db`. Tables:
- **`tasks`** — full task lifecycle (instruction → result → status)
- **`memories`** — key-value store injected into agent prompts

> Uses Node.js 22+ built-in `node:sqlite` or falls back to `node-sqlite3-wasm` (pure WASM, no native compilation).

## Proof of Concept (test without spawning)

```bash
# Terminal 1: run a single opencode instance
opencode serve --port 4096

# Terminal 2: test the HTTP API directly
node -e "
import('@opencode-ai/sdk').then(({ createOpencodeClient }) => {
  const client = createOpencodeClient({ baseUrl: 'http://localhost:4096' })
  client.session.create({ body: { title: 'test' } }).then(async session => {
    console.log('Session:', session.data.id)
    const stream = await client.session.prompt({
      path: { id: session.data.id },
      body: { parts: [{ type: 'text', text: 'List files in current dir' }] }
    })
    for await (const event of stream) {
      if (event.type === 'message.part.updated')
        process.stdout.write(event.part?.text?.delta || '')
    }
  })
})
"
```
