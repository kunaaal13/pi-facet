import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export { stripTerminalSequences as stripAnsi, truncateToWidth, visibleWidth };

const HOME = homedir();

/** 5.2s · 2m5s · 1h2m */
export function fmtDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${Math.floor(s % 60)}s`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** Whole-second variant for elapsed counters: 15s · 2m5s */
export function fmtElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60}s`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** 950 · 9.45k · 12.3k · 1.2M */
export function fmtTokens(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 10_000) return `${(n / 1000).toFixed(2).replace(/\.?0+$/, "")}k`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Context-window style: 9.5K · 500K · 1M */
export function fmtWindow(n: number): string {
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${k < 100 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}K`;
	}
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function fmtClock(ts: number, format: "12h" | "24h"): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "";
	const mm = String(d.getMinutes()).padStart(2, "0");
	if (format === "24h") return `${String(d.getHours()).padStart(2, "0")}:${mm}`;
	const h = d.getHours() % 12 || 12;
	return `${h}:${mm} ${d.getHours() < 12 ? "AM" : "PM"}`;
}

/** Path relative to cwd when inside it, otherwise ~-prefixed. */
export function displayPath(path: string, cwd: string): string {
	if (!path) return "";
	const abs = isAbsolute(path) ? path : resolve(cwd, path);
	const rel = relative(cwd, abs);
	if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
	if (rel === "") return ".";
	return abs.startsWith(HOME) ? `~${abs.slice(HOME.length)}` : abs;
}

/** Grok-style cwd: ~/D/m/project (last two components kept whole). */
export function shortCwd(cwd: string): string {
	const tilde = cwd.startsWith(HOME) ? `~${cwd.slice(HOME.length)}` : cwd;
	const parts = tilde.split(sep);
	if (parts.length <= 3) return tilde;
	return parts.map((p, i) => (i === 0 || i >= parts.length - 2 || p.length <= 1 ? p : p[0])).join(sep);
}

export function expandTabs(text: string, size = 2): string {
	return text.includes("\t") ? text.replace(/\t/g, " ".repeat(size)) : text;
}

/** Pad (or cut) an ANSI string to exactly `width` columns. */
export function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(text);
	if (w === width) return text;
	if (w < width) return text + " ".repeat(width - w);
	return truncateToWidth(text, width, "", false);
}

/** Cut with an ellipsis if wider than `width`. */
export function clip(text: string, width: number, ellipsis = "…"): string {
	if (width <= 0) return "";
	return visibleWidth(text) <= width ? text : truncateToWidth(text, width, ellipsis, false);
}

/** Left and right segments on one row; the left side gives way first. */
export function spread(left: string, right: string, width: number, minGap = 2): string {
	const rw = visibleWidth(right);
	if (rw + minGap >= width) return clip(left, width);
	const room = width - rw - minGap;
	const l = clip(left, room);
	return l + " ".repeat(width - visibleWidth(l) - rw) + right;
}

/** Shorten in the middle: "npm run build && …ests --watch" */
export function middleTruncate(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 3) return clip(text, width);
	const plain = stripTerminalSequences(text);
	const head = Math.ceil((width - 1) * 0.65);
	const tail = width - 1 - head;
	return `${plain.slice(0, head)}…${tail > 0 ? plain.slice(plain.length - tail) : ""}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * Make tool output safe to draw: CRLF → LF, carriage-return progress lines keep
 * their final state, and every control character / escape sequence except SGR
 * colour codes is removed (they move the cursor but count as zero width).
 */
export function sanitize(text: string): string {
	return text
		.replace(/\r+\n/g, "\n")
		.split("\n")
		.map((line) => (line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line))
		.join("\n")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-9;?]*[A-Za-ln-z@`]/g, "")
		.replace(/\x1b[^[]/g, "")
		.replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, "");
}

export function textOf(result: { content?: Array<{ type: string; text?: string }> } | undefined): string {
	if (!result?.content) return "";
	return sanitize(
		result.content
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text)
			.join("\n"),
	);
}

/** Strip pi's trailing "[Showing lines …]" / "[… more lines …]" notices. */
export function splitNotice(text: string): { body: string; notice?: string } {
	const match = text.match(/\n\n(\[[^\n]*\])\s*$/);
	if (!match) return { body: text };
	return { body: text.slice(0, match.index), notice: match[1] };
}

export function trimTrailingBlank(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1]!.trim() === "") end--;
	return lines.slice(0, end);
}
