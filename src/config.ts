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

/** Base bot (when configured), followed by isolated named Slack app profiles. */
export function configsFromEnv(env: NodeJS.ProcessEnv = process.env, secretNames: string[] = []): CliConfig[] {
	const names = (env.PI_SLACK_WORKSPACES ?? "").split(",").map((name) => name.trim()).filter(Boolean);
	const suffixes = new Set<string>();
	for (const name of names) {
		if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
			throw new Error("PI_SLACK_WORKSPACES names must contain only letters, digits, underscores or hyphens and start with a letter or digit");
		}
		const suffix = name.toUpperCase().replaceAll("-", "_");
		if (suffixes.has(suffix)) throw new Error("PI_SLACK_WORKSPACES contains duplicate or ambiguous profile names");
		suffixes.add(suffix);
	}
	const configs: CliConfig[] = [];
	if (!names.length || env.SLACK_APP_TOKEN?.trim() || env.SLACK_BOT_TOKEN?.trim()) {
		configs.push(configFromEnv(env, secretNames));
	}
	const baseDir = resolve(env.PI_SLACK_DATA_DIR?.trim() || join(homedir(), ".pi", "slack"));
	for (const name of names) {
		const suffix = name.toUpperCase().replaceAll("-", "_");
		try {
			configs.push(configFromEnv({
				SLACK_APP_TOKEN: env[`SLACK_APP_TOKEN_${suffix}`],
				SLACK_BOT_TOKEN: env[`SLACK_BOT_TOKEN_${suffix}`],
				PI_SLACK_ALLOWED_USERS: env[`PI_SLACK_ALLOWED_USERS_${suffix}`] ?? env.PI_SLACK_ALLOWED_USERS,
				PI_SLACK_DATA_DIR: join(baseDir, "workspaces", name),
			}, secretNames));
		} catch (error) {
			// Validation messages contain variable names only, never token values.
			throw new Error((error as Error).message.replace(/SLACK_APP_TOKEN|SLACK_BOT_TOKEN|PI_SLACK_ALLOWED_USERS/g, (key) => `${key}_${suffix}`));
		}
	}
	if (new Set(configs.map((config) => config.appToken)).size !== configs.length) {
		throw new Error("Duplicate Slack app tokens: each bot requires a separate Slack app");
	}
	return configs;
}
