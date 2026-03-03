import { initDB, getRecentTasks, closeDB } from './lib/memory.js'

async function main() {
    await initDB('./data/oc-plugin.db')
    const tasks = getRecentTasks(10)
    console.log(JSON.stringify(tasks, null, 2))
    closeDB()
}

main().catch(console.error)
