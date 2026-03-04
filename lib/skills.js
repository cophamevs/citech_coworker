import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import yaml from 'js-yaml'

/**
 * Skill Registry logic to load modular capabilities
 */
export async function loadSkills(skillsDir) {
    const skills = []
    try {
        const files = await readdir(skillsDir)
        for (const file of files) {
            if (file.endsWith('.md')) {
                const content = await readFile(join(skillsDir, file), 'utf-8')

                // Simple YAML frontmatter parser
                const match = content.match(/^---\r?\n([\s\S]+?)\r?\n---/)
                if (match) {
                    try {
                        const metadata = yaml.load(match[1])
                        const body = content.slice(match[0].length).trim()
                        skills.push({
                            ...metadata,
                            content: body
                        })
                    } catch (e) {
                        console.error(`Error parsing frontmatter in ${file}:`, e)
                    }
                }
            }
        }
    } catch (e) {
        console.warn(`Could not load skills from ${skillsDir}:`, e.message)
    }
    return skills
}

/**
 * Format skills for injection into system prompt
 */
export function formatSkillsPrompt(skills) {
    if (skills.length === 0) return ''

    let prompt = '\n## CÁC KỸ NĂNG CÓ SẴN (CAPABILITIES)\n'
    for (const skill of skills) {
        prompt += `### Skill: ${skill.name}\n${skill.description}\n\n${skill.content}\n\n---\n`
    }
    return prompt
}
