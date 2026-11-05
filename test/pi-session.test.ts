/**
 * End to end with the real pi session, against a local OpenAI-compatible server that plays a scripted model.
 * No network: the "model" runs on 127.0.0.1.
 */
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

type Step = { text: string } | { tool: string; args: Record<string, unknown> };
const script: Step[] = [];
const requests: { messages: { role: string; content: unknown }[] }[] = [];
let server: Server;
const dir = mkdtempSync(join(tmpdir(), "pi-e2e-"));

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
	return `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

beforeAll(async () => {
	server = createServer((req, res) => {
		let body = "";
		req.on("data", (d) => { body += d; });
		req.on("end", () => {
			requests.push(JSON.parse(body));
			const step = script.shift() ?? { text: "(script exhausted)" };
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(chunk({ role: "assistant" }));
			if ("text" in step) {
				res.write(chunk({ content: step.text }));
				res.write(chunk({}, "stop"));
			} else {
				res.write(chunk({ tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }));
				res.write(chunk({}, "tool_calls"));
			}
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { local: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "test", models: [{ id: "fake" }] } } }));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "fake" }));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-must-not-leak");
});

afterAll(() => {
	server?.close();
	vi.unstubAllEnvs();
});

const lastToolOutput = (i: number) => JSON.stringify(requests[i]?.messages.filter((m) => m.role === "tool").at(-1));

it("runs tools in the thread workspace, scrubs secrets, uploads, pushes past an announcement, and resumes the session", async () => {
	const { ThreadAgents, CONTINUE_PROMPT } = await import("../src/agent.ts");
	const uploads: [string, string, string | undefined][] = [];
	const thread = (key: string, agents: InstanceType<typeof ThreadAgents>) => ({
		key, channel: "C1", threadTs: "1.1", workspace: agents.workspaceOf(key),
		post: async () => {},
		upload: async (file: Buffer, name: string, comment?: string) => { uploads.push([file.toString(), name, comment]); },
	});

	script.push(
		{ tool: "bash", args: { command: "echo token=${SLACK_BOT_TOKEN:-none}; pwd; echo hello > out.txt" } },
		{ tool: "slack_upload", args: { path: "out.txt", comment: "the file" } },
		{ text: "Uploaded. I'll now write the summary." },
		{ text: "Done: out.txt is in the thread. Nothing left." },
	);
	const agents = new ThreadAgents({ dataDir: join(dir, "data") });
	const t = thread("C1-1_1", agents);
	const tools: string[] = [];
	const r = await agents.run(t, "[Ada] make a file and send it", { onTool: (n) => tools.push(n) });

	expect(r).toEqual({ text: "Done: out.txt is in the thread. Nothing left.", aborted: false, tools: 2 });
	expect(tools).toEqual(["bash", "slack_upload"]);
	expect(lastToolOutput(1)).toContain("token=none");
	expect(lastToolOutput(1)).toContain(t.workspace);
	expect(uploads).toEqual([["hello\n", "out.txt", "the file"]]);
	expect(JSON.stringify(requests[0]!.messages)).toContain("Your current working directory belongs to this Slack thread");
	expect(JSON.stringify(requests[3]!.messages.at(-1))).toContain(CONTINUE_PROMPT.slice(0, 40));
	expect(await agents.modelLabel(t)).toBe("local/fake");
	await agents.disposeAll();

	// A new process picks up the same thread session from disk: the earlier exchange is in the next request.
	script.push({ text: "Still here." });
	const restarted = new ThreadAgents({ dataDir: join(dir, "data") });
	const again = await restarted.run(thread("C1-1_1", restarted), "[Ada] are you there?");
	expect(again.text).toBe("Still here.");
	const history = JSON.stringify(requests.at(-1)!.messages);
	expect(history).toContain("make a file and send it");
	expect(history).not.toContain("Your current working directory belongs to this Slack thread\\n\\n[Ada] are you there?");
	await restarted.disposeAll();
}, 60_000);
