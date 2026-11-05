/**
 * createSlackBot: a Slack message starts or continues the pi session of its thread.
 * Built-in commands in a thread: !stop, !status, !model, !help.
 */
import { readFileSync } from "node:fs";
import { uptime } from "node:os";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type RunResult, type ThreadInfo, ThreadAgents, threadKey } from "./agent.ts";
import { saveAttachments } from "./attachments.ts";
import { type BotState, changesSince, readState, restartReason, stateFile, writeState } from "./lifecycle.ts";
import { MAX_RESUMES, RunMarkers } from "./run-markers.ts";
import { type IncomingMessage, SlackBot } from "./slack.ts";
import { CHANGELOG_PATH, PI_VERSION, VERSION } from "./version.ts";

export interface CommandContext {
	thread: ThreadInfo;
	/** Text after the command name, trimmed. */
	args: string;
	user: string;
	reply(text: string): Promise<void>;
}

/** A `!name` command. Returned text is posted in the thread. */
export type Command = (ctx: CommandContext) => Promise<string | void> | string | void;

export interface RunContext {
	thread: ThreadInfo;
	user: string;
	/** Text given to the model (mentions resolved, attachments listed). */
	text: string;
	/** True when the run resumes after a restart. */
	resumed: boolean;
}

export interface SlackBotHooks {
	/** Before each run. Return a string to replace the text given to the model. */
	beforeRun?: (ctx: RunContext) => Promise<string | void> | string | void;
	/** After each run, successful or not (`error` is set when it failed). */
	afterRun?: (ctx: RunContext, result: RunResult | undefined, error?: unknown) => Promise<void> | void;
	/** Once connected to Slack. `reason` explains how the previous process ended. */
	onStart?: (info: { reason: string; botUserId: string }) => Promise<void> | void;
}

export interface SlackBotOptions {
	appToken: string;
	botToken: string;
	/** Slack member IDs allowed to talk to the bot. Required, never empty. */
	allowedUsers: string[];
	/** Root of thread workspaces, run markers and the state file. */
	dataDir: string;
	/** Added to the first message of every thread. Defaults to DEFAULT_SYSTEM_NOTE. */
	systemNote?: string;
	/** Extra pi tools, built for each thread. */
	customTools?: (thread: ThreadInfo) => ToolDefinition[] | Promise<ToolDefinition[]>;
	/** Extra `!name` commands (key without the "!"). Built-in commands win on a name clash. */
	commands?: Record<string, Command>;
	hooks?: SlackBotHooks;
	/** Variable names removed from the agent's shell, on top of the Slack tokens and credential-looking names. */
	secretNames?: string[];
	/** Direct message to allowed users at startup (reason of the restart). Default true. */
	notifyOnStart?: boolean;
}

export interface SlackBotHandle {
	start(): Promise<void>;
	/** Stops cleanly. `signal` is recorded in the state file for the next startup message. */
	stop(signal?: string): Promise<void>;
}

export const RESUME_PROMPT =
	"Resume the work interrupted by the restart. Re-read the context and check the actual state before going on; say what is left if you cannot resume.";

const BUILTIN = new Set(["stop", "status", "model", "help"]);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

export function createSlackBot(options: SlackBotOptions): SlackBotHandle {
	if (!options.appToken?.startsWith("xapp-")) throw new Error("appToken must be the app-level token (xapp-…)");
	if (!options.botToken?.startsWith("xoxb-")) throw new Error("botToken must be the bot token (xoxb-…)");
	const allowed = new Set(options.allowedUsers.map((u) => u.trim()).filter(Boolean));
	if (allowed.size === 0) throw new Error("allowedUsers is empty: list the Slack member IDs allowed to use the bot");

	const { dataDir } = options;
	const agents = new ThreadAgents({ dataDir, systemNote: options.systemNote, customTools: options.customTools, secretNames: options.secretNames });
	const markers = new RunMarkers(dataDir);
	const recovering = new Set<string>();
	const commands = options.commands ?? {};
	let stopping = false;
	let warnedConnections = false;
	let base: BotState | undefined;

	const bot = new SlackBot(options.appToken, options.botToken, (msg) => handle(msg));
	const slack = bot.api;

	const thread = (channel: string, threadTs: string): ThreadInfo => {
		const key = threadKey(channel, threadTs);
		return {
			key,
			channel,
			threadTs,
			workspace: agents.workspaceOf(key),
			post: async (text) => { await slack.post(channel, threadTs, text); },
			upload: (file, filename, comment) => slack.upload(channel, threadTs, file, filename, comment),
		};
	};

	const help = () =>
		[
			"*Commands in a thread*",
			"• `!stop`: stop the current run",
			"• `!status`: state of the thread, model, working directory",
			"• `!model`: list models · `!model <name>`: switch this thread · `!model default <name>`: also pi's default",
			...Object.keys(commands).filter((n) => !BUILTIN.has(n)).map((n) => `• \`!${n}\``),
			"Mention me in a channel, or write to me directly. In a thread I already answer, no mention is needed.",
		].join("\n");

	async function command(msg: IncomingMessage, t: ThreadInfo): Promise<boolean> {
		const m = /^!([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(msg.text.trim());
		if (!m) return false;
		const name = m[1]!.toLowerCase();
		const args = (m[2] ?? "").trim();
		const reply = t.post;
		try {
			if (name === "stop") {
				await reply((await agents.abort(t.key)) ? "_Stopped._" : "_Nothing running._");
				return true;
			}
			if (name === "help") {
				await reply(help());
				return true;
			}
			if (name === "status") {
				const busy = agents.busyInfo(t.key);
				const who = busy?.user ? ` for ${await slack.userName(busy.user)}` : "";
				const state = busy ? `running${who} for ${Math.round((Date.now() - busy.since) / 1000)} s` : recovering.has(t.key) ? "resuming after a restart" : "idle";
				await reply(`_${state} · model \`${await agents.modelLabel(t)}\` · directory \`${t.workspace}\`_`);
				return true;
			}
			if (name === "model") {
				const d = /^(default|défaut|defaut)\s+(.+)$/i.exec(args);
				await reply(!args ? await agents.describeModels(t) : await agents.switchModel(t, d ? d[2]! : args, Boolean(d)));
				return true;
			}
			const custom = commands[name];
			if (!custom) return false;
			const out = await custom({ thread: t, args, user: msg.user, reply });
			if (typeof out === "string" && out) await reply(out);
			return true;
		} catch (e) {
			await reply(`_${errText(e)}_`).catch(() => {});
			return true;
		}
	}

	/** One run with status message, reactions, run marker and hooks. Never throws. */
	async function runInThread(t: ThreadInfo, user: string, text: string, extra: { ts?: string; images?: ImageContent[]; resumed: boolean }): Promise<void> {
		const reactTo = extra.ts;
		const ctx: RunContext = { thread: t, user, text, resumed: extra.resumed };
		const statusTs = await slack.post(t.channel, t.threadTs, "_Working…_").catch(() => undefined);
		const started = Date.now();
		let lastUpdate = 0;
		let count = 0;
		const onTool = (name: string) => {
			count += 1;
			const now = Date.now();
			if (!statusTs || now - lastUpdate < 5000) return; // Slack rate limits: one edit every 5 s at most
			lastUpdate = now;
			void slack.update(t.channel, statusTs, `_Working · ${count} action(s) · last: \`${name}\` · ${Math.round((now - started) / 1000)} s_`).catch(() => {});
		};
		let result: RunResult | undefined;
		let error: unknown;
		let marked = false;
		try {
			markers.start({ channel: t.channel, threadTs: t.threadTs, user });
			marked = true;
			const replaced = await options.hooks?.beforeRun?.(ctx);
			if (typeof replaced === "string") ctx.text = replaced;
			result = await agents.run(t, ctx.text, { onTool, images: extra.images, user });
			const secs = Math.round((Date.now() - started) / 1000);
			if (statusTs) await slack.update(t.channel, statusTs, `_${result.aborted ? "Stopped" : "Done"} · ${result.tools} action(s) · ${secs} s_`).catch(() => {});
			if (!result.aborted) await t.post(result.text);
		} catch (e) {
			error = e;
			console.error("[pi-mom-slack] run error", t.key, e);
			if (statusTs) await slack.update(t.channel, statusTs, "_Failed_").catch(() => {});
			await t.post(`_Error: ${errText(e)}_`).catch(() => {});
		}
		// During shutdown, keep the marker: the next start resumes the run.
		if (marked && !stopping) markers.finish(t);
		if (reactTo) {
			await slack.unreact(t.channel, reactTo, "eyes");
			if (error) await slack.react(t.channel, reactTo, "warning");
			else if (result && !result.aborted) await slack.react(t.channel, reactTo, "white_check_mark");
		}
		await Promise.resolve(options.hooks?.afterRun?.(ctx, result, error)).catch((e) => console.error("[pi-mom-slack] afterRun hook error", e));
	}

	async function handle(msg: IncomingMessage): Promise<void> {
		const t = thread(msg.channel, msg.threadTs);
		if (!allowed.has(msg.user)) {
			// Colleagues talking in a thread the bot follows are not addressing it: only answer a mention or a DM.
			if (msg.isDirect || msg.mentioned) await t.post("_Not authorized. Ask the bot's owner to add your Slack member ID to PI_SLACK_ALLOWED_USERS._");
			return;
		}
		if (await command(msg, t)) return;
		if (recovering.has(t.key) || agents.isBusy(t.key)) {
			await t.post("_Still working on the previous request. `!stop` to stop it._");
			return;
		}
		bot.trackThread(msg.channel, msg.threadTs);
		await slack.react(msg.channel, msg.ts, "eyes");
		const att = await saveAttachments(msg.files, t.workspace, (url, max) => slack.download(url, max));
		if (att.errors.length) await t.post(`_File(s) not retrieved:\n${att.errors.join("\n")}_`);
		const name = await slack.userName(msg.user);
		const body = await slack.resolveMentions(msg.text);
		const files = att.saved.length ? `\n\nAttached files (in the working directory):\n${att.saved.map((p) => `- ${p}`).join("\n")}` : "";
		await runInThread(t, msg.user, `[${name}] ${body}${files}`, { ts: msg.ts, images: att.images, resumed: false });
	}

	async function resumeInterrupted(): Promise<void> {
		const list = markers.list((file) => console.warn(`[pi-mom-slack] invalid run marker ignored: ${file}`));
		for (const marker of list) {
			const t = thread(marker.channel, marker.threadTs);
			recovering.add(t.key);
			void (async () => {
				try {
					bot.trackThread(marker.channel, marker.threadTs);
					if (!allowed.has(marker.user)) {
						await t.post("_Cannot resume: the user who started the run is no longer allowed._");
						markers.finish(marker);
						return;
					}
					// A run that crashes the bot would otherwise be resumed, crash it again, and loop forever.
					if (markers.bump(marker) > MAX_RESUMES) {
						await t.post(`_Resume abandoned after ${MAX_RESUMES} attempts: this run may be crashing the bot. Check the logs, then ask again._`);
						markers.finish(marker);
						return;
					}
					await t.post("Resuming after a restart.");
					recovering.delete(t.key);
					await runInThread(t, marker.user, RESUME_PROMPT, { resumed: true });
				} catch (e) {
					// Keep the marker: the next restart tries again, within MAX_RESUMES.
					console.error("[pi-mom-slack] resume failed", t.key, e);
				} finally {
					recovering.delete(t.key);
				}
			})();
		}
	}

	return {
		async start() {
			const file = stateFile(dataDir);
			const prev = readState(file);
			let changes: string[] = [];
			if (prev?.version && prev.version !== VERSION) {
				try { changes = changesSince(readFileSync(CHANGELOG_PATH, "utf8"), prev.version, VERSION); } catch {}
			}
			const reason = restartReason(prev, { version: VERSION, piVersion: PI_VERSION, machineUptimeSec: uptime(), changes });
			base = { status: "running", pid: process.pid, startedAt: new Date().toISOString(), version: VERSION, piVersion: PI_VERSION };
			writeState(file, base);
			bot.onConnections = (n) => {
				const text = `Slack reports ${n} connections for this app. Another process is probably running with the same tokens: Slack spreads events across connections at random, so each process misses some messages. Stop the other one.`;
				console.warn(`[pi-mom-slack] ${text}`);
				if (warnedConnections) return;
				warnedConnections = true;
				for (const user of allowed) void slack.dm(user, `:warning: ${text}`).catch(() => {});
			};
			await bot.start();
			console.log(`[pi-mom-slack] ${VERSION} (pi ${PI_VERSION}) connected · bot ${bot.botUserId} · data in ${dataDir} · ${allowed.size} allowed user(s)`);
			await resumeInterrupted().catch((e) => console.error("[pi-mom-slack] reading run markers failed", e));
			if (options.notifyOnStart !== false) {
				for (const user of allowed) void slack.dm(user, `pi-mom-slack is up.\n${reason}`).catch((e) => console.warn(`[pi-mom-slack] startup message not sent to ${user}: ${errText(e)}`));
			}
			await options.hooks?.onStart?.({ reason, botUserId: bot.botUserId });
		},
		async stop(signal = "stop") {
			if (stopping) return;
			stopping = true;
			if (base) writeState(stateFile(dataDir), { ...base, status: "stopped", endedAt: new Date().toISOString(), signal });
			await bot.stop().catch(() => {});
			await agents.disposeAll();
		},
	};
}

/** Records a fatal error in the state file, so the next startup message explains it. */
export function recordCrash(dataDir: string, err: unknown): void {
	const file = stateFile(dataDir);
	const prev = readState(file);
	const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
	writeState(file, {
		status: "crashed",
		pid: process.pid,
		startedAt: prev?.pid === process.pid ? prev.startedAt : new Date().toISOString(),
		version: VERSION,
		piVersion: PI_VERSION,
		endedAt: new Date().toISOString(),
		error: text,
	});
}
