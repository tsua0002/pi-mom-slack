import { afterEach, describe, expect, it, vi } from "vitest";
import { chunk, decodeEntities, helloConnections, tokenHint, type IncomingMessage, isSlackFileUrl, SlackApi, SlackBot } from "../src/slack.ts";

function bot() {
	const got: IncomingMessage[] = [];
	const b = new SlackBot("xapp-test", "xoxb-test", async (m) => { got.push(m); });
	b.botUserId = "UBOT";
	return { b, got };
}

describe("dispatch", () => {
	it("handles a channel mention once, strips it, decodes entities", async () => {
		const { b, got } = bot();
		await b.dispatch({ event: { type: "app_mention", channel: "C1", user: "U1", ts: "1.1", text: "<@UBOT> a &lt; b &amp;&amp; c" } });
		await b.dispatch({ event: { type: "message", channel: "C1", channel_type: "channel", user: "U1", ts: "1.1", text: "<@UBOT> a &lt; b &amp;&amp; c" } });
		expect(got).toEqual([{ channel: "C1", threadTs: "1.1", ts: "1.1", user: "U1", text: "a < b && c", isDirect: false, mentioned: true, files: [] }]);
	});

	it("handles a direct message once, even if delivered twice", async () => {
		const { b, got } = bot();
		const ev = { type: "message", channel: "D1", channel_type: "im", user: "U1", ts: "2.2", text: "Ping" };
		await b.dispatch({ event: ev });
		await b.dispatch({ event: ev });
		expect(got).toHaveLength(1);
		expect(got[0]?.isDirect).toBe(true);
	});

	it("ignores plain channel messages, bots, itself, edits", async () => {
		const { b, got } = bot();
		await b.dispatch({ event: { type: "message", channel: "C1", channel_type: "channel", user: "U1", ts: "3.3", text: "hello" } });
		await b.dispatch({ event: { type: "message", channel: "D1", channel_type: "im", bot_id: "B1", user: "U2", ts: "4.4", text: "x" } });
		await b.dispatch({ event: { type: "message", channel: "D1", channel_type: "im", user: "UBOT", ts: "4.5", text: "x" } });
		await b.dispatch({ event: { type: "message", subtype: "message_changed", channel: "D1", channel_type: "im", user: "U1", ts: "4.6", text: "x" } });
		expect(got).toHaveLength(0);
	});

	it("picks up replies without mention in a thread it already answers", async () => {
		const { b, got } = bot();
		const reply = { type: "message", channel: "C1", channel_type: "channel", user: "U1", ts: "9.2", thread_ts: "9.1", text: "and then?" };
		await b.dispatch({ event: reply });
		expect(got).toHaveLength(0);
		b.trackThread("C1", "9.1");
		await b.dispatch({ event: { ...reply, ts: "9.3" } });
		expect(got[0]).toMatchObject({ threadTs: "9.1", ts: "9.3", text: "and then?" });
	});

	it("accepts a message with an attached file (subtype file_share)", async () => {
		const { b, got } = bot();
		await b.dispatch({ event: { type: "message", subtype: "file_share", channel: "D1", channel_type: "im", user: "U1", ts: "5.5", text: "", files: [{ name: "a.png", mimetype: "image/png", size: 10, url_private: "https://files.slack.com/a.png" }] } });
		expect(got[0]?.files).toEqual([{ name: "a.png", mimetype: "image/png", size: 10, url: "https://files.slack.com/a.png" }]);
	});
});

describe("helpers", () => {
	it("chunks long text under the limit", () => {
		expect(chunk("abc")).toEqual(["abc"]);
		const parts = chunk(`${"a".repeat(30)}\n${"b".repeat(30)}\n${"c".repeat(100)}`, 40);
		expect(parts.every((p) => p.length <= 40)).toBe(true);
		expect(parts.join("")).toContain("c".repeat(40));
	});
	it("decodes Slack entities", () => expect(decodeEntities("&lt;x&gt; &amp;lt;")).toBe("<x> &lt;"));
	it("only trusts Slack file hosts with the token", () => {
		expect(isSlackFileUrl("https://files.slack.com/files-pri/T1/a.png")).toBe(true);
		expect(isSlackFileUrl("http://files.slack.com/a")).toBe(false);
		expect(isSlackFileUrl("https://files.slack.com.evil.io/a")).toBe(false);
		expect(isSlackFileUrl("not a url")).toBe(false);
	});
	it("says which token Slack rejected", () => {
		const err = Object.assign(new Error("An API error occurred: invalid_auth"), { data: { error: "invalid_auth" } });
		expect(tokenHint(err, "SLACK_BOT_TOKEN")).toBe("Slack rejected SLACK_BOT_TOKEN (invalid_auth)");
		expect(tokenHint(new Error("ECONNRESET"), "SLACK_BOT_TOKEN")).toBe("Slack connection failed: ECONNRESET");
	});
	it("reads num_connections from the hello message only", () => {
		expect(helloConnections(JSON.stringify({ type: "hello", num_connections: 2 }))).toBe(2);
		expect(helloConnections(Buffer.from(JSON.stringify({ type: "hello", num_connections: 1 })))).toBe(1);
		expect(helloConnections(JSON.stringify({ type: "events_api", payload: { text: "hello" } }))).toBeUndefined();
		expect(helloConnections("{broken")).toBeUndefined();
	});
});

describe("SlackApi", () => {
	afterEach(() => vi.unstubAllGlobals());

	function api(overrides: Record<string, unknown> = {}) {
		const calls: [string, unknown][] = [];
		const rec = (name: string, impl?: (a: any) => unknown) => async (a: unknown) => { calls.push([name, a]); return impl ? impl(a) : { ok: true, ts: "100.1" }; };
		const web = {
			token: "xoxb-test",
			chat: { postMessage: rec("post"), update: rec("update") },
			reactions: {
				add: rec("react", () => { throw Object.assign(new Error("x"), { data: { error: "already_reacted" } }); }),
				remove: rec("unreact", () => { throw Object.assign(new Error("x"), { data: { error: "no_reaction" } }); }),
			},
			users: { info: rec("users", (a: any) => ({ user: { name: "jdoe", profile: { display_name: a.user === "U1" ? "Ada" : "" , real_name: "Real Name" } } })) },
			filesUploadV2: rec("upload"),
			...overrides,
		};
		return { slack: new SlackApi(web as never), calls };
	}

	it("posts long replies in several messages in the thread", async () => {
		const { slack, calls } = api();
		await slack.post("C1", "1.1", "x".repeat(5000));
		expect(calls.filter(([n]) => n === "post")).toHaveLength(2);
		expect(calls[0]![1]).toMatchObject({ channel: "C1", thread_ts: "1.1" });
	});

	it("tolerates an existing or missing reaction", async () => {
		const { slack } = api();
		await expect(slack.react("C1", "1.1", "eyes")).resolves.toBeUndefined();
		await expect(slack.unreact("C1", "1.1", "eyes")).resolves.toBeUndefined();
	});

	it("resolves user names once and replaces mentions", async () => {
		const { slack, calls } = api();
		expect(await slack.resolveMentions("ask <@U1> and <@U2|bob>, then <@U1>")).toBe("ask @Ada and @Real Name, then @Ada");
		await slack.userName("U1");
		expect(calls.filter(([n]) => n === "users")).toHaveLength(2);
	});

	it("uploads into the thread", async () => {
		const { slack, calls } = api();
		await slack.upload("C1", "1.1", Buffer.from("hi"), "a.txt", "here");
		expect(calls[0]).toEqual(["upload", { channel_id: "C1", thread_ts: "1.1", file: Buffer.from("hi"), filename: "a.txt", initial_comment: "here" }]);
	});

	it("refuses non-Slack URLs and explains the HTML page Slack sends without files:read", async () => {
		const { slack } = api();
		const fetch = vi.fn(async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }));
		vi.stubGlobal("fetch", fetch);
		await expect(slack.download("https://example.com/a.png", 100)).rejects.toThrow("not a Slack file URL");
		expect(fetch).not.toHaveBeenCalled();
		await expect(slack.download("https://files.slack.com/a.png", 100)).rejects.toThrow("files:read");
		vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(200), { status: 200 })));
		await expect(slack.download("https://files.slack.com/a.png", 100)).rejects.toThrow("too large");
	});
});

describe("connection watchdog", () => {
	it("tolerates a reconnect, and fails loudly when the socket stays down", async () => {
		const { EventEmitter } = await import("node:events");
		const { SlackBot } = await import("../src/slack.ts");
		const { vi } = await import("vitest");
		vi.useFakeTimers();
		try {
			const b = new SlackBot("xapp-1", "xoxb-1", async () => {});
			const socket = new EventEmitter();
			// biome-ignore lint/suspicious/noExplicitAny: test double for the Socket Mode client
			(b as any).socket = socket;
			// biome-ignore lint/suspicious/noExplicitAny: private method under test
			(b as any).watchConnection();
			socket.emit("disconnected");
			vi.advanceTimersByTime(60_000);
			socket.emit("connected");
			expect(() => vi.advanceTimersByTime(300_000)).not.toThrow();
			socket.emit("reconnecting");
			expect(() => vi.advanceTimersByTime(180_001)).toThrow(/Slack connection lost/);
		} finally {
			vi.useRealTimers();
		}
	});
});
