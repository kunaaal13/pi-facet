/**
 * The input box:
 *
 *   ╭─ ~/D/mine · main ─────────────────────── 9.5K / 500K ─╮
 *   │                                                        │
 *   │  ❯ █                                                   │
 *   │                                                        │
 *   ╰──────────────────────────────── gpt-6.1 (medium) ─────╯
 *
 * Extends pi's CustomEditor (so every app keybinding keeps working) and only
 * re-frames its output. Pasted images become "[Image #n]" tokens.
 */
import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { borderRow } from "../box.ts";
import { CHIP, imageTokenSpans, rememberPaste, tokenizePaste } from "../images.ts";
import { store } from "../state.ts";
import { clip, fit, fmtWindow, shortCwd } from "../util.ts";

const PAD_X = 2; // "│  " … "  │" (one terminal column ≈ 7–9px)
const PROMPT = 2; // "❯ "

export interface EditorInfo {
	branch?: string;
}

export function contextGauge(): string {
	const s = store.s;
	const usage = store.ctx?.getContextUsage();
	const window = usage?.contextWindow ?? store.ctx?.model?.contextWindow;
	if (!window) return "";
	const tokens = usage?.tokens;
	if (tokens == null) return s.fg("muted", `? / ${fmtWindow(window)}`);
	const pct = (tokens / window) * 100;
	const token = pct >= 95 ? "error" : pct >= 75 ? "warning" : pct >= 50 ? "textSecondary" : "muted";
	return `${s.fg(token, fmtWindow(tokens))}${s.fg("dim", ` / ${fmtWindow(window)}`)}`;
}

export function modelLabel(pi: ExtensionAPI): string {
	const s = store.s;
	const model = store.ctx?.model;
	const name = model?.name || model?.id || "no model";
	const level = pi.getThinkingLevel();
	const thinking = model?.reasoning && level && level !== "off" ? ` (${level})` : "";
	return `${s.fg("model", name)}${s.fg("muted", thinking)}`;
}

/**
 * Caret: pi paints a fake inverse block and also marks the real cursor position.
 * For "bar"/"underline" we show the terminal's cursor there (DECSCUSR shape,
 * optional OSC 12 colour) and drop the painted block.
 */
let caretActive = false;
let caretTui: TUI | undefined;
let caretPrevShow = false;

function write(data: string): void {
	try {
		process.stdout.write(data);
	} catch {
		// terminal gone
	}
}

export function applyCaret(tui: TUI): void {
	const { caret, caretBlink, caretAccent } = store.config.chrome;
	if (caret === "block" || typeof tui.setShowHardwareCursor !== "function") {
		restoreCaret();
		return;
	}
	if (!caretActive) caretPrevShow = tui.getShowHardwareCursor();
	caretActive = true;
	caretTui = tui;
	const shape = caret === "bar" ? (caretBlink ? 5 : 6) : caretBlink ? 3 : 4;
	write(`\x1b[${shape} q`);
	const accent = store.skin?.color("accent");
	if (caretAccent && accent) write(`\x1b]12;${accent}\x07`);
	tui.setShowHardwareCursor(true);
}

export function restoreCaret(): void {
	if (!caretActive) return;
	caretActive = false;
	write("\x1b[0 q\x1b]112\x07");
	caretTui?.setShowHardwareCursor(caretPrevShow);
	caretTui = undefined;
}

process.once("exit", () => {
	if (caretActive) write("\x1b[0 q\x1b]112\x07");
});

export function createEditorFactory(pi: ExtensionAPI, info: EditorInfo) {
	return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => new MinimalEditor(tui, theme, keybindings, pi, info);
}

export class MinimalEditor extends CustomEditor {
	private readonly pi: ExtensionAPI;
	private readonly info: EditorInfo;
	private hiddenBelow = 0;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, pi: ExtensionAPI, info: EditorInfo) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.pi = pi;
		this.info = info;
		store.tui = tui;
		applyCaret(tui);

		// pi's editor treats "[paste #n …]" markers as one unit for cursor moves and
		// deletion via segment(); extend that to "[Image #n]" tokens.
		const self = this as unknown as {
			segment: (text: string, mode?: string) => Iterable<{ segment: string; index: number; input: string }>;
			submitValue: () => void;
			pastes: Map<number, string>;
		};
		const baseSegment = self.segment.bind(this);
		self.segment = (text, mode) => {
			const segments = baseSegment(text, mode);
			if (!text.includes("[Image #")) return segments;
			const spans = imageTokenSpans(text);
			const out: Array<{ segment: string; index: number; input: string }> = [];
			let span = 0;
			for (const seg of segments) {
				while (span < spans.length && spans[span]!.end <= seg.index) span++;
				const current = spans[span];
				if (current && seg.index >= current.start && seg.index < current.end) {
					if (seg.index === current.start) out.push({ segment: text.slice(current.start, current.end), index: current.start, input: text });
					continue;
				}
				out.push(seg);
			}
			return out;
		};
		// remember large pastes so the sent message can show them collapsed
		const baseSubmit = self.submitValue.bind(this);
		self.submitValue = () => {
			for (const [id, content] of self.pastes ?? []) rememberPaste(id, content);
			baseSubmit();
		};
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		this.hiddenBelow = hiddenLineCount;
		return super.renderBottomBorder(width, hiddenLineCount);
	}

	/** Clipboard image paste (Ctrl+V) inserts a temp path through here. */
	override insertTextAtCursor(text: string): void {
		super.insertTextAtCursor(tokenizePaste(text) ?? text);
	}

	/** Drag-and-drop / bracketed paste of image paths. */
	override handleInput(data: string): void {
		const start = "\x1b[200~";
		const end = "\x1b[201~";
		if (data.startsWith(start) && data.endsWith(end)) {
			const tokens = tokenizePaste(data.slice(start.length, -end.length));
			if (tokens) {
				super.insertTextAtCursor(tokens);
				return;
			}
		}
		super.handleInput(data);
	}

	render(width: number): string[] {
		// pi re-applies its own showHardwareCursor setting on /reload (after extensions start)
		if (caretActive && caretTui && !caretTui.getShowHardwareCursor()) caretTui.setShowHardwareCursor(true);
		if (!store.skin || !store.config.chrome.editor || width < 20) return super.render(width);
		const s = store.s;
		const g = s.glyphs.border;
		const inner = Math.max(4, width - 2 - PAD_X * 2 - PROMPT);
		const raw = super.render(inner);
		const self = this as unknown as { renderedVisibleLineCount?: number; scrollOffset?: number; focused?: boolean };
		const count = Math.max(1, Math.min(self.renderedVisibleLineCount ?? raw.length - 2, raw.length - 2));
		const text = this.getText();
		const bash = text.startsWith("!");
		const focused = self.focused !== false;
		const border = bash ? "borderBash" : focused ? "borderActive" : "border";
		const side = s.fg(border, g.v);
		const pad = " ".repeat(PAD_X);

		const cwd = s.fg("textSecondary", shortCwd(store.ctx?.cwd ?? process.cwd()));
		const branch = this.info.branch ? s.fg("dim", ` ${s.glyphs.sep} ${this.info.branch}`) : "";
		const above = (self.scrollOffset ?? 0) > 0 ? s.fg("dim", ` ↑${self.scrollOffset}`) : "";
		const below = this.hiddenBelow > 0 ? s.fg("dim", `↓${this.hiddenBelow}`) : "";
		const top = borderRow("top", width, border, `${cwd}${branch}${above}`, contextGauge());
		const bottom = borderRow("bottom", width, border, below, modelLabel(this.pi));

		const prompt = bash ? s.fg("borderBash", "!") : s.fg(focused ? "prompt" : "dim", s.glyphs.prompt);
		const row = (content: string) => `${side}${pad}${fit(content, width - 2 - PAD_X * 2)}${pad}${side}`;
		const padRows = Array.from({ length: Math.max(0, store.config.chrome.editorPaddingY) }, () => row(""));
		const body: string[] = [];
		for (let i = 0; i < count; i++) {
			let line = raw[1 + i] ?? "";
			// the terminal cursor is drawn at pi's cursor marker; drop the painted block
			if (caretActive) line = line.replace(/\x1b\[7m([^\x1b]*)\x1b\[0m/, "$1");
			if (i === 0 && text.length === 0 && store.config.chrome.placeholder) {
				line = `${line.trimEnd()}${s.fg("dim", store.config.chrome.placeholder)}`;
			}
			line = line.replace(CHIP, (chip) => `${s.fgAnsi("info")}${chip}\x1b[39m`);
			const lead = i === 0 && (self.scrollOffset ?? 0) === 0 ? `${prompt} ` : "  ";
			body.push(row(`${lead}${fit(line, inner)}`));
		}
		const autocomplete = raw.slice(2 + count).map((l) => `  ${clip(l, width - 2)}`);
		return [top, ...padRows, ...body, ...padRows, bottom, ...autocomplete];
	}
}
