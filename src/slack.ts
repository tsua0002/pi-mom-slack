/**
 * Slack transport over Socket Mode. Keeps only what the bot needs: mentions in channels, direct messages, and
 * follow-ups in threads the bot already answers. Every reply goes to the thread of the triggering message.
 */
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

export interface SlackFile {
	name: string;
	mimetype: string;
	size: number;
	url: string;
}

export interface IncomingMessage {
	channel: string;
	/** Root of the thread the conversation lives in. */
	threadTs: string;
	ts: string;
	user: string;
	/** Text without the bot mention, Slack entities decoded. Other user mentions stay as <@U…>. */
	text: string;
	isDirect: boolean;
	/** The bot was mentioned (always false in a direct message). */
	mentioned?: boolean;
	files: SlackFile[];
}

export type Handler = (msg: IncomingMessage) => Promise<void>;

const MAX = 3800;
/** How long the Socket Mode connection may stay down before the process gives up (PI_SLACK_SOCKET_DOWN_LIMIT_MS). */
const SOCKET_DOWN_LIMIT_MS = Number(process.env.PI_SLACK_SOCKET_DOWN_LIMIT_MS ?? 180_000);

/** Splits long text on line boundaries to stay under Slack's message limit. */
export function chunk(text: string, max = MAX): string[] {
	if (text.length <= max) return [text];
	const out: string[] = [];
	let cur = "";
	for (const line of text.split("\n")) {
		if (cur.length + line.length + 1 > max && cur) {
			out.push(cur);
			cur = "";
		}
		if (line.length > max) for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
		else cur = cur ? `${cur}\n${line}` : line;
	}
	if (cur) out.push(cur);
	return out;
}

/** Slack escapes &, < and > in message text. */
export const decodeEntities = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Only Slack's own file hosts receive the bot token. */
export function isSlackFileUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === "https:" && (u.hostname === "files.slack.com" || u.hostname.endsWith(".slack.com"));
	} catch {
		return false;
	}
}

const slackError = (e: unknown) => (e as { data?: { error?: string } })?.data?.error;

export class SlackApi {
	readonly web: WebClient;
	private names = new Map<string, string>();

	constructor(web: WebClient) {
		this.web = web;
	}

	async post(channel: string, threadTs: string, text: string): Promise<string | undefined> {
		let ts: string | undefined;
		for (const part of chunk(text || "_(empty reply)_")) {
			const r = await this.web.chat.postMessage({ channel, thread_ts: threadTs, text: part, unfurl_links: false });
			ts ??= r.ts;
		}
		return ts;
	}

	async update(channel: string, ts: string, text: string): Promise<void> {
		await this.web.chat.update({ channel, ts, text: chunk(text)[0]! });
	}

	/** Opens a direct conversation (im:write) and posts in it. */
	async dm(user: string, text: string): Promise<void> {
		const r = await this.web.conversations.open({ users: user });
		const channel = r.channel?.id;
		if (!channel) throw new Error(`no direct conversation for ${user}`);
		await this.web.chat.postMessage({ channel, text });
	}

	/** Adds a reaction (reactions:write). Already present is fine; other failures are only logged. */
	async react(channel: string, ts: string, name: string): Promise<void> {
		try {
			await this.web.reactions.add({ channel, timestamp: ts, name });
		} catch (e) {
			if (slackError(e) !== "already_reacted") console.warn(`[slack] reaction ${name} not added: ${slackError(e) ?? e}`);
		}
	}

	async unreact(channel: string, ts: string, name: string): Promise<void> {
		try {
			await this.web.reactions.remove({ channel, timestamp: ts, name });
		} catch (e) {
			if (slackError(e) !== "no_reaction") console.warn(`[slack] reaction ${name} not removed: ${slackError(e) ?? e}`);
		}
	}

	/** Uploads a file into a thread (files:write). */
	async upload(channel: string, threadTs: string, file: Buffer, filename: string, comment?: string): Promise<void> {
		await this.web.filesUploadV2({ channel_id: channel, thread_ts: threadTs, file, filename, ...(comment ? { initial_comment: comment } : {}) });
	}

	/** Downloads a private Slack file with the bot token (files:read). */
	async download(url: string, maxBytes: number): Promise<Buffer> {
		if (!isSlackFileUrl(url)) throw new Error("not a Slack file URL");
		const r = await fetch(url, { headers: { authorization: `Bearer ${this.web.token}` }, signal: AbortSignal.timeout(60_000) });
		if (!r.ok) throw new Error(`Slack download HTTP ${r.status}`);
		// Without files:read, Slack answers 200 with its HTML login page instead of the file.
		if ((r.headers.get("content-type") ?? "").startsWith("text/html")) throw new Error("Slack returned an HTML page: add the files:read scope to the app and reinstall it");
		const len = Number(r.headers.get("content-length") ?? 0);
		if (len > maxBytes) throw new Error(`file too large (${Math.round(len / 1e6)} MB)`);
		const buf = Buffer.from(await r.arrayBuffer());
		if (buf.length > maxBytes) throw new Error(`file too large (${Math.round(buf.length / 1e6)} MB)`);
		return buf;
	}

	/** Display name of a user (users:read), cached. Falls back to the ID. */
	async userName(id: string): Promise<string> {
		const cached = this.names.get(id);
		if (cached) return cached;
		try {
			const r = await this.web.users.info({ user: id });
			const p = r.user?.profile;
			const name = p?.display_name || p?.real_name || r.user?.real_name || r.user?.name || id;
			this.names.set(id, name);
			return name;
		} catch {
			return id;
		}
	}

	/** Replaces <@U…> mentions with @name, for the text given to the model. */
	async resolveMentions(text: string): Promise<string> {
		const ids = [...new Set([...text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!))];
		let out = text;
		for (const id of ids) {
			const name = await this.userName(id);
			out = out.replace(new RegExp(`<@${id}(?:\\|[^>]*)?>`, "g"), `@${name}`);
		}
		return out;
	}
}

export class SlackBot {
	readonly api: SlackApi;
	botUserId = "";
	private socket: SocketModeClient;
	private handler: Handler;
	private seen = new Map<string, number>();
	private activeThreads = new Set<string>();
	private stopping = false;
	/** Called when Slack reports more than one open Socket Mode connection for this app. */
	onConnections?: (count: number) => void;

	constructor(appToken: string, botToken: string, handler: Handler) {
		this.handler = handler;
		this.socket = new SocketModeClient({ appToken });
		this.api = new SlackApi(new WebClient(botToken));
	}

	/** Marks a thread as handled, so plain replies in it (without a mention) are picked up. */
	trackThread(channel: string, threadTs: string): void {
		this.activeThreads.add(`${channel}:${threadTs}`);
	}

	private claim(channel: string, ts: string): boolean {
		const k = `${channel}:${ts}`;
		const now = Date.now();
		for (const [key, t] of this.seen) if (now - t > 600_000) this.seen.delete(key);
		if (this.seen.has(k)) return false;
		this.seen.set(k, now);
		return true;
	}

	async start(): Promise<void> {
		console.log("[pi-mom-slack] connecting to Slack…");
		const auth = await this.api.web.auth.test().catch((e: unknown) => {
			throw new Error(tokenHint(e, "SLACK_BOT_TOKEN (xoxb-…): reinstall the app and copy the Bot User OAuth Token"));
		});
		this.botUserId = auth.user_id ?? "";
		// @slack/socket-mode 3.x emits events_api envelopes under the inner event type ("app_mention", "message"),
		// never as "events_api". "slack_event" carries every envelope with its type, so we listen there.
		this.socket.on("slack_event", async ({ type, body, ack }) => {
			if (type !== "events_api") return;
			await ack();
			await this.dispatch(body);
		});
		// The hello message says how many connections the app has. Slack spreads events across them at random,
		// so a second process on the same app silently steals half of the messages.
		this.socket.on("ws_message", (data: unknown) => {
			const n = helloConnections(data);
			if (n && n > 1) this.onConnections?.(n);
		});
		this.watchConnection();
		await this.socket.start().catch((e: unknown) => {
			throw new Error(tokenHint(e, "SLACK_APP_TOKEN (xapp-…): create an app-level token with the connections:write scope, and enable Socket Mode"));
		});
	}

	/** Handles the payload of one events_api envelope. Public for tests. */
	async dispatch(body: unknown): Promise<void> {
		// biome-ignore lint/suspicious/noExplicitAny: Slack event payloads are untyped here
		const e = (body as any)?.event;
		if (process.env.PI_SLACK_DEBUG) console.log(`[slack] event type=${e?.type} channel_type=${e?.channel_type} subtype=${e?.subtype ?? "-"}`);
		// file_share is a normal message with attachments; every other subtype (edits, joins, bots) is ignored.
		if (!e || e.bot_id || (e.subtype && e.subtype !== "file_share") || !e.user || e.user === this.botUserId || typeof e.text !== "string") return;
		const isDirect = e.channel_type === "im";
		const threadTs: string = e.thread_ts ?? e.ts;
		const mention = `<@${this.botUserId}>`;
		const mentioned = e.type === "app_mention" || e.text.includes(mention);
		const inActiveThread = Boolean(e.thread_ts) && this.activeThreads.has(`${e.channel}:${e.thread_ts}`);
		// In channels, a mention arrives twice (app_mention and message): only app_mention counts, unless the thread
		// is already active, where a plain reply is enough.
		if (e.type === "message" && !isDirect && !inActiveThread) return;
		if (!(mentioned || isDirect || inActiveThread)) return;
		if (!this.claim(e.channel, e.ts)) return;
		const text = decodeEntities(e.text.split(mention).join("")).trim();
		const files: SlackFile[] = Array.isArray(e.files)
			? e.files
					// biome-ignore lint/suspicious/noExplicitAny: untyped Slack payload
					.filter((f: any) => f && typeof f.url_private === "string")
					// biome-ignore lint/suspicious/noExplicitAny: untyped Slack payload
					.map((f: any) => ({ name: String(f.name ?? "file"), mimetype: String(f.mimetype ?? ""), size: Number(f.size ?? 0), url: f.url_private }))
			: [];
		await this.handler({ channel: e.channel, threadTs, ts: e.ts, user: e.user, text, isDirect, mentioned, files }).catch((err: unknown) =>
			console.error("[slack] handler error", err),
		);
	}

	/**
	 * Slack closes Socket Mode connections regularly (about once an hour, and on network hiccups); the client reconnects
	 * on its own, which shows up as "WebSocket error" in the logs. Each transition is logged, and if the connection
	 * stays down longer than SOCKET_DOWN_LIMIT_MS the process fails on purpose: a supervisor (systemd) restarts it and
	 * the startup message gives the reason, instead of a process that runs without ever receiving a message.
	 */
	private watchConnection(): void {
		let downSince: number | null = null;
		let timer: NodeJS.Timeout | undefined;
		const down = (state: string) => {
			if (this.stopping) return;
			console.warn(`[slack] connection ${state}, reconnecting`);
			downSince ??= Date.now();
			timer ??= setTimeout(() => {
				if (this.stopping || downSince === null) return;
				throw new Error(`Slack connection lost for ${Math.round((Date.now() - downSince) / 1000)} s without reconnecting`);
			}, SOCKET_DOWN_LIMIT_MS);
		};
		this.socket.on("disconnected", () => down("closed"));
		this.socket.on("reconnecting", () => down("lost"));
		this.socket.on("connected", () => {
			if (downSince !== null) console.log(`[slack] reconnected after ${Math.round((Date.now() - downSince) / 1000)} s`);
			downSince = null;
			if (timer) clearTimeout(timer);
			timer = undefined;
		});
	}

	async stop(): Promise<void> {
		this.stopping = true;
		await this.socket.disconnect();
	}
}

/** Turns Slack's auth errors into a message that says which token to fix. */
export function tokenHint(e: unknown, which: string): string {
	const code = slackError(e) ?? (e instanceof Error ? e.message : String(e));
	return /invalid_auth|not_authed|account_inactive|token_revoked|not_allowed_token_type/.test(code) ? `Slack rejected ${which} (${code})` : `Slack connection failed: ${code}`;
}

/** num_connections of a Socket Mode hello message, if that is what `data` is. */
export function helloConnections(data: unknown): number | undefined {
	try {
		const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : "";
		if (!text.includes('"hello"')) return undefined;
		const m = JSON.parse(text) as { type?: string; num_connections?: number };
		return m.type === "hello" && typeof m.num_connections === "number" ? m.num_connections : undefined;
	} catch {
		return undefined;
	}
}
