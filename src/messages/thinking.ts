/**
 * Thinking durations, measured from the provider stream (thinking_start/end)
 * and persisted as a hidden custom session entry so /resume still shows them.
 * Message content is never modified.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const THINKING_ENTRY = "pi-minimal-tui:thinking";
/** Written by sessions recorded while the package was named pi-facet. */
const LEGACY_THINKING_ENTRY = "pi-facet:thinking";

interface Span {
	start: number;
	end?: number;
}

/** messageTimestamp → contentIndex → span */
const live = new Map<number, Map<number, Span>>();
/** messageTimestamp → contentIndex → duration ms (persisted) */
const saved = new Map<number, Record<number, number>>();

export function trackThinking(pi: ExtensionAPI): void {
	pi.on("message_update", (event) => {
		const msg = event.message as { role?: string; timestamp?: number };
		if (msg.role !== "assistant" || typeof msg.timestamp !== "number") return;
		const e = event.assistantMessageEvent as { type: string; contentIndex?: number };
		if (e.type !== "thinking_start" && e.type !== "thinking_end") return;
		const idx = e.contentIndex ?? 0;
		let spans = live.get(msg.timestamp);
		if (!spans) {
			spans = new Map();
			live.set(msg.timestamp, spans);
		}
		if (e.type === "thinking_start") spans.set(idx, { start: Date.now() });
		else {
			const span = spans.get(idx);
			if (span && span.end === undefined) span.end = Date.now();
		}
	});

	pi.on("message_end", (event) => {
		const msg = event.message as { role?: string; timestamp?: number };
		if (msg.role !== "assistant" || typeof msg.timestamp !== "number") return;
		const spans = live.get(msg.timestamp);
		if (!spans || spans.size === 0) return;
		const durations: Record<number, number> = {};
		for (const [idx, span] of spans) durations[idx] = (span.end ?? Date.now()) - span.start;
		saved.set(msg.timestamp, durations);
		live.delete(msg.timestamp);
		pi.appendEntry(THINKING_ENTRY, { ts: msg.timestamp, durations });
	});
}

export function loadThinking(ctx: ExtensionContext): void {
	saved.clear();
	for (const entry of ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: any }>) {
		if (entry.type !== "custom" || (entry.customType !== THINKING_ENTRY && entry.customType !== LEGACY_THINKING_ENTRY)) continue;
		const ts = entry.data?.ts;
		if (typeof ts === "number" && entry.data?.durations) saved.set(ts, entry.data.durations);
	}
}

/** Duration (ms) of the thinking run covering content indices [from, to], if known. */
export function runDuration(ts: number | undefined, from: number, to: number): { ms?: number; active: boolean } {
	if (ts === undefined) return { active: false };
	const spans = live.get(ts);
	if (spans) {
		let first: number | undefined;
		let last: number | undefined;
		let active = false;
		for (let i = from; i <= to; i++) {
			const span = spans.get(i);
			if (!span) continue;
			first = first === undefined ? span.start : Math.min(first, span.start);
			if (span.end === undefined) active = true;
			last = Math.max(last ?? 0, span.end ?? Date.now());
		}
		if (first !== undefined) return { ms: (last ?? Date.now()) - first, active };
	}
	const durations = saved.get(ts);
	if (!durations) return { active: false };
	let total = 0;
	let found = false;
	for (let i = from; i <= to; i++) {
		if (durations[i] !== undefined) {
			total += durations[i]!;
			found = true;
		}
	}
	return { ms: found ? total : undefined, active: false };
}
