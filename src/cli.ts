#!/usr/bin/env node
/**
 * npx pi-mom-slack
 * Reads SLACK_APP_TOKEN, SLACK_BOT_TOKEN and PI_SLACK_ALLOWED_USERS from the environment or a .env file.
 * The model is the one configured in pi (~/.pi/agent/).
 */
import { resolve } from "node:path";
import { createSlackBot, recordCrash } from "./bot.ts";
import { configFromEnv, loadEnvFile } from "./config.ts";
import { PI_VERSION, VERSION } from "./version.ts";

const HELP = `pi-mom-slack ${VERSION} (pi ${PI_VERSION})

Run the pi coding agent in Slack: one pi session per thread.

Usage: npx pi-mom-slack

Environment (or a .env file in the current directory):
  SLACK_APP_TOKEN         app-level token, xapp-… (scope connections:write)
  SLACK_BOT_TOKEN         bot token, xoxb-…
  PI_SLACK_ALLOWED_USERS  Slack member IDs allowed to use the bot, comma separated
  PI_SLACK_DATA_DIR       thread workspaces and state (default ~/.pi/slack)
  PI_SLACK_ENV_FILE       env file to read (default ./.env)

The model and its credentials come from pi: run \`pi\` once and log in.
Setup guide: https://github.com/tsua0002/pi-mom-slack#readme`;

const arg = process.argv[2];
if (arg === "--help" || arg === "-h") {
	console.log(HELP);
	process.exit(0);
}
if (arg === "--version" || arg === "-v") {
	console.log(VERSION);
	process.exit(0);
}

const secretNames = loadEnvFile(resolve(process.env.PI_SLACK_ENV_FILE ?? ".env"));
let config: ReturnType<typeof configFromEnv>;
try {
	config = configFromEnv(process.env, secretNames);
} catch (e) {
	console.error(`pi-mom-slack: configuration incomplete\n${e instanceof Error ? e.message : e}\n\nRun \`npx pi-mom-slack --help\` or see https://github.com/tsua0002/pi-mom-slack#readme`);
	process.exit(1);
}

const bot = createSlackBot({ ...config });

const crash = (kind: string) => (err: unknown) => {
	console.error(`[pi-mom-slack] ${kind}: ${err instanceof Error ? err.message : err}`);
	if (process.env.PI_SLACK_DEBUG) console.error(err);
	recordCrash(config.dataDir, err);
	process.exit(1);
};
process.on("uncaughtException", crash("uncaughtException"));
process.on("unhandledRejection", crash("unhandledRejection"));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		console.log(`[pi-mom-slack] ${signal}, stopping…`);
		void bot.stop(signal).finally(() => process.exit(0));
	});
}

await bot.start().catch(crash("Slack connection failed"));
