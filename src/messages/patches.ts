/**
 * The only places we touch pi internals (there is no API for these):
 *   1. UserMessageComponent.render       → full-width prompt band + timestamp
 *   2. AssistantMessageComponent.updateContent → "∴ Thought for 2.0s", skinned markdown, timestamp
 *   3. stacking: drop the blank line between consecutive one-line rows
 *   4. assistant Markdown.renderToken → dashed code frames (instance-local)
 *
 * Every patch checks the methods it wraps exist, keeps the original, and falls
 * back to it whenever the skin isn't loaded or a feature is switched off.
 * uninstallPatches() restores everything.
 */
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	getMarkdownTheme,
	SkillInvocationMessageComponent,
	InteractiveMode,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Container,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
	wrapTextWithAnsi as wrapAnsi,
} from "@earendil-works/pi-tui";
import { highlight, langFromPath } from "../shiki.ts";
import { store, ticker } from "../state.ts";
import { OWN_RENDERERS } from "../tools/index.ts";
import { frame, innerWidth } from "../box.ts";
import { CHIP, displayImages } from "../images.ts";
import { clip, fit, fmtClock, fmtDuration, spread, stripAnsi, textOf, visibleWidth } from "../util.ts";
import { runDuration } from "./thinking.ts";

const OSC_A = "\x1b]133;A\x07";
const OSC_BC = "\x1b]133;B\x07\x1b]133;C\x07";

const PATCHED = Symbol.for("pi-facet.patched");
const originals: Array<() => void> = [];

type Any = any;

function patch<T extends object>(proto: T, name: string, make: (original: Any) => Any): boolean {
	const target = proto as Any;
	const original = target?.[name];
	if (typeof original !== "function") return false;
	if (original[PATCHED]) return true;
	const replacement = make(original);
	replacement[PATCHED] = true;
	target[name] = replacement;
	originals.push(() => {
		target[name] = original;
	});
	return true;
}

export function uninstallPatches(): void {
	while (originals.length) originals.pop()!();
}

// ─── chat container tracking (for stacking + bulk invalidation) ─────────────

let chat: Container | undefined;
let siblingCacheLen = -1;
let siblingCacheArr: Component[] | undefined;
const prevOf = new WeakMap<Component, Component | undefined>();
const nextOf = new WeakMap<Component, Component | undefined>();

function syncSiblings(): void {
	const children = chat?.children;
	if (!children) return;
	if (children !== siblingCacheArr || children.length !== siblingCacheLen) {
		siblingCacheArr = children;
		siblingCacheLen = children.length;
		for (let i = 0; i < children.length; i++) {
			prevOf.set(children[i]!, i > 0 ? children[i - 1] : undefined);
			nextOf.set(children[i]!, children[i + 1]);
		}
	}
}

function prevSibling(component: Component): Component | undefined {
	syncSiblings();
	return prevOf.get(component);
}

function nextSibling(component: Component): Component | undefined {
	syncSiblings();
	return nextOf.get(component);
}

function isOurTool(component: Any): boolean {
	return component instanceof ToolExecutionComponent && OWN_RENDERERS.has((component as Any).toolDefinition?.renderCall);
}

// ─── grouping: runs of quiet read-only tools fold into one summary line ─────

const GROUP_NOUNS: Record<string, [string, string, string]> = {
	read: ["Read", "file", "files"],
	grep: ["searched", "pattern", "patterns"],
	find: ["searched", "pattern", "patterns"],
	ls: ["listed", "directory", "directories"],
};

/** A finished, successful, collapsed read/search/list row. */
function groupable(component: Component | undefined): boolean {
	const c = component as Any;
	return (
		!!c &&
		isOurTool(c) &&
		c.toolName in GROUP_NOUNS &&
		!c.expanded &&
		c.rendererState?.status === "done" &&
		c.rendererState?.compact === true &&
		!c.result?.isError
	);
}

/** Assistant messages with nothing visible don't break a run. */
function isTransparent(component: Component | undefined): boolean {
	return component instanceof AssistantMessageComponent && (component as Any).__pmtEmpty === true;
}

function groupNeighbour(component: Component, step: (c: Component) => Component | undefined): Component | undefined {
	let c = step(component);
	while (c && isTransparent(c)) c = step(c);
	return c;
}

function groupSummary(members: Any[]): string {
	const s = store.s;
	const counts = new Map<string, { n: number; one: string; many: string }>();
	for (const m of members) {
		const [verb, one, many] = GROUP_NOUNS[m.toolName]!;
		const entry = counts.get(verb) ?? { n: 0, one, many };
		entry.n++;
		counts.set(verb, entry);
	}
	const parts = [...counts.entries()].map(([verb, { n, one, many }], i) => {
		const v = i === 0 ? verb[0]!.toUpperCase() + verb.slice(1) : verb.toLowerCase();
		return `${s.fg("muted", `${v} `)}${s.bold(s.fg("textSecondary", String(n)))}${s.fg("muted", ` ${n === 1 ? one : many}`)}`;
	});
	return `  ${s.fg("toolBullet", s.glyphs.bullet)} ${parts.join(s.fg("muted", ", "))}${s.fg("dim", "  (ctrl+o to expand)")}`;
}

// ─── other extensions' tools: same frame as ours, their content untouched ────

function isBlank(line: string): boolean {
	return stripAnsi(line).trim() === "";
}

/**
 * Tools from other extensions render inside pi's default shell (a padded box on
 * a background). Render their call/result components directly instead and give
 * them our bullet + indent so every tool row reads the same.
 */
function renderForeignTool(this: Any, width: number, original: Any): string[] {
	if (typeof this.getRenderShell === "function" && this.getRenderShell() === "self") return original.call(this, width);
	if (this.hideComponent) return [];
	const s = store.s;
	const inner = Math.max(10, width - 6);
	const trim = (lines: string[]) => {
		while (lines.length && isBlank(lines[0]!)) lines.shift();
		while (lines.length && isBlank(lines[lines.length - 1]!)) lines.pop();
		return lines;
	};
	let header: string[];
	let body: string[];
	if (this.hasRendererDefinition?.()) {
		const parts: Component[] = [...(this.contentBox?.children ?? [])];
		header = trim(parts.slice(0, 1).flatMap((part) => part.render(inner + 2)));
		body = trim(parts.slice(1).flatMap((part) => part.render(inner)));
	} else {
		// no renderer at all: name + compact args, then the text output
		let args = "";
		try {
			args = JSON.stringify(this.args ?? {});
		} catch {
			args = "";
		}
		if (args === "{}") args = "";
		header = [`${s.bold(s.fg("text", String(this.toolName)))}${args ? ` ${s.fg("muted", args)}` : ""}`];
		const output = textOf(this.result).trim();
		const all = output ? output.split("\n") : [];
		body = this.expanded || all.length <= 6 ? all : [...all.slice(0, 5), s.fg("dim", `${s.glyphs.ellipsis} +${all.length - 5} lines (ctrl+o to expand)`)];
		body = body.map((line) => (this.result?.isError ? s.fg("error", line) : line));
	}
	for (const image of this.imageComponents ?? []) body.push(...(image as Component).render(inner));
	if (header.length === 0 && body.length === 0) return [];
	const lines = header.length ? header : [s.bold(s.fg("text", String(this.toolName)))];

	const key = `tool:${this.toolCallId}`;
	let glyph: string;
	if (this.isPartial && !this.result?.isError) {
		ticker.hold(key);
		glyph = s.fg("accent", ticker.spinner(s.glyphs.spinner));
	} else {
		ticker.release(key);
		glyph = s.fg(this.result?.isError ? "error" : "toolBullet", s.glyphs.bullet);
	}
	const hook = `    ${s.fg("dim", "└")} `;
	return [
		"",
		`  ${glyph} ${lines[0]}`,
		...lines.slice(1).map((line) => `    ${line}`),
		...body.map((line, i) => `${i === 0 ? hook : "      "}${line}`),
	].map((line) => clip(line, width));
}

/** Does this component end with a single collapsed row? */
function endsCompact(component: Component | undefined): boolean {
	if (!component) return false;
	const c = component as Any;
	if (isOurTool(c)) return c.rendererState?.compact !== false && !c.expanded;
	if (component instanceof AssistantMessageComponent) {
		// a message with nothing visible (e.g. only tool calls) is transparent
		if (c.__pmtEmpty === true) return endsCompact(prevSibling(component));
		return c.__pmtCompactTail === true;
	}
	return false;
}

/** For tests/harnesses that build a chat container by hand. */
export function setChatContainer(container: Container | undefined): void {
	chat = container;
}

export function invalidateChat(): void {
	for (const child of chat?.children ?? []) child.invalidate();
}

// ─── markdown theme ──────────────────────────────────────────────────────────

const LEVEL_MARK = 0xe000; // private-use code points carry heading level 1-6

/** Tag heading lines (outside code fences) with an invisible level marker. */
function tagHeadings(markdown: string): string {
	if (!markdown.includes("#")) return markdown;
	let fence: string | undefined;
	return markdown
		.split("\n")
		.map((line) => {
			const f = line.match(/^\s*(```+|~~~+)/);
			if (f) {
				if (!fence) fence = f[1]![0];
				else if (f[1]![0] === fence) fence = undefined;
				return line;
			}
			if (fence) return line;
			const h = line.match(/^(#{1,6})\s+(.*)$/);
			return h ? `${h[1]} ${String.fromCharCode(LEVEL_MARK + h[1]!.length)}${h[2]}` : line;
		})
		.join("\n");
}

let lastHeadingLevel = 2;

function skinMarkdownTheme(onReady: () => void): MarkdownTheme {
	const s = store.s;
	const base = getMarkdownTheme();
	return {
		...base,
		heading: (text: string) => {
			let t = text;
			const marker = t.match(/[-]/);
			if (marker) {
				lastHeadingLevel = marker[0].charCodeAt(0) - LEVEL_MARK;
				t = t.replace(/[-]/g, "");
			}
			const plain = t.replace(/\x1b\[[0-9;]*m/g, "");
			// hide "### " prefixes (Grok style)
			if (/^#{1,6} $/.test(plain)) return "";
			t = t.replace(/\x1b\[4m|\x1b\[24m/g, "");
			const level = Math.min(4, lastHeadingLevel);
			return s.bold(s.fg(`h${level}` as "h1", t));
		},
		listBullet: (marker: string) =>
			/^[-*+] /.test(marker) ? s.fg("bullet", `${s.glyphs.listBullet} ${marker.slice(2)}`) : s.fg("muted", marker),
		hr: () => s.fg("muted", "───"),
		code: (text: string) => (s.codeBold ? s.bold(s.fg("code", text)) : s.fg("code", text)),
		// many terminal fonts have cursive italics; render emphasis as plain text
		italic: (text: string) => text,
		link: (text: string) => s.fg("link", `\x1b[4m${text}\x1b[24m`),
		codeBlockBorder: (text: string) => {
			const lang = text.replace(/^`{3,}/, "").trim();
			return lang && !["text", "txt", "plain", "plaintext"].includes(lang) ? s.fg("dim", lang) : "";
		},
		highlightCode: (code: string, lang?: string) => {
			const resolved = lang ? (langFromPath(`x.${lang}`) ?? lang) : undefined;
			return highlight(code, resolved, onReady) ?? code.split("\n").map((l) => base.codeBlock(l));
		},
	};
}

function transformChain(component: Any, messageType: string): (md: string, width: number) => string {
	const transformers: Any[] = component.markdownTransformers ?? [];
	return (md, availableWidth) => {
		let out = md;
		for (const t of transformers) {
			try {
				const next = t(out, { messageType, isStreaming: component.isStreaming, availableWidth });
				if (typeof next === "string") out = next;
			} catch {
				// a broken transformer shouldn't break rendering
			}
		}
		return messageType === "assistant" ? tagHeadings(out) : out;
	};
}

// ─── components ──────────────────────────────────────────────────────────────

/** Frame code tokens before Markdown adds list/quote prefixes and outer padding. */
function boxCodeBlocks(markdown: Markdown, theme: MarkdownTheme): void {
	const md = markdown as Any;
	const original = md.renderToken;
	if (typeof original !== "function") return;
	md.renderToken = function (token: Any, width: number, nextTokenType?: string, ...rest: Any[]): string[] {
		if (token.type !== "code" || width < 5) return original.call(this, token, width, nextTokenType, ...rest);
		try {
			const s = store.s;
			const code = theme.highlightCode?.(token.text, token.lang) ?? token.text.split("\n").map(theme.codeBlock);
			const content = code.flatMap((line: string) => wrapAnsi(line, innerWidth(width)));
			const lang = String(token.lang ?? "").trim();
			const label = lang && !["text", "txt", "plain", "plaintext"].includes(lang) ? s.fg("dim", lang) : "";
			const lines = frame(content, width, { border: "border", dashed: true, topLeft: label });
			if (nextTokenType && nextTokenType !== "space") lines.push("");
			return lines;
		} catch {
			return original.call(this, token, width, nextTokenType, ...rest);
		}
	};
}

/** Collapses runs of blank lines (hidden code fences leave doubles). */
class Tidy implements Component {
	constructor(private readonly child: Component) {}
	render(width: number): string[] {
		const out: string[] = [];
		let blank = false;
		for (const line of this.child.render(width)) {
			const isBlank = line.replace(/\x1b\[[0-9;]*m/g, "").trim() === "";
			if (isBlank && blank) continue;
			blank = isBlank;
			out.push(line);
		}
		while (out.length && out[out.length - 1]!.replace(/\x1b\[[0-9;]*m/g, "").trim() === "") out.pop();
		return out;
	}
	invalidate(): void {
		this.child.invalidate();
	}
}

/** Puts the block bullet in col 2 of a child rendered with 4 columns of left padding. */
class Bulleted implements Component {
	constructor(
		private readonly child: Component,
		private readonly bullet: string,
	) {}
	render(width: number): string[] {
		const lines = this.child.render(width);
		if (lines.length === 0) return lines;
		const first = lines[0]!;
		if (first.startsWith("    ")) lines[0] = `  ${this.bullet} ${first.slice(4)}`;
		return lines;
	}
	invalidate(): void {
		this.child.invalidate();
	}
}

/** Puts a right-aligned stamp on a child's first line when it fits. */
class Stamped implements Component {
	constructor(
		private readonly child: Component,
		private readonly stamp: string,
	) {}
	render(width: number): string[] {
		const lines = this.child.render(width);
		if (!this.stamp || lines.length === 0) return lines;
		const sw = visibleWidth(this.stamp);
		const first = lines[0]!.replace(/\s+$/, "");
		const fw = visibleWidth(first);
		if (fw + sw + 3 <= width) lines[0] = first + " ".repeat(width - fw - sw - 1) + this.stamp;
		return lines;
	}
	invalidate(): void {
		this.child.invalidate();
	}
}

/**
 * Thinking, Claude Code style — one quiet line, no emphasis:
 *
 *   ∴ Thinking… 3.1s          (streaming; last few lines previewed below, dim)
 *   ∴ Thought for 2.0s        (done; Ctrl+T / click expands the plain dim text)
 */
class ThinkingBlock implements Component {
	private readonly body: Markdown | undefined;

	constructor(
		private readonly owner: Any,
		private readonly from: number,
		private readonly to: number,
		private readonly text: string,
		private readonly expanded: boolean,
		private readonly streaming: boolean,
	) {
		if (expanded) {
			const s = store.s;
			const quiet = (t: string) => s.fg("thinking", t);
			const plain = (t: string) => t;
			this.body = new Markdown(
				text,
				4,
				0,
				{
					...getMarkdownTheme(),
					heading: quiet,
					bold: plain,
					italic: plain,
					underline: plain,
					code: quiet,
					codeBlock: quiet,
					codeBlockBorder: () => "",
					listBullet: (m: string) => s.fg("dim", /^[-*+] /.test(m) ? `${s.glyphs.listBullet} ` : m),
					quote: quiet,
					quoteBorder: (t: string) => s.fg("dim", t),
					link: quiet,
					linkUrl: (t: string) => s.fg("dim", t),
					hr: () => s.fg("dim", "───"),
				},
				{ color: quiet },
			);
		}
	}

	render(width: number): string[] {
		const s = store.s;
		const ts = this.owner.lastMessage?.timestamp as number | undefined;
		const { ms, active } = runDuration(ts, this.from, this.to);
		const live = this.streaming && (active || ms === undefined);
		const key = `thinking:${ts}:${this.from}`;
		const mark = s.fg("dim", s.glyphs.thinking);
		const lines: string[] = [];
		if (live) {
			ticker.hold(key);
			const time = ms !== undefined && store.config.thinking.showDuration ? ` ${fmtDuration(ms)}` : "";
			lines.push(`  ${mark} ${s.fg("muted", `Thinking…${time}`)}`);
			const n = store.config.thinking.streamPreviewLines;
			if (n > 0 && !this.expanded) {
				const wrapped = wrapAnsi(this.text.replace(/\s+$/, ""), Math.max(10, width - 4));
				for (const l of wrapped.slice(-n)) lines.push(`    ${s.fg("dim", l)}`);
			}
		} else {
			ticker.release(key);
			const label = ms !== undefined && store.config.thinking.showDuration ? `Thought for ${fmtDuration(ms)}` : "Thought";
			lines.push(`  ${mark} ${s.fg("muted", label)}`);
		}
		if (this.body) lines.push(...this.body.render(width));
		return lines.map((l) => clip(l, width));
	}

	invalidate(): void {}
}

function wrapPrompt(text: string, textW: number): string[] {
	const cfg = store.config.messages;
	const s = store.s;
	let rows = wrapAnsi(displayImages(String(text ?? "")).replace(/\s+$/, ""), Math.max(4, textW));
	if (cfg.collapseUserAfter > 0 && rows.length > cfg.collapseUserAfter) {
		rows = rows.slice(0, cfg.collapseUserAfter);
		rows[rows.length - 1] = `${rows[rows.length - 1]} ${s.glyphs.ellipsis}`;
	}
	return rows;
}

/** Your prompt in the chat: a rounded box (default), a filled band, or plain. */
function renderUserMessage(this: Any, original: Any, width: number): string[] {
	const cfg = store.config.messages;
	if (!store.skin || width < 16) return original.call(this, width);
	const key = `${width}:${store.epoch}:${this.__pmtTs ?? ""}`;
	if (this.__pmtKey === key && this.__pmtText === this.text) return this.__pmtLines;
	const s = store.s;
	const stamp = cfg.timestamps && this.__pmtTs ? s.fg("timestamp", fmtClock(this.__pmtTs, cfg.timeFormat)) : "";
	const prompt = s.fg("prompt", s.glyphs.prompt);
	let lines: string[];

	if (cfg.userStyle === "band") {
		const band = s.bgAnsi("band");
		const reserve = stamp ? visibleWidth(stamp) + 3 : 0;
		const rows = wrapPrompt(this.text, width - 6 - reserve);
		const paint = (content: string) => `${band}${fit(content, width)}\x1b[49m`;
		lines = [paint("")];
		rows.forEach((row, i) => {
			let content = `${i === 0 ? `  ${prompt} ` : "    "}${s.fg("text", row)}`;
			if (i === 0 && stamp) content = fit(content, width - visibleWidth(stamp) - 2) + stamp;
			lines.push(paint(content.replace(/\x1b\[(0|49)m/g, (m) => `${m}${band}`)));
		});
		lines.push(paint(""));
	} else if (cfg.userStyle === "plain") {
		const reserve = stamp ? visibleWidth(stamp) + 3 : 0;
		const rows = wrapPrompt(this.text, width - 4 - reserve);
		lines = rows.map((row, i) => {
			const content = `${i === 0 ? `  ${prompt} ` : "    "}${s.fg("text", row)}`;
			return i === 0 && stamp ? fit(content, width - visibleWidth(stamp) - 1) + stamp : content;
		});
	} else {
		const inner = innerWidth(width);
		const rows = wrapPrompt(this.text, inner - 2);
		const chips = (row: string) => row.replace(CHIP, (chip) => `${s.fgAnsi("info")}${chip}${s.fgAnsi("text")}`);
		const content = rows.map((row, i) => `${i === 0 ? `${prompt} ` : "  "}${s.fg("text", chips(row))}`);
		lines = frame(content, width, { border: "border", topRight: stamp });
	}
	lines[0] = OSC_A + lines[0];
	lines[lines.length - 1] = OSC_BC + lines[lines.length - 1];
	this.__pmtKey = key;
	this.__pmtText = this.text;
	this.__pmtLines = lines;
	return lines;
}

/** Skill invocations get the same box, labelled "skill". */
function renderSkill(this: Any, original: Any, width: number): string[] {
	if (!store.skin || store.config.messages.userStyle !== "box" || width < 16) return original.call(this, width);
	const key = `${width}:${store.epoch}:${this.expanded}`;
	if (this.__pmtKey === key) return this.__pmtLines;
	const s = store.s;
	const inner = innerWidth(width);
	const name = String(this.skillBlock?.name ?? "skill");
	let content: string[];
	if (this.expanded) {
		const md = new Markdown(String(this.skillBlock?.content ?? ""), 0, 0, getMarkdownTheme(), {
			color: (t: string) => s.fg("textSecondary", t),
		});
		content = [`${s.fg("accent", s.glyphs.bullet)} ${s.bold(s.fg("text", name))}`, "", ...md.render(inner)];
	} else {
		content = [spread(`${s.fg("accent", s.glyphs.bullet)} ${s.fg("text", name)}`, s.fg("dim", "ctrl+o to expand"), inner)];
	}
	const lines = frame(content, width, { border: "border", topLeft: s.fg("accent", "skill") });
	this.__pmtKey = key;
	this.__pmtLines = lines;
	return lines;
}

/** "!command" runs: boxed, titled with the command. */
function renderUserBash(this: Any, original: Any, width: number): string[] {
	if (!store.skin || store.config.messages.userStyle !== "box" || width < 16) return original.call(this, width);
	const s = store.s;
	const inner = innerWidth(width);
	const body: string[] = this.contentContainer.render(inner).slice(1); // drop pi's "$ cmd" header
	while (body.length && stripAnsi(body[0]!).trim() === "") body.shift();
	while (body.length && stripAnsi(body[body.length - 1]!).trim() === "") body.pop();
	const sign = s.fg(this.excludeFromContext ? "dim" : "borderBash", "$");
	const title = `${sign} ${s.fg("text", clip(String(this.command ?? ""), Math.max(8, width - 12)))}`;
	return ["", ...frame(body, width, { border: "border", topLeft: title })];
}

function updateAssistant(this: Any, original: Any, message: Any, isStreaming?: boolean): void {
	if (!store.skin) {
		original.call(this, message, isStreaming);
		return;
	}
	const streaming = isStreaming ?? this.isStreaming;
	this.lastMessage = message;
	this.isStreaming = streaming;
	const container: Container = this.contentContainer;
	container.clear();
	const s = store.s;
	const content: Any[] = message.content ?? [];
	const visible = (c: Any) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim());
	const hasVisible = content.some(visible);
	if (hasVisible) container.addChild(new Spacer(1));

	const onReady = () => {
		if (this.lastMessage) this.updateContent(this.lastMessage);
		store.requestRender();
	};
	const theme = skinMarkdownTheme(onReady);
	const cfg = store.config.messages;
	let stamped = false;
	let runIndex = 0;
	let firstKind: "thinking" | "text" | undefined;
	let lastKind: "thinking-collapsed" | "other" | undefined;

	for (let i = 0; i < content.length; i++) {
		const block = content[i];
		if (block.type === "text" && block.text.trim()) {
			firstKind ??= "text";
			const md = new Markdown(block.text.trim(), 4, 0, theme, undefined, {
				transform: transformChain(this, "assistant"),
			});
			boxCodeBlocks(md, theme);
			const stamp = !stamped && cfg.replyTimestamps && message.timestamp ? s.fg("timestamp", fmtClock(message.timestamp, cfg.timeFormat)) : "";
			stamped = true;
			const tidy = new Bulleted(new Tidy(md), s.fg("replyBullet", s.glyphs.bullet));
			container.addChild(stamp ? new Stamped(tidy, stamp) : tidy);
			lastKind = "other";
		} else if (block.type === "thinking") {
			const from = i;
			const texts: string[] = [];
			for (; i < content.length && content[i].type === "thinking"; i++) {
				const t = String(content[i].thinking ?? "").trim();
				if (t) texts.push(t);
			}
			i--;
			if (texts.length === 0) continue;
			firstKind ??= "thinking";
			const run = runIndex++;
			const hidden = this.thinkingVisibilityOverrides.get(run) ?? this.hideThinkingBlock;
			const lastBlock = !content.slice(i + 1).some(visible);
			const block = new ThinkingBlock(this, from, i, texts.join("\n\n"), !hidden, streaming && lastBlock);
			container.addChild(
				new MouseRegion(block, (event: Any) => {
					if (event.type !== "click" || event.button !== "left") return undefined;
					this.thinkingVisibilityOverrides.set(run, !hidden);
					if (this.lastMessage) this.updateContent(this.lastMessage);
					return { handled: true };
				}),
			);
			const hasAfter = content.slice(i + 1).some(visible);
			if (hasAfter) container.addChild(new Spacer(1));
			lastKind = hidden && !(streaming && lastBlock) ? "thinking-collapsed" : "other";
		}
	}

	const hasToolCalls = content.some((c) => c.type === "toolCall");
	this.hasToolCalls = hasToolCalls;
	let errored = false;
	if (message.stopReason === "length") {
		container.addChild(new Spacer(1));
		container.addChild(new Text(`${s.fg("error", s.glyphs.bullet)} ${s.fg("error", "Response was truncated before completion.")}`, 2, 0));
		errored = true;
	} else if (!hasToolCalls && (message.stopReason === "aborted" || message.stopReason === "error")) {
		const msg =
			message.stopReason === "aborted"
				? message.errorMessage && message.errorMessage !== "Request was aborted"
					? message.errorMessage
					: "Operation aborted"
				: `Error: ${message.errorMessage || "Unknown error"}`;
		container.addChild(new Spacer(1));
		container.addChild(new Text(`${s.fg("error", s.glyphs.bullet)} ${s.fg("error", msg)}`, 2, 0));
		errored = true;
	}
	this.__pmtEmpty = !hasVisible && !errored;
	this.__pmtCompactHead = firstKind === "thinking" && runIndex > 0 && lastKind !== undefined;
	this.__pmtCompactTail = !errored && lastKind === "thinking-collapsed";
}

/** Drop a leading blank line, moving any OSC prefix onto the next line. */
function dropLeadingBlank(lines: string[]): string[] {
	if (lines.length < 2) return lines;
	const first = lines[0]!;
	if (first.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "").trim() !== "") return lines;
	const osc = first.match(/^(\x1b\][^\x07]*\x07)+/)?.[0] ?? "";
	const out = lines.slice(1);
	out[0] = osc + out[0];
	return out;
}

export function installPatches(): string[] {
	const failed: string[] = [];

	if (
		!patch(InteractiveMode.prototype, "addMessageToChat", (original) =>
			function (this: Any, message: Any, options: Any) {
				const result = original.call(this, message, options);
				try {
					chat = this.chatContainer ?? chat;
					if (message?.role === "user" && chat) {
						const children = chat.children;
						for (let i = children.length - 1; i >= Math.max(0, children.length - 4); i--) {
							const c = children[i] as Any;
							if (c instanceof UserMessageComponent) {
								(c as Any).__pmtTs ??= message.timestamp;
								break;
							}
						}
					}
				} catch {
					// never break pi's own rendering
				}
				return result;
			},
		)
	)
		failed.push("InteractiveMode.addMessageToChat");

	if (
		!patch(UserMessageComponent.prototype, "render", (original) =>
			function (this: Any, width: number) {
				try {
					return renderUserMessage.call(this, original, width);
				} catch {
					return original.call(this, width);
				}
			},
		)
	)
		failed.push("UserMessageComponent.render");

	for (const [proto, name, fn] of [
		[SkillInvocationMessageComponent.prototype, "SkillInvocationMessageComponent.render", renderSkill],
		[BashExecutionComponent.prototype, "BashExecutionComponent.render", renderUserBash],
	] as const) {
		const ok = patch(proto, "render", (original) =>
			function (this: Any, width: number) {
				try {
					return (fn as Any).call(this, original, width);
				} catch {
					return original.call(this, width);
				}
			},
		);
		if (!ok) failed.push(name);
	}

	if (
		!patch(AssistantMessageComponent.prototype, "updateContent", (original) =>
			function (this: Any, message: Any, isStreaming?: boolean) {
				try {
					updateAssistant.call(this, original, message, isStreaming);
				} catch {
					original.call(this, message, isStreaming);
				}
			},
		)
	)
		failed.push("AssistantMessageComponent.updateContent");

	patch(AssistantMessageComponent.prototype, "render", (original) =>
		function (this: Any, width: number) {
			const lines = original.call(this, width);
			try {
				if (store.skin && store.config.layout.stackRows && this.__pmtCompactHead && endsCompact(prevSibling(this))) {
					return dropLeadingBlank(lines);
				}
			} catch {
				// fall through
			}
			return lines;
		},
	);

	if (
		!patch(ToolExecutionComponent.prototype, "render", (original) =>
			function (this: Any, width: number) {
				try {
					if (store.skin && store.config.tools.restyleOthers && !isOurTool(this)) return renderForeignTool.call(this, width, original);
				} catch {
					// fall through to pi's rendering
				}
				try {
					if (store.skin && store.config.layout.groupTools && groupable(this)) {
						// a later member of a run renders nothing; the first renders the summary
						if (groupable(groupNeighbour(this, prevSibling))) return [];
						const members: Any[] = [this];
						for (let c = groupNeighbour(this, nextSibling); groupable(c); c = groupNeighbour(c!, nextSibling)) members.push(c);
						if (members.length > 1) return ["", clip(groupSummary(members), width)];
					}
				} catch {
					// fall through to normal rendering
				}
				const lines = original.call(this, width);
				try {
					if (
						store.skin &&
						store.config.layout.stackRows &&
						isOurTool(this) &&
						this.rendererState?.compact !== false &&
						!this.expanded &&
						endsCompact(prevSibling(this))
					) {
						return dropLeadingBlank(lines);
					}
				} catch {
					// fall through
				}
				return lines;
			},
		)
	)
		failed.push("ToolExecutionComponent.render");

	return failed;
}
