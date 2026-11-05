/**
 * One pi session per Slack thread. Each thread gets its own working directory; pi persists the session and picks it
 * up again after a restart (SessionManager.continueRecent), so a thread keeps its context.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createBashToolDefinition,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { scrubEnv } from "./agent-env.ts";
import { formatModels, label, resolveModel } from "./models.ts";
import { RunProcesses } from "./run-processes.ts";
import { slackUploadTool } from "./upload-tool.ts";

/** What tools, commands and hooks know about the thread they act in. */
export interface ThreadInfo {
	/** Filesystem-safe id of the thread: `<channel>-<ts>`. */
	key: string;
	channel: string;
	threadTs: string;
	/** The agent's working directory for this thread. */
	workspace: string;
	/** Posts a message in the thread. */
	post(text: string): Promise<void>;
	/** Uploads a file into the thread. */
	upload(file: Buffer, filename: string, comment?: string): Promise<void>;
}

export interface RunResult {
	text: string;
	aborted: boolean;
	tools: number;
}

export const DEFAULT_SYSTEM_NOTE = [
	"You are pi, working for the team through Slack. Reply in the language of the user, directly and briefly. Slack renders *bold*, _italic_, `code` and ``` blocks, not Markdown headings or tables.",
	"Your current working directory belongs to this Slack thread: create and edit your files here.",
	"To share a file in the thread, use the slack_upload tool.",
	"End with a short report: what is done, where the files are, what is left.",
].join("\n");

export const CONTINUE_PROMPT =
	"Continue: do what you just announced now, without stopping on an announcement. End with the short report (done, files, left).";

/** A final reply that only announces work ("I'll now…", "Je vais…") instead of reporting it. */
export function looksLikeAnnouncement(text: string): boolean {
	const t = text.trim();
	if (!t || t.length > 600 || t.includes("?")) return false;
	const last = t.split(/(?<=[.!:…])\s+|\n+/).filter(Boolean).pop() ?? t;
	return /\b(let me|i'll|i will|i'm going to|i am going to|now i|next,? i|je vais|je m'en occupe|je commence|je lance|je passe à|je m'y mets|allons-y)\b/i.test(last) || /:\s*$/.test(t);
}

export function threadKey(channel: string, threadTs: string): string {
	return `${channel}-${threadTs.replace(".", "_")}`;
}

export interface ThreadAgentsOptions {
	dataDir: string;
	systemNote?: string;
	customTools?: (thread: ThreadInfo) => ToolDefinition[] | Promise<ToolDefinition[]>;
	/** Variable names removed from the agent's shell, on top of credential-looking names. */
	secretNames?: string[];
}

const BUILTIN = ["read", "ls", "find", "grep", "bash", "edit", "write"];
const MAX_CONTINUES = 2;

export class ThreadAgents {
	private sessions = new Map<string, Promise<AgentSession>>();
	private busy = new Map<string, { since: number; user?: string }>();
	private processes = new Map<string, RunProcesses>();
	private options: ThreadAgentsOptions;

	constructor(options: ThreadAgentsOptions) {
		this.options = options;
	}

	workspaceOf(key: string): string {
		return join(this.options.dataDir, "threads", key);
	}

	busyInfo(key: string): { since: number; user?: string } | undefined {
		return this.busy.get(key);
	}

	isBusy(key: string): boolean {
		return this.busy.has(key);
	}

	private session(thread: ThreadInfo): Promise<AgentSession> {
		let s = this.sessions.get(thread.key);
		if (!s) {
			const cwd = thread.workspace;
			mkdirSync(cwd, { recursive: true });
			const processes = new RunProcesses();
			this.processes.set(thread.key, processes);
			const secretNames = this.options.secretNames ?? [];
			s = (async () => {
				const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true });
				await loader.reload();
				const bash = createBashToolDefinition(cwd, { operations: processes.operations(), spawnHook: (c) => ({ ...c, env: scrubEnv(c.env, secretNames) }) });
				const extra = (await this.options.customTools?.(thread)) ?? [];
				const customTools = [bash, slackUploadTool(cwd, thread.upload), ...extra] as unknown as ToolDefinition[];
				const tools = [...new Set([...BUILTIN, ...customTools.map((t) => t.name)])];
				const result = await createAgentSession({ cwd, resourceLoader: loader, tools, customTools, sessionManager: SessionManager.continueRecent(cwd) });
				return result.session;
			})();
			s.catch(() => this.sessions.delete(thread.key));
			this.sessions.set(thread.key, s);
		}
		return s;
	}

	/** Runs one prompt to completion. The system note is added to the first message of a thread. */
	async run(thread: ThreadInfo, text: string, opts: { onTool?: (name: string) => void; images?: ImageContent[]; user?: string } = {}): Promise<RunResult> {
		this.busy.set(thread.key, { since: Date.now(), user: opts.user });
		let tools = 0;
		let aborted = false;
		let unsubscribe = () => {};
		try {
			const session = await this.session(thread);
			const isFirst = session.messages.length === 0;
			const note = this.options.systemNote ?? DEFAULT_SYSTEM_NOTE;
			const prompt = [isFirst ? note : "", text].filter(Boolean).join("\n\n");
			unsubscribe = session.subscribe((e) => {
				if (e.type === "tool_execution_start") {
					tools += 1;
					opts.onTool?.(e.toolName);
				}
				if (e.type === "agent_settled") aborted = e.aborted;
			});
			const images = opts.images ?? [];
			const readsImages = session.model?.input?.includes("image") ?? false;
			const imageNote = images.length && !readsImages ? "\n\n(The current model does not read images: they are only saved in files/.)" : "";
			await session.prompt(prompt + imageNote, readsImages && images.length ? { images } : undefined);
			// Models sometimes end the turn on "I will now…": push the work through instead of leaving an announcement.
			for (let i = 0; i < MAX_CONTINUES && !aborted && looksLikeAnnouncement(session.getLastAssistantText() ?? ""); i++) {
				await session.prompt(CONTINUE_PROMPT);
			}
			return { text: session.getLastAssistantText() ?? "", aborted, tools };
		} finally {
			this.processes.get(thread.key)?.cleanup();
			unsubscribe();
			this.busy.delete(thread.key);
		}
	}

	/** Model of the thread, for !status. */
	async modelLabel(thread: ThreadInfo): Promise<string> {
		const session = await this.session(thread);
		return session.model ? label(session.model) : "(pi default)";
	}

	async describeModels(thread: ThreadInfo): Promise<string> {
		const session = await this.session(thread);
		return formatModels(await session.modelRuntime.getAvailable(), session.model);
	}

	/** Switches the thread's model (kept in its session); with persist, also pi's default model. */
	async switchModel(thread: ThreadInfo, spec: string, persist: boolean): Promise<string> {
		if (this.busy.has(thread.key)) throw new Error("A run is in progress in this thread: switch after it, or `!stop` first.");
		const session = await this.session(thread);
		const found = resolveModel(spec, await session.modelRuntime.getAvailable());
		if ("error" in found) throw new Error(found.error);
		await session.setModel(found.model, { persist });
		return persist ? `Model of this thread and pi's default: \`${label(found.model)}\`.` : `Model of this thread: \`${label(found.model)}\`.`;
	}

	async abort(key: string): Promise<boolean> {
		const s = this.sessions.get(key);
		if (!s || !this.busy.has(key)) return false;
		await (await s).abort();
		return true;
	}

	async disposeAll(): Promise<void> {
		for (const s of this.sessions.values()) (await s.catch(() => null))?.dispose();
		this.sessions.clear();
		for (const p of this.processes.values()) p.cleanup();
		this.processes.clear();
	}
}
