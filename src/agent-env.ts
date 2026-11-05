/**
 * Environment given to the agent's shell. The bot's own secrets (everything read from the env file, the Slack tokens,
 * and anything that looks like a credential) are removed, so a command run by the agent cannot use them by accident.
 *
 * This guards against mistakes, not against a hostile agent: the shell runs as the same user as the bot.
 */
const CREDENTIAL = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;

export function scrubEnv(env: NodeJS.ProcessEnv, secretNames: Iterable<string> = []): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { ...env };
	for (const name of secretNames) delete out[name];
	for (const name of Object.keys(out)) if (CREDENTIAL.test(name)) delete out[name];
	return out;
}
