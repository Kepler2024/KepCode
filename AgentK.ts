import {execa} from 'execa'; // for bash running
import Anthropic from "@anthropic-ai/sdk"; // for anthropic api calls
import 'dotenv/config' // for .env reading
import pc from "picocolors" // for colorful console logs
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process'; // for user input
import { readFile } from 'node:fs/promises'; // for reading local image files
import { extname } from 'node:path';

const client = new Anthropic(); // create a new anthropic client

const MODEL:string = process.env.MODEL_ID!
const SYSTEM:string = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Call view_image when the user references an image or you need to inspect one. Ask, don't explain.`
const TOOLS:Anthropic.Tool[]= [
    {
        name: "bash",
        description: "Run a shell command",
        input_schema: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                }
            },
            required: ["command"]
        }
    },
    {
        name: "view_image",
        description: "Load an image from a local file path or an http(s) URL so you can see it. Supports png, jpg, jpeg, gif, webp.",
        input_schema: {
            type: "object",
            properties: {
                source: {
                    type: "string",
                    description: "Absolute/relative local path or http(s) URL pointing to an image.",
                }
            },
            required: ["source"]
        }
    }
]

const IMAGE_MEDIA_TYPES: Record<string, Anthropic.Base64ImageSource["media_type"]> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

// build an image block from a local path or http(s) URL
async function loadImage(source: string): Promise<Anthropic.ImageBlockParam> {
    const ext = extname(source.split(/[?#]/)[0]).toLowerCase()
    const media = IMAGE_MEDIA_TYPES[ext]
    if (!media) {
        throw new Error(`Unsupported image extension '${ext}'. Supported: ${Object.keys(IMAGE_MEDIA_TYPES).join(", ")}`)
    }
    if (/^https?:\/\//i.test(source)) {
        return { type: "image", source: { type: "url", url: source } }
    }
    const buf = await readFile(source)
    return { type: "image", source: { type: "base64", media_type: media, data: buf.toString("base64") } }
}

// parse the user's typed message, attaching any @-referenced images as image blocks
async function buildUserContent(query: string): Promise<string | Anthropic.ContentBlockParam[]> {
    const re = /@(\S+\.(?:png|jpe?g|gif|webp)(?:\?\S*?)?)(?=$|\s|[,;:.!])/gi
    const refs = [...query.matchAll(re)].map(m => m[1])
    if (refs.length === 0) return query
    const blocks: Anthropic.ContentBlockParam[] = []
    for (const ref of refs) {
        try {
            blocks.push(await loadImage(ref))
            console.log(pc.gray(`[attached image: ${ref}]`))
        } catch (e:any) {
            console.log(pc.red(`[skip image ${ref}: ${e.message}]`))
        }
    }
    blocks.push({ type: "text", text: query })
    return blocks
}

async function runBash(command:string): Promise<string> {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot"]
    if (dangerous.some(d => command.includes(d))) {
        return "Error: Dangerous command aborted."
    }
    try {
        // execute the command using execa
        const {all} = await execa({
            shell:true, // run in local shell
            all:true, // combine stdout and stderr
            timeout:120000, // 2 minute timeout
        })`${command}`
        const out = all.trim()
        // return the output, truncated to 50k characters
        // for commands without output, return "(No output)" to imform LLM the command was executed successfully
        return out ? out.slice(0,50000) : "(No output)"
    } catch (e:any) {
        if (e.timedOut) {
            return "Error: Command timed out."
        }
        return `Error: ${e.shortMessage}`
    }
}

async function agentLoop(messages:Anthropic.MessageParam[]): Promise<void> {
    while (true) {
        const response = await client.messages.create({
            model: MODEL,
            system: SYSTEM,
            messages: messages,
            tools: TOOLS,
            max_tokens:8000,
        }) // this is the response from the LLM

        messages.push({role:"assistant", content:response.content})

        // We stop the loop when LLM stops calling tools
        if (response.stop_reason !== "tool_use") {
            return
        }

        const results:Anthropic.ToolResultBlockParam[] = []
        // dispatch each tool call
        for (const block of response.content) {
            if (block.type !== "tool_use") continue
            if (block.name === "bash") {
                const cmd = (block.input as {command:string}).command
                console.log(pc.yellow(`CMD>> ${cmd}`))
                const output = await runBash(cmd)
                console.log(pc.green(`Bash>> ${output.slice(0,200)}`))
                results.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: output,
                })
            } else if (block.name === "view_image") {
                const src = (block.input as {source:string}).source
                console.log(pc.yellow(`IMG>> ${src}`))
                try {
                    const img = await loadImage(src)
                    results.push({
                        type: "tool_result",
                        tool_use_id: block.id,
                        content: [
                            { type: "text", text: `Loaded image: ${src}` },
                            img,
                        ],
                    })
                    console.log(pc.green(`Image>> loaded`))
                } catch (e:any) {
                    results.push({
                        type: "tool_result",
                        tool_use_id: block.id,
                        content: `Error: ${e.message}`,
                        is_error: true,
                    })
                    console.log(pc.red(`Image>> ${e.message}`))
                }
            }
        }

        // push the results during the whole process to the messages array
        messages.push({role:"user", content:results})
    }
}

// main loop
const history:Anthropic.MessageParam[] = [] // the whole context
const rl = readline.createInterface({ input, output });
while (true) {
    const query = await rl.question(pc.cyan("User>> "))
    if (!query || query.toLowerCase() === "quit") {
        console.log(pc.red("Agent Terminated."))
        rl.close()
        break
    }
    const content = await buildUserContent(query)
    history.push({role:"user", content})
    await agentLoop(history) // the context will be full after the loop ends
    const finalResponse = history[history.length - 1].content // print the final response from the LLM, which will be concluding
    // the final response can be either string or array of blocks
    if (typeof finalResponse === "string") {
        console.log(pc.magenta(`Agent>> ${finalResponse}`))
    } else {
        for (const block of finalResponse) {
            if (block.type === "text") {
                console.log(pc.magenta(`Agent>> ${block.text}`))
            }
        }
    }
}
