/**
 * Rounded boxes shared by the input box and boxed chat messages:
 *
 *   ╭─ left label ───────────────── right label ─╮
 *   │ content                                     │
 *   ╰─ bottom left ─────────────── bottom right ─╯
 */
import type { ColorToken } from "./skin.ts";
import { store } from "./state.ts";
import { clip, fit, visibleWidth } from "./util.ts";

export interface FrameOptions {
	border: ColorToken;
	topLeft?: string;
	topRight?: string;
	bottomLeft?: string;
	bottomRight?: string;
	/** Blank rows inside the box above and below the content. */
	padY?: number;
	/** Columns between the side border and the content (default 1). */
	padX?: number;
}

/** Inner content width for a box of `width` columns. */
export function innerWidth(width: number, padX = 1): number {
	return Math.max(1, width - 2 - padX * 2);
}

/** ╭─ left ───────── right ─╮ with labels kept inside the width. */
export function borderRow(kind: "top" | "bottom", width: number, border: ColorToken, left = "", right = ""): string {
	const s = store.s;
	const g = s.glyphs.border;
	const b = (t: string) => s.fg(border, t);
	const [startCorner, endCorner] = kind === "top" ? [g.tl, g.tr] : [g.bl, g.br];
	const start = left ? `${startCorner}${g.h} ` : `${startCorner}${g.h}`;
	const end = right ? ` ${g.h}${endCorner}` : `${g.h}${endCorner}`;
	const fixed = visibleWidth(start) + visibleWidth(end);
	const room = Math.max(0, width - fixed - 1);
	let r = right;
	let l = left;
	if (visibleWidth(r) > room) r = "";
	if (visibleWidth(l) + visibleWidth(r) + (l && r ? 1 : 0) > room) l = clip(l, Math.max(0, room - visibleWidth(r) - 1));
	const gapLeft = l ? " " : "";
	const gapRight = r ? " " : "";
	const fill = Math.max(1, width - fixed - visibleWidth(l) - visibleWidth(r) - gapLeft.length - gapRight.length);
	return clip(`${b(start)}${l}${gapLeft}${b(g.h.repeat(fill))}${gapRight}${r}${b(end)}`, width);
}

/** Wrap already-rendered content lines (each ≤ innerWidth) in a box. */
export function frame(content: string[], width: number, opts: FrameOptions): string[] {
	const s = store.s;
	const g = s.glyphs.border;
	const padX = opts.padX ?? 1;
	const inner = innerWidth(width, padX);
	const side = s.fg(opts.border, g.v);
	const pad = " ".repeat(padX);
	const row = (line: string) => `${side}${pad}${fit(line, inner)}${pad}${side}`;
	const blank = Array.from({ length: opts.padY ?? 0 }, () => row(""));
	return [
		borderRow("top", width, opts.border, opts.topLeft, opts.topRight),
		...blank,
		...content.map(row),
		...blank,
		borderRow("bottom", width, opts.border, opts.bottomLeft, opts.bottomRight),
	];
}
