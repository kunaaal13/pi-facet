/**
 * Diff model + renderers (unified and split).
 *
 * Input is a unified patch (pi's edit tool returns one in details.patch; for
 * writes we compute one at execute time). Highlighting is per side as a block
 * so multi-line strings/comments colour correctly, and word-level changes on
 * paired lines get a brighter background.
 */
import { diffWords, parsePatch, structuredPatch } from "diff";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { highlight } from "./shiki.ts";
import { RESET_BG, type Skin } from "./skin.ts";
import { store } from "./state.ts";
import { expandTabs, fit, visibleWidth } from "./util.ts";

export type RowKind = "ctx" | "add" | "del" | "gap";

export interface Row {
	kind: RowKind;
	oldNo?: number;
	newNo?: number;
	text: string;
	/** For gap rows: unchanged lines skipped. */
	skipped?: number;
	/** Word-level changed ranges (plain-text offsets). */
	ranges?: Array<[number, number]>;
}

export interface ParsedDiff {
	rows: Row[];
	additions: number;
	deletions: number;
	maxLineNo: number;
}

export function parseUnifiedPatch(patch: string): ParsedDiff {
	const rows: Row[] = [];
	let additions = 0;
	let deletions = 0;
	let maxLineNo = 0;
	let files: ReturnType<typeof parsePatch>;
	try {
		files = parsePatch(patch);
	} catch {
		return { rows, additions, deletions, maxLineNo };
	}
	for (const file of files) {
		let prevOldEnd: number | undefined;
		for (const hunk of file.hunks) {
			if (prevOldEnd !== undefined && hunk.oldStart > prevOldEnd) {
				rows.push({ kind: "gap", text: "", skipped: hunk.oldStart - prevOldEnd });
			} else if (prevOldEnd === undefined && hunk.oldStart > 1 && rows.length === 0) {
				// leading context is implied; no gap row at the very top
			}
			let oldNo = hunk.oldStart;
			let newNo = hunk.newStart;
			for (const raw of hunk.lines) {
				const mark = raw[0];
				const text = expandTabs(raw.slice(1));
				if (mark === "+") {
					rows.push({ kind: "add", newNo, text });
					additions++;
					maxLineNo = Math.max(maxLineNo, newNo);
					newNo++;
				} else if (mark === "-") {
					rows.push({ kind: "del", oldNo, text });
					deletions++;
					maxLineNo = Math.max(maxLineNo, oldNo);
					oldNo++;
				} else if (mark === " ") {
					rows.push({ kind: "ctx", oldNo, newNo, text });
					maxLineNo = Math.max(maxLineNo, oldNo, newNo);
					oldNo++;
					newNo++;
				}
				// "\ No newline at end of file" is ignored
			}
			prevOldEnd = hunk.oldStart + hunk.oldLines;
		}
	}
	return { rows, additions, deletions, maxLineNo };
}

/** Compact unified patch between two texts (used by the write tool). */
export function makePatch(path: string, oldText: string, newText: string, context = 3): string {
	const patch = structuredPatch(path, path, oldText, newText, undefined, undefined, { context });
	const out: string[] = [`--- ${path}`, `+++ ${path}`];
	for (const h of patch.hunks) {
		out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
		out.push(...h.lines);
	}
	return out.join("\n");
}

/** Pair del/add runs and attach word-level ranges (similar lines only). */
function attachWordRanges(rows: Row[]): void {
	if (!store.config.diff.wordDiff) return;
	let i = 0;
	while (i < rows.length) {
		if (rows[i]!.kind !== "del") {
			i++;
			continue;
		}
		const dels: Row[] = [];
		while (i < rows.length && rows[i]!.kind === "del") dels.push(rows[i++]!);
		const adds: Row[] = [];
		while (i < rows.length && rows[i]!.kind === "add") adds.push(rows[i++]!);
		const pairs = Math.min(dels.length, adds.length);
		for (let p = 0; p < pairs; p++) {
			const a = dels[p]!;
			const b = adds[p]!;
			if (a.text.length > 500 || b.text.length > 500) continue;
			const parts = diffWords(a.text, b.text);
			let oldPos = 0;
			let newPos = 0;
			let same = 0;
			const oldRanges: Array<[number, number]> = [];
			const newRanges: Array<[number, number]> = [];
			for (const part of parts) {
				const len = part.value.length;
				if (part.removed) {
					oldRanges.push([oldPos, oldPos + len]);
					oldPos += len;
				} else if (part.added) {
					newRanges.push([newPos, newPos + len]);
					newPos += len;
				} else {
					same += len;
					oldPos += len;
					newPos += len;
				}
			}
			const similarity = same / Math.max(1, a.text.length, b.text.length);
			if (similarity < 0.15 || (!oldRanges.length && !newRanges.length)) continue;
			a.ranges = trimRanges(oldRanges, a.text);
			b.ranges = trimRanges(newRanges, b.text);
		}
	}
}

/** Don't highlight pure-whitespace edges of changed ranges. */
function trimRanges(ranges: Array<[number, number]>, text: string): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (let [s, e] of ranges) {
		while (s < e && /\s/.test(text[s]!)) s++;
		while (e > s && /\s/.test(text[e - 1]!)) e--;
		if (e > s) out.push([s, e]);
	}
	return out;
}

/** Insert background switches at plain-text offsets inside an ANSI line. */
function paintRanges(ansi: string, ranges: Array<[number, number]> | undefined, baseBg: string, wordBg: string): string {
	if (!ranges?.length) return ansi;
	let out = "";
	let pos = 0;
	let r = 0;
	let inWord = false;
	for (let i = 0; i < ansi.length; ) {
		if (ansi[i] === "\x1b") {
			const end = ansi.indexOf("m", i);
			if (end !== -1) {
				out += ansi.slice(i, end + 1);
				i = end + 1;
				continue;
			}
		}
		while (r < ranges.length && pos >= ranges[r]![1]) r++;
		const want = r < ranges.length && pos >= ranges[r]![0] && pos < ranges[r]![1];
		if (want !== inWord) {
			inWord = want;
			out += inWord ? wordBg : baseBg;
		}
		const cp = ansi.codePointAt(i)!;
		const ch = String.fromCodePoint(cp);
		out += ch;
		i += ch.length;
		pos += ch.length;
	}
	return inWord ? out + baseBg : out;
}

interface Highlighted {
	rows: Row[];
	code: string[]; // ANSI per row (gap rows: "")
}

function highlightRows(diff: ParsedDiff, lang: string | undefined, onReady?: () => void): Highlighted {
	const rows = diff.rows.map((r) => ({ ...r }));
	attachWordRanges(rows);
	const oldIdx: number[] = [];
	const newIdx: number[] = [];
	rows.forEach((row, i) => {
		if (row.kind === "ctx" || row.kind === "del") oldIdx.push(i);
		if (row.kind === "ctx" || row.kind === "add") newIdx.push(i);
	});
	const code = rows.map((r) => r.text);
	const oldHl = highlight(oldIdx.map((i) => rows[i]!.text).join("\n"), lang, onReady);
	const newHl = highlight(newIdx.map((i) => rows[i]!.text).join("\n"), lang, onReady);
	if (oldHl) oldIdx.forEach((rowIndex, k) => (code[rowIndex] = oldHl[k] ?? code[rowIndex]!));
	if (newHl) newIdx.forEach((rowIndex, k) => (code[rowIndex] = newHl[k] ?? code[rowIndex]!));
	return { rows, code };
}

export interface DiffRenderOptions {
	width: number;
	lang?: string;
	expanded: boolean;
	layout?: "unified" | "split";
	onReady?: () => void;
}

export function chooseLayout(diff: ParsedDiff, width: number): "unified" | "split" {
	const cfg = store.config.diff;
	if (cfg.layout !== "auto") return cfg.layout;
	if (width < cfg.splitMinWidth || diff.additions === 0 || diff.deletions === 0) return "unified";
	const numW = String(diff.maxLineNo).length;
	const half = Math.floor((width - 3) / 2) - numW - 2;
	if (half < cfg.splitMinCodeWidth) return "unified";
	const changed = diff.rows.filter((r) => r.kind !== "gap");
	const long = changed.filter((r) => visibleWidth(r.text) > half).length;
	if (changed.length > 0 && long / changed.length > 0.2) return "unified";
	// split only pays off when old and new lines pair up; otherwise it's mostly empty cells
	let paired = 0;
	let unpaired = 0;
	for (let i = 0; i < diff.rows.length; ) {
		if (diff.rows[i]!.kind !== "del" && diff.rows[i]!.kind !== "add") {
			i++;
			continue;
		}
		let dels = 0;
		let adds = 0;
		while (i < diff.rows.length && diff.rows[i]!.kind === "del") (dels++, i++);
		while (i < diff.rows.length && diff.rows[i]!.kind === "add") (adds++, i++);
		paired += Math.min(dels, adds);
		unpaired += Math.abs(dels - adds);
	}
	return unpaired > paired * 0.5 ? "unified" : "split";
}

function wrap(ansi: string, width: number, maxRows: number, s: Skin): string[] {
	if (width <= 0) return [""];
	if (visibleWidth(ansi) <= width) return [ansi];
	const rows = wrapTextWithAnsi(ansi, width);
	if (rows.length <= maxRows) return rows;
	const kept = rows.slice(0, maxRows);
	const last = kept[maxRows - 1]!;
	kept[maxRows - 1] = `${fit(last, Math.max(0, width - 1))}${s.fg("muted", "›")}`;
	return kept;
}

/** Render diff rows. Returns full-width lines (the caller adds the left indent). */
export function renderDiff(diff: ParsedDiff, opts: DiffRenderOptions): string[] {
	const s = store.s;
	const layout = opts.layout ?? chooseLayout(diff, opts.width);
	const { rows, code } = highlightRows(diff, opts.lang, opts.onReady);
	const lines = layout === "split" ? renderSplit(rows, code, diff, opts.width, s) : renderUnified(rows, code, diff, opts.width, s);
	const max = opts.expanded ? store.config.tools.expandedMaxLines : store.config.diff.maxLines;
	if (lines.length > max) {
		const hidden = lines.length - max;
		return [...lines.slice(0, max), s.fg("muted", `${s.glyphs.ellipsis} ${hidden} more lines`) + s.fg("dim", "  (ctrl+o to expand)")];
	}
	return lines;
}

function gapLine(row: Row, numW: number, s: Skin): string {
	return `${" ".repeat(numW)}  ${s.fg("muted", `${s.glyphs.ellipsis} ${row.skipped} unchanged ${row.skipped === 1 ? "line" : "lines"}`)}`;
}

function renderUnified(rows: Row[], code: string[], diff: ParsedDiff, width: number, s: Skin): string[] {
	const numW = Math.max(2, String(diff.maxLineNo).length);
	const codeW = Math.max(8, width - numW - 2);
	const maxWrap = Math.max(1, store.config.diff.maxWrapRows);
	const out: string[] = [];
	rows.forEach((row, i) => {
		if (row.kind === "gap") {
			out.push(gapLine(row, numW, s));
			return;
		}
		const no = row.kind === "del" ? row.oldNo : row.newNo;
		const numText = String(no ?? "").padStart(numW);
		const num =
			row.kind === "add" ? s.fg("diffAddFg", numText) : row.kind === "del" ? s.fg("diffDelFg", numText) : s.fg("gutter", numText);
		const bgToken = row.kind === "add" ? "diffAddBg" : row.kind === "del" ? "diffDelBg" : undefined;
		const wordToken = row.kind === "add" ? "diffAddWordBg" : "diffDelWordBg";
		let body = code[i]!;
		if (bgToken) body = paintRanges(body, row.ranges, s.bgAnsi(bgToken), s.bgAnsi(wordToken));
		const wrapped = wrap(body, codeW, maxWrap, s);
		wrapped.forEach((part, k) => {
			const gutter = k === 0 ? num : " ".repeat(numW);
			const cell = bgToken ? `${s.bgAnsi(bgToken)}${fit(part, codeW)}${RESET_BG}` : part;
			out.push(`${gutter}  ${cell}`);
		});
	});
	return out;
}

function renderSplit(rows: Row[], code: string[], diff: ParsedDiff, width: number, s: Skin): string[] {
	const numW = Math.max(2, String(diff.maxLineNo).length);
	const sepW = 3; // " │ "
	const halfW = Math.floor((width - sepW) / 2);
	const codeW = Math.max(4, halfW - numW - 2);
	const maxWrap = Math.max(1, store.config.diff.maxWrapRows);
	const sep = s.fg("dim", ` ${s.glyphs.border.v} `);
	const stripe = (w: number) => s.fg("stripe", s.glyphs.stripe.repeat(Math.max(0, w)));

	type Cell = { no?: number; body: string; kind: RowKind; ranges?: Array<[number, number]> } | undefined;
	const pairs: Array<[Cell, Cell] | "gap" | Row> = [];
	let i = 0;
	while (i < rows.length) {
		const row = rows[i]!;
		if (row.kind === "gap") {
			pairs.push(row);
			i++;
		} else if (row.kind === "ctx") {
			pairs.push([
				{ no: row.oldNo, body: code[i]!, kind: "ctx" },
				{ no: row.newNo, body: code[i]!, kind: "ctx" },
			]);
			i++;
		} else {
			const dels: number[] = [];
			while (i < rows.length && rows[i]!.kind === "del") dels.push(i++);
			const adds: number[] = [];
			while (i < rows.length && rows[i]!.kind === "add") adds.push(i++);
			for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
				const d = dels[k];
				const a = adds[k];
				pairs.push([
					d === undefined ? undefined : { no: rows[d]!.oldNo, body: code[d]!, kind: "del", ranges: rows[d]!.ranges },
					a === undefined ? undefined : { no: rows[a]!.newNo, body: code[a]!, kind: "add", ranges: rows[a]!.ranges },
				]);
			}
		}
	}

	const renderCell = (cell: Cell): string[] => {
		if (!cell) return [`${" ".repeat(numW)}  ${stripe(codeW)}`];
		const numText = String(cell.no ?? "").padStart(numW);
		const num =
			cell.kind === "add" ? s.fg("diffAddFg", numText) : cell.kind === "del" ? s.fg("diffDelFg", numText) : s.fg("gutter", numText);
		const bgToken = cell.kind === "add" ? "diffAddBg" : cell.kind === "del" ? "diffDelBg" : undefined;
		const wordToken = cell.kind === "add" ? "diffAddWordBg" : "diffDelWordBg";
		const body = bgToken ? paintRanges(cell.body, cell.ranges, s.bgAnsi(bgToken), s.bgAnsi(wordToken)) : cell.body;
		return wrap(body, codeW, maxWrap, s).map((part, k) => {
			const gutter = k === 0 ? num : " ".repeat(numW);
			const content = bgToken ? `${s.bgAnsi(bgToken)}${fit(part, codeW)}${RESET_BG}` : fit(part, codeW);
			return `${gutter}  ${content}`;
		});
	};

	const out: string[] = [];
	for (const pair of pairs) {
		if (!Array.isArray(pair)) {
			out.push(gapLine(pair as Row, numW, s));
			continue;
		}
		const left = renderCell(pair[0]);
		const right = renderCell(pair[1]);
		const h = Math.max(left.length, right.length);
		const blank = (cell: Cell) =>
			cell && cell.kind !== "ctx"
				? `${" ".repeat(numW)}  ${s.bgAnsi(cell.kind === "add" ? "diffAddBg" : "diffDelBg")}${" ".repeat(codeW)}${RESET_BG}`
				: " ".repeat(halfW);
		for (let k = 0; k < h; k++) {
			out.push(`${fit(left[k] ?? blank(pair[0]), halfW)}${sep}${fit(right[k] ?? blank(pair[1]), halfW)}`);
		}
	}
	return out;
}
