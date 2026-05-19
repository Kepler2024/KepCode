import {execa} from 'execa'; // for bash running
import Anthropic from "@anthropic-ai/sdk"; // for anthropic api calls
import 'dotenv/config' // for .env reading
import pc from "picocolors" // for colorful console logs
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const client = new Anthropic(); // create a new anthropic client

const MODEL:string = process.env.MODEL_ID!
const SYSTEM:string = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Ask, don't explain.`  
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
    }
]

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
        })
        
        messages.push({role:"assistant", content:response.content})

        if (response.stop_reason !== "tool_use") {
            return
        }

        const results:Anthropic.ToolResultBlockParam[] = []
        for (const block of response.content) {
            if (block.type === "tool_use") {
                const cmd = (block.input as {command:string}).command
                console.log(pc.yellow(`CMD>> ${cmd}`))
                const output = await runBash(cmd)
                console.log(pc.green(`Bash>> ${output.slice(0,200)}`))
                results.push(
                    {
                        type: "tool_result",
                        tool_use_id: block.id,
                        content: output,
                    }
                )
            }
        }

        messages.push({role:"user", content:results})
    }
}

// main loop
const history:Anthropic.MessageParam[] = []
while (true) {
    const rl = readline.createInterface({ input, output });
    const query = await rl.question(pc.cyan("User>> "))
    if (!query || query.toLowerCase() === "quit") {
        console.log(pc.red("Agent Terminated."))
        break
    }
    history.push({role:"user", content: query})
    await agentLoop(history)
    const finalResponse = history[history.length - 1].content
    if (typeof finalResponse === "string") {
        console.log(pc.magenta(`Agent>> ${finalResponse}`))
    } else {
        for (const block of finalResponse) {
            if (block.type === "text") {
                console.log(pc.magenta(`Agent>> ${block.text}`))
            }
        }
    }
    rl.close()
}
