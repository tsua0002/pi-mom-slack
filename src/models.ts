/** `!model` lists the models, `!model <name>` switches the thread, `!model default <name>` also changes pi's default. */

export interface ModelLike {
	provider: string;
	id: string;
	name?: string;
	input?: readonly string[];
	reasoning?: boolean;
}

export const label = (m: ModelLike) => `${m.provider}/${m.id}`;

/** Exact provider/id, then exact id, then a unique substring. Returns the model or an explanation. */
export function resolveModel<M extends ModelLike>(spec: string, models: readonly M[]): { model: M } | { error: string } {
	const q = spec.trim().toLowerCase();
	if (!q) return { error: "Model name missing." };
	const exact = models.filter((m) => label(m).toLowerCase() === q || m.id.toLowerCase() === q);
	if (exact.length === 1) return { model: exact[0]! };
	const partial = exact.length > 1 ? exact : models.filter((m) => label(m).toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q));
	if (partial.length === 1) return { model: partial[0]! };
	if (partial.length === 0) return { error: `No available model matches "${spec}". \`!model\` lists them.` };
	return { error: `Several models match "${spec}":\n${partial.slice(0, 15).map((m) => `• \`${label(m)}\``).join("\n")}\nUse provider/id.` };
}

/**
 * Slack listing of the available models, grouped by provider, the current provider first and the current model marked.
 * Long catalogs are cut: `!model <part of a name>` finds the others.
 */
export function formatModels(models: readonly ModelLike[], current: ModelLike | undefined, max = 30): string {
	const byProvider = new Map<string, ModelLike[]>();
	if (current) byProvider.set(current.provider, []);
	for (const m of models) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
	const lines: string[] = [`Model of this thread: ${current ? `\`${label(current)}\`` : "(pi default)"}`, ""];
	let n = 0;
	for (const [provider, list] of byProvider) {
		if (n >= max || list.length === 0) continue;
		lines.push(`*${provider}*`);
		for (const m of list) {
			if (n >= max) break;
			n++;
			const tags = [m.input?.includes("image") ? "images" : "", m.reasoning ? "reasoning" : ""].filter(Boolean).join(", ");
			lines.push(`${current && label(current) === label(m) ? "→" : "•"} \`${m.id}\`${tags ? ` (${tags})` : ""}`);
		}
	}
	if (models.length > n) lines.push(`… and ${models.length - n} more across ${byProvider.size} provider(s).`);
	if (models.length === 0) lines.push("_No model has credentials. Run `pi` once on this machine and log in (`/login`)._");
	lines.push("", "`!model <name>`: this thread only (exact `provider/id`, or a unique part of it). `!model default <name>`: also pi's default.");
	return lines.join("\n");
}
