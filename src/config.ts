/**
 * CLI configuration: the environment, completed by a KEY=VALUE file (.env by default).
 * Values already in the environment win over the file.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CliConfig {
	appToken: string;
	botToken: string;
	allowedUsers: string[];
	dataDir: string;
	/** Names read from the env file: removed from the agent's shell, like every credential-looking variable. */
	secretNames: string[];
}

/** Loads KEY=VALUE lines into env (existing values win). Returns the names found in the file. */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const names: string[] = [];
	if (!existsSync(path)) return names;
	for (const raw of readFileSync(path, "utf8").split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
		if (!m) continue;
		let v = m[2]!.trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
		names.push(m[1]!);
		if (env[m[1]!] === undefined) env[m[1]!] = v;
	}
	return names;
}

export function parseUsers(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Validates the three required values. Errors name the variable, never its value. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env, secretNames: string[] = []): CliConfig {
	const appToken = env.SLACK_APP_TOKEN?.trim() ?? "";
	const botToken = env.SLACK_BOT_TOKEN?.trim() ?? "";
	const problems: string[] = [];
	if (!appToken.startsWith("xapp-")) problems.push("SLACK_APP_TOKEN must be the app-level token (xapp-…)");
	if (!botToken.startsWith("xoxb-")) problems.push("SLACK_BOT_TOKEN must be the bot token (xoxb-…)");
	const allowedUsers = parseUsers(env.PI_SLACK_ALLOWED_USERS);
	if (allowedUsers.length === 0) problems.push("PI_SLACK_ALLOWED_USERS must list Slack member IDs, comma separated (e.g. U012ABCDEF)");
	if (problems.length) throw new Error(problems.join("\n"));
	return {
		appToken,
		botToken,
		allowedUsers,
		dataDir: resolve(env.PI_SLACK_DATA_DIR?.trim() || join(homedir(), ".pi", "slack")),
		secretNames,
	};
}
