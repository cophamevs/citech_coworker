import { OpencodeClient } from '@opencode-ai/sdk'

async function test() {
    console.log("Connecting to coder agent on port 4096...")
    const client = new OpencodeClient({ baseUrl: 'http://127.0.0.1:4096' })

    // 1. Create a session
    const sessionResponse = await client.session.create({
        body: { title: 'Test Plan vs Build' }
    })
    const sessionId = sessionResponse.data.id
    console.log("Session created:", sessionId)

    // 2. Prompt with agent: 'plan'
    console.log("Sending prompt with agent: 'plan'...")
    const promptResponse = await client.session.prompt({
        path: { id: sessionId },
        body: {
            agent: 'plan', // explicitly testing 'plan'
            parts: [{ type: 'text', text: 'Hello, what is your role? Are you planning or building?' }]
        }
    })
    console.log("Prompt Response Agent:", promptResponse.data.info.agent)
    console.log("Prompt Response Text:", promptResponse.data.parts.find(p => p.type === 'text')?.text)

    // 3. Prompt with agent: 'build'
    console.log("\nSending prompt with agent: 'build'...")
    const promptResponse2 = await client.session.prompt({
        path: { id: sessionId },
        body: {
            agent: 'build', // explicitly testing 'build'
            parts: [{ type: 'text', text: 'And now what is your role?' }]
        }
    })
    console.log("Prompt Response 2 Agent:", promptResponse2.data.info.agent)
    console.log("Prompt Response 2 Text:", promptResponse2.data.parts.find(p => p.type === 'text')?.text)
}

test().catch(console.error)
