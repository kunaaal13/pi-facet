/**
 * Shared tool-row rendering.
 *
 *   ┃ ◆ Verb argument (detail)          ← header (col 0 = rail, col 2 = bullet)
 *       body line                        ← body indented to col 4
 *
 * Headers read their summary from ctx.state lazily at render time, so data the
 * result renderer computes (counts, ranges, exit codes) shows on the one-line
 * collapsed row.
 */
import type { Component } from "@earendil-works/pi-tui";
import type { ColorToken } from "../skin.ts";
import { store, ticker, toolTimes } from "../state.ts";
import { clip, fit, fmtDuration, visibleWidth } from "../util.ts";

export const BODY_INDENT = 6;
export const HEADER_INDENT = 2;

/** Marker stamped on tool definitions we own, so the stacking patch only touches ours. */
export const PMT_TOOL = Symbol.for("pi-facet.tool");

export type Status = "pending" | "running" | "done" | "error";

export interface RenderCtx {
	toolCallId: string;
	state: ToolState;
	invalidate: () => void;
	lastComponent: Component | undefined;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	isError: boolean;
	args: unknown;
}

export interface ToolState {
	/** Rich header pieces set by the result renderer. */
	detail?: string;
	/** True when the row is a single collapsed line (used for stacking). */
	compact?: boolean;
	status?: Status;
	[key: string]: unknown;
}

export function statusOf(ctx: RenderCtx): Status {
	if (ctx.isError) return "error";
	if (!ctx.isPartial) return "done";
	return ctx.executionStarted ? "running" : "pending";
}

/** A component whose lines are produced by a builder, cached while static. */
export class Lines implements Component {
	private build: (width: number) => { lines: string[]; animated?: boolean };
	private cacheKey = "";
	private cache: string[] = [];

	constructor(build: (width: number) => { lines: string[]; animated?: boolean }) {
		this.build = build;
	}

	set(build: (width: number) => { lines: string[]; animated?: boolean }): this {
		this.build = build;
		this.cacheKey = "";
		return this;
	}

	render(width: number): string[] {
		const key = `${width}:${store.epoch}`;
		if (key === this.cacheKey) return this.cache;
		const { lines, animated } = this.build(width);
		const safe = lines.map((line) => (visibleWidth(line) > width ? clip(line, width) : line));
		if (!animated) {
			this.cacheKey = key;
			this.cache = safe;
		} else {
			this.cacheKey = "";
		}
		return safe;
	}

	invalidate(): void {
		this.cacheKey = "";
	}
}

export function reuse(ctx: RenderCtx, build: (width: number) => { lines: string[]; animated?: boolean }): Lines {
	const last = ctx.lastComponent;
	return last instanceof Lines ? last.set(build) : new Lines(build);
}

/** Rail cell (col 0) for a status; animated while running. */
export function rail(status: Status, toolCallId: string): { cell: string; animated: boolean } {
	const s = store.s;
	if (status === "running") {
		ticker.hold(`tool:${toolCallId}`);
		const phase = Math.sin((ticker.frame * store.config.animation.intervalMs) / 400);
		return { cell: `${s.blendAnsi("dim", "running", 0.35 + 0.65 * phase * phase)}${s.glyphs.rail}\x1b[39m`, animated: true };
	}
	ticker.release(`tool:${toolCallId}`);
	const end = toolTimes.get(toolCallId)?.end;
	if (status === "done" && end && Date.now() - end < 450) {
		// brief success flash, then settle
		setTimeout(() => store.requestRender(), 460).unref?.();
		return { cell: s.fg("success", s.glyphs.rail), animated: true };
	}
	return { cell: " ", animated: false };
}

export function bullet(status: Status): { glyph: string; animated: boolean } {
	const s = store.s;
	if (status === "running" || status === "pending") {
		return { glyph: s.fg("accent", ticker.spinner(s.glyphs.spinner)), animated: true };
	}
	if (status === "error") return { glyph: s.fg("error", s.glyphs.bullet), animated: false };
	return { glyph: s.fg("toolBullet", s.glyphs.bullet), animated: false };
}

export interface HeaderParts {
	verb: string;
	arg?: string;
	argToken?: ColorToken;
	/** Already-styled extra detail (counts etc.). */
	detail?: string;
	/** Already-styled right-aligned meta. */
	right?: string;
}

export function headerLine(width: number, ctx: RenderCtx, parts: HeaderParts): { line: string; animated: boolean } {
	const s = store.s;
	ctx.state.lastWidth = width;
	const status = ctx.state.status ?? statusOf(ctx);
	const r = rail(status, ctx.toolCallId);
	const b = bullet(status);
	const verb = s.bold(s.fg(status === "error" ? "error" : "text", parts.verb));
	const arg = parts.arg ? ` ${s.fg(parts.argToken ?? "path", parts.arg)}` : "";
	const detail = parts.detail ? ` ${parts.detail}` : "";
	const left = `${r.cell} ${b.glyph} ${verb}${arg}${detail}`;
	const line = parts.right ? spreadRight(left, parts.right, width) : clip(left, width);
	return { line, animated: r.animated || b.animated };
}

function spreadRight(left: string, right: string, width: number): string {
	const rw = visibleWidth(right);
	const room = width - rw - 2;
	if (room < 12) return clip(left, width);
	const l = clip(left, room);
	return l + " ".repeat(Math.max(2, width - visibleWidth(l) - rw)) + right;
}

/**
 * Body lines start at col 6. Output-style bodies hang off a dim connector on
 * their first line (Claude Code style):
 *
 *   ◆ Run git status --short
 *     └  M src/index.ts
 *        ?? notes.md
 */
export function bodyLines(lines: string[], width: number, ctx: RenderCtx, connector = false): string[] {
	const s = store.s;
	const status = ctx.state.status ?? statusOf(ctx);
	const railCell = status === "running" ? rail(status, ctx.toolCallId).cell : " ";
	const inner = Math.max(1, width - BODY_INDENT);
	const plain = `${railCell}${" ".repeat(BODY_INDENT - 1)}`;
	const hook = `${railCell}   ${s.fg("dim", "└")} `;
	return lines.map((line, i) => `${connector && i === 0 ? hook : plain}${clip(line, inner)}`);
}

/** Elapsed/total time; once finished it's remembered on the row (toolTimes is pruned). */
export function elapsed(ctx: RenderCtx): string {
	if (typeof ctx.state.duration === "string") return ctx.state.duration;
	const t = toolTimes.get(ctx.toolCallId);
	if (!t) return "";
	const text = fmtDuration((t.end ?? Date.now()) - t.start);
	if (t.end) ctx.state.duration = text;
	return text;
}

/** Muted "(…)" detail. */
export function muted(text: string): string {
	return store.s.fg("muted", text);
}

export function dimText(text: string): string {
	return store.s.fg("dim", text);
}

export function str(value: unknown): string {
	return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** Head + "… +N lines" + tail preview of plain lines. */
export function headTail(lines: string[], head: number, tail: number): { lines: string[]; hidden: number } {
	if (lines.length <= head + tail + 1) return { lines, hidden: 0 };
	const hidden = lines.length - head - tail;
	return {
		lines: [...lines.slice(0, head), `\u0000${hidden}`, ...lines.slice(lines.length - tail)],
		hidden,
	};
}

/** Replace head/tail markers with a styled "… +N lines" row. */
export function styleMarkers(lines: string[]): string[] {
	const s = store.s;
	return lines.map((line) =>
		line.startsWith("\u0000") ? s.fg("dim", `${s.glyphs.ellipsis} +${line.slice(1)} lines (ctrl+o to expand)`) : line,
	);
}
