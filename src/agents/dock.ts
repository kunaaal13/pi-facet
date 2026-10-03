/**
 * Subagent dock (above the input), fed by pi-subagents' lifecycle events on
 * pi.events — no dependency on its internals.
 *
 *   ▾ Subagents 2
 *     ⁙ explore  Explore pricing engine                          1m12s
 *     ✓ general  Check cache hit rates                    12 tools · 48s
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { store, ticker } from "../state.ts";
import { clip, fmtElapsed, fmtTokens, spread } from "../util.ts";

interface AgentRow {
	id: string;
	type: string;
	description: string;
	started: number;
	finished?: number;
	failed?: boolean;
	tokens?: number;
	toolUses?: number;
}

const rows = new Map<string, AgentRow>();

function tokenCount(value: unknown): number | undefined {
	if (typeof value === "number") return value;
	if (value && typeof value === "object") {
		const v = value as Record<string, unknown>;
		const total = v.total ?? v.totalTokens ?? v.output;
		return typeof total === "number" ? total : undefined;
	}
	return undefined;
}

export function trackSubagents(pi: ExtensionAPI): void {
	const upsert = (data: any, patch: Partial<AgentRow>) => {
		if (!data?.id) return;
		const existing = rows.get(data.id);
		rows.set(data.id, {
			...existing,
			id: data.id,
			type: data.type ?? existing?.type ?? "agent",
			description: data.description ?? existing?.description ?? "",
			started: existing?.started ?? Date.now(),
			...patch,
		});
		if (store.config.subagents.dock) ticker.hold("subagents");
		store.requestRender();
	};
	pi.events.on("subagents:started", (data: any) => upsert(data, { finished: undefined, failed: undefined }));
	const finish = (failed: boolean) => (data: any) => {
		upsert(data, { finished: Date.now(), failed, tokens: tokenCount(data?.tokens), toolUses: data?.toolUses });
		setTimeout(() => {
			const row = rows.get(data?.id);
			if (row?.finished && Date.now() - row.finished >= store.config.subagents.lingerMs - 50) rows.delete(row.id);
			if (![...rows.values()].some((r) => !r.finished)) ticker.release("subagents");
			store.requestRender();
		}, store.config.subagents.lingerMs).unref?.();
	};
	pi.events.on("subagents:completed", finish(false));
	pi.events.on("subagents:failed", finish(true));
}

export function resetSubagents(): void {
	rows.clear();
	ticker.release("subagents");
}

export class SubagentDock implements Component {
	render(width: number): string[] {
		if (!store.skin || !store.config.subagents.dock || rows.size === 0) return [];
		const s = store.s;
		const list = [...rows.values()].sort((a, b) => Number(!!a.finished) - Number(!!b.finished) || a.started - b.started);
		const running = list.filter((r) => !r.finished).length;
		const out = [` ${s.fg("muted", s.glyphs.collapse)} ${s.bold(s.fg("textSecondary", "Subagents"))} ${s.fg("muted", String(running || list.length))}`];
		const max = Math.max(1, store.config.subagents.maxRows);
		for (const row of list.slice(0, max)) {
			const icon = !row.finished
				? s.fg("accent", ticker.spinner(s.glyphs.agentSpinner, 3))
				: row.failed
					? s.fg("error", s.glyphs.error)
					: s.fg("success", s.glyphs.success);
			const kindToken = row.finished ? "muted" : "accent";
			const left = `   ${icon} ${s.fg(kindToken, row.type)}  ${s.fg(row.finished ? "muted" : "text", row.description)}`;
			const meta: string[] = [];
			if (row.toolUses) meta.push(`${row.toolUses} tools`);
			if (row.tokens) meta.push(`${s.glyphs.tokens}${fmtTokens(row.tokens)}`);
			meta.push(fmtElapsed((row.finished ?? Date.now()) - row.started));
			out.push(spread(left, `${s.fg("muted", meta.join(` ${s.glyphs.sep} `))} `, width));
		}
		if (list.length > max) out.push(`   ${s.fg("muted", `${s.glyphs.collapse} ${list.length - max} more`)}`);
		return out.map((line) => clip(line, width));
	}

	invalidate(): void {}
}
