/**
 * Startup header: the pi-minimal-tui mark (three blocks on a 4×4 grid, drawn
 * with half-blocks so cells come out square) beside a short info column. On
 * startup the pieces drop into place, tetris-style, then it sits still.
 *
 *    ▄▄▄▄▄▄▄▄▄
 *    ███████████    pi  v1.0.0
 *    ███   ▀▀▀▀     ────────────────────────────
 *    ███▄▄▄    ███  ▪ model  GPT-6.1 Sol · medium
 *    ███       ███  ▪ dir    ~/D/uix/essel · main
 */
import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, type Component, foregroundAnsi, parseColor } from "@earendil-works/pi-tui";
import { store, ticker } from "../state.ts";
import { clip, shortCwd } from "../util.ts";

const CORAL = "#F09082";
const BLUE = "#4D9ABF";
const YELLOW = "#F1BE58";

/** Pieces as [row, col] cells on the 4×4 grid (from the SVG mark). */
const PIECES: Array<{ color: string; cells: Array<[number, number]> }> = [
	{ color: YELLOW, cells: [[2, 3], [3, 3]] },
	{ color: BLUE, cells: [[1, 0], [2, 0], [2, 1], [3, 0]] },
	{ color: CORAL, cells: [[0, 0], [0, 1], [0, 2], [1, 2]] },
];

const CELL_W = 3; // columns per grid cell
const CELL_H = 3; // half-rows per grid cell (3 half-rows ≈ 3 columns: square)
const LOGO_W = CELL_W * 4;
const LOGO_HALF_ROWS = CELL_H * 4;
const LOGO_ROWS = LOGO_HALF_ROWS / 2;

const DROP_MS = 380;
const STAGGER_MS = 230;
const INTRO_MS = STAGGER_MS * (PIECES.length - 1) + DROP_MS + 60;

function easeOut(t: number): number {
	const x = Math.min(1, Math.max(0, t));
	return 1 - (1 - x) ** 3;
}

/** Half-row pixel grid of colours (undefined = empty) at time `elapsed`. */
function logoPixels(elapsed: number): Array<Array<string | undefined>> {
	const px: Array<Array<string | undefined>> = Array.from({ length: LOGO_HALF_ROWS }, () => Array(LOGO_W).fill(undefined));
	PIECES.forEach((piece, i) => {
		const progress = easeOut((elapsed - i * STAGGER_MS) / DROP_MS);
		if (progress <= 0) return;
		const fall = Math.round((1 - progress) * LOGO_HALF_ROWS);
		for (const [r, c] of piece.cells) {
			for (let dy = 0; dy < CELL_H; dy++) {
				const y = r * CELL_H + dy - fall;
				if (y < 0 || y >= LOGO_HALF_ROWS) continue;
				for (let dx = 0; dx < CELL_W; dx++) px[y]![c * CELL_W + dx] = piece.color;
			}
		}
	});
	return px;
}

function renderLogo(elapsed: number): string[] {
	const mode = store.piTheme?.getColorMode() ?? "truecolor";
	const fg = (hex: string) => foregroundAnsi(parseColor(hex), mode);
	const bg = (hex: string) => backgroundAnsi(parseColor(hex), mode);
	const px = logoPixels(elapsed);
	const rows: string[] = [];
	for (let r = 0; r < LOGO_ROWS; r++) {
		let line = "";
		for (let c = 0; c < LOGO_W; c++) {
			const top = px[r * 2]![c];
			const bottom = px[r * 2 + 1]![c];
			if (!top && !bottom) line += " ";
			else if (top && bottom && top === bottom) line += `${fg(top)}█\x1b[39m`;
			else if (top && bottom) line += `${fg(top)}${bg(bottom)}▀\x1b[39m\x1b[49m`;
			else if (top) line += `${fg(top)}▀\x1b[39m`;
			else line += `${fg(bottom!)}▄\x1b[39m`;
		}
		rows.push(line);
	}
	return rows;
}

export class Header implements Component {
	private readonly born = Date.now();

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly info: { branch?: string },
		private readonly animate: boolean,
	) {
		if (animate) ticker.hold("header-intro");
	}

	render(width: number): string[] {
		if (!store.skin) return [];
		const s = store.s;
		const elapsed = this.animate ? Date.now() - this.born : INTRO_MS;
		if (elapsed >= INTRO_MS) ticker.release("header-intro");
		const logo = renderLogo(elapsed);

		const sep = s.fg("dim", ` ${s.glyphs.sep} `);
		const mode = store.piTheme?.getColorMode() ?? "truecolor";
		const mark = (hex: string) => `${foregroundAnsi(parseColor(hex), mode)}▪\x1b[39m`;
		const label = (text: string) => s.fg("dim", text.padEnd(7));
		const model = store.ctx?.model;
		const level = this.pi.getThinkingLevel();
		const thinking = model?.reasoning && level && level !== "off" ? `${sep}${s.fg("muted", level)}` : "";
		const cwd = shortCwd(store.ctx?.cwd ?? process.cwd());
		const branch = this.info.branch ? `${sep}${s.fg("muted", this.info.branch)}` : "";
		const ruleW = Math.max(12, Math.min(40, width - LOGO_W - 8));

		// title level with the top block, then a faint rule and two label rows
		const info = [
			"",
			`${s.bold(s.fg("text", "pi"))}${s.fg("dim", `  v${VERSION}`)}`,
			s.fg("border", "─".repeat(ruleW)),
			`${mark(CORAL)} ${label("model")}${s.fg("text", model?.name || model?.id || "no model")}${thinking}`,
			`${mark(BLUE)} ${label("dir")}${s.fg("text", cwd)}${branch}`,
			"",
		];

		const lines = [""];
		const narrow = width < LOGO_W + 30;
		for (let r = 0; r < LOGO_ROWS; r++) {
			const right = narrow ? (r === 1 ? info[1]! : "") : (info[r] ?? "");
			lines.push(clip(`  ${logo[r]}${right ? `    ${right}` : ""}`, width));
		}
		lines.push("");
		return lines;
	}

	invalidate(): void {}
}
