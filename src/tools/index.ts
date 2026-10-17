/**
 * Re-registers pi's seven built-in tools with our renderers. Execution is
 * delegated to pi's own factories (per cwd, with the user's shell/image
 * settings), so the model-facing schema and behaviour are unchanged.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { makePatch, parseUnifiedPatch, renderDiff } from "../diff.ts";
import { displayImages } from "../images.ts";
import { highlightOrPlain, langFromPath } from "../shiki.ts";
import { store } from "../state.ts";
import { displayPath, expandTabs, middleTruncate, plural, splitNotice, textOf, trimTrailingBlank } from "../util.ts";
import {
	BODY_INDENT,
	bodyLines,
	elapsed,
	headerLine,
	headTail,
	muted,
	type RenderCtx,
	reuse,
	statusOf,
	str,
	styleMarkers,
} from "./common.ts";

type AnyDef = ToolDefinition<any, any, any>;
type Factory = (cwd: string, options?: any) => AnyDef;

/** Renderer functions we own; the stacking patch checks membership. */
export const OWN_RENDERERS = new WeakSet<Function>();

const MAX_WRITE_PATCH_CHARS = 200_000;

function toolOptions(pi: ExtensionAPI, name: string): unknown {
	const settings = pi.getSettings() as Record<string, any>;
	if (name === "read") return { autoResizeImages: settings.images?.autoResize ?? true };
	if (name === "bash") return { commandPrefix: settings.shellCommandPrefix, shellPath: settings.shellPath };
	return undefined;
}

function delegating(pi: ExtensionAPI, name: string, factory: Factory): { base: AnyDef; forCwd: (cwd: string) => AnyDef } {
	const cache = new Map<string, AnyDef>();
	const forCwd = (cwd: string) => {
		let def = cache.get(cwd);
		if (!def) {
			def = factory(cwd, toolOptions(pi, name));
			cache.set(cwd, def);
		}
		return def;
	};
	// Settings can't be read while extensions load; options only affect execution,
	// so the registration-time definition is built without them.
	return { base: factory(process.cwd()), forCwd };
}

function errorBody(ctx: RenderCtx, result: { content?: Array<{ type: string; text?: string }> }, width: number, maxLines = 6): string[] {
	const s = store.s;
	const text = textOf(result).trim();
	if (!text) return [];
	const lines = text.split("\n");
	const shown = ctx.expanded ? lines : lines.slice(0, maxLines);
	const out = shown.map((l) => s.fg("error", expandTabs(l)));
	if (shown.length < lines.length) out.push(muted(`${s.glyphs.ellipsis} +${lines.length - shown.length} lines`));
	return bodyLines(out, width, ctx, true);
}

function register(
	pi: ExtensionAPI,
	name: string,
	factory: Factory,
	renderers: {
		renderCall: (args: any, ctx: RenderCtx) => Component;
		renderResult: (result: any, ctx: RenderCtx) => Component;
		wrapExecute?: (
			exec: AnyDef["execute"],
		) => AnyDef["execute"];
	},
): void {
	const { base, forCwd } = delegating(pi, name, factory);
	let execute: AnyDef["execute"] = (id, params, signal, onUpdate, ctx) =>
		forCwd(ctx?.cwd ?? process.cwd()).execute(id, params, signal, onUpdate, ctx);
	if (renderers.wrapExecute) execute = renderers.wrapExecute(execute);
	const renderCall = (args: unknown, _theme: unknown, context: any) => renderers.renderCall(args, context as RenderCtx);
	const renderResult = (result: unknown, _options: unknown, _theme: unknown, context: any) => {
		const ctx = context as RenderCtx;
		ctx.state.status = statusOf(ctx);
		const component = renderers.renderResult(result, ctx);
		// The header renders before the result in the same frame but shows data the
		// result computes (counts, exit codes). Prime the result now so that state
		// exists; at the last known width this also fills its render cache.
		try {
			component.render((ctx.state.lastWidth as number | undefined) ?? 100);
		} catch {
			// rendering errors surface at real render time
		}
		return component;
	};
	OWN_RENDERERS.add(renderCall);
	pi.registerTool({ ...base, renderShell: "self", execute, renderCall, renderResult });
}

// ─── read ────────────────────────────────────────────────────────────────────

function readClassify(path: string): { verb: string; arg: string; token: "path" | "info" } {
	const parts = path.split("/");
	const file = parts[parts.length - 1] ?? path;
	if (file === "SKILL.md") return { verb: "Skill", arg: parts[parts.length - 2] ?? file, token: "info" };
	return { verb: "Read", arg: path, token: "path" };
}

function registerRead(pi: ExtensionAPI): void {
	register(pi, "read", createReadToolDefinition as Factory, {
		renderCall(args, ctx) {
			return reuse(ctx, (width) => {
				const raw = str(args?.path ?? args?.file_path);
				const shown = displayImages(raw);
				const path = shown !== raw ? shown : displayPath(raw, ctx.cwd);
				const cls = readClassify(path);
				let detail = ctx.state.detail as string | undefined;
				if (!detail && (args?.offset != null || args?.limit != null)) {
					const from = Number(args.offset ?? 1);
					detail = muted(`(${from}${args.limit != null ? `–${from + Number(args.limit) - 1}` : "+"})`);
				}
				const { line, animated } = headerLine(width, ctx, { verb: cls.verb, arg: cls.arg, argToken: cls.token, detail });
				return { lines: [line], animated };
			});
		},
		renderResult(result, ctx) {
			return reuse(ctx, (width) => {
				if (ctx.isError) {
					ctx.state.compact = false;
					return { lines: errorBody(ctx, result, width) };
				}
				const hasImage = result?.content?.some((c: { type: string }) => c.type === "image");
				const { body, notice } = splitNotice(textOf(result));
				const rawLines = body === "" ? [] : body.split("\n");
				if (rawLines.length > 1 && rawLines[rawLines.length - 1] === "") rawLines.pop();
				const lines = trimTrailingBlank(rawLines);
				const from = Number(ctx.args && (ctx.args as any).offset) || 1;
				const to = from + rawLines.length - 1;
				const range = notice?.match(/lines (\d+)-(\d+) of (\d+)/);
				const more = notice?.match(/\[(\d+) more lines/);
				if (hasImage) ctx.state.detail = muted("(image)");
				else if (range) ctx.state.detail = muted(`(${range[1]}–${range[2]} of ${range[3]})`);
				else if (more) ctx.state.detail = muted(`(${from}–${to} of ${to + Number(more[1])})`);
				else if (from > 1) ctx.state.detail = muted(`(${from}–${to})`);
				else ctx.state.detail = muted(lines.length === 0 ? "(empty)" : `(${plural(rawLines.length, "line")})`);

				if (!ctx.expanded || hasImage || lines.length === 0) {
					ctx.state.compact = true;
					return { lines: [] };
				}
				ctx.state.compact = false;
				const s = store.s;
				const max = store.config.tools.expandedMaxLines;
				const path = str((ctx.args as any)?.path ?? (ctx.args as any)?.file_path);
				const code = highlightOrPlain(lines.slice(0, max).join("\n"), langFromPath(path), ctx.invalidate);
				const numW = String(from + Math.min(lines.length, max) - 1).length;
				const out = code.map((l, i) =>
					store.config.tools.lineNumbers ? `${s.fg("gutter", String(from + i).padStart(numW))}  ${l}` : l,
				);
				if (lines.length > max) out.push(muted(`${s.glyphs.ellipsis} +${lines.length - max} lines`));
				return { lines: bodyLines(out, width, ctx, true) };
			});
		},
	});
}

// ─── bash ────────────────────────────────────────────────────────────────────

/** The line that says what the command does (skips cd/set/export/comments). */
function operativeCommand(command: string): { line: string; extra: number } {
	const lines = command
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const skip = /^(#|set\s|export\s|cd\s[^&;|]*$|source\s|\.\s)/;
	let line = lines.find((l) => !skip.test(l)) ?? lines[0] ?? "";
	line = line.replace(/^cd\s+[^&;|]+(&&|;)\s*/, "");
	return { line, extra: Math.max(0, lines.length - 1) };
}

function parseBashOutput(text: string): { output: string; exitCode?: number; status?: string; notice?: string } {
	let output = text;
	let exitCode: number | undefined;
	let status: string | undefined;
	const tail = output.match(/(?:^|\n\n)(Command exited with code (\d+)|Command aborted|Command timed out after [\d.]+ seconds|Command terminated without an exit code)\s*$/);
	if (tail) {
		status = tail[1];
		if (tail[2]) exitCode = Number(tail[2]);
		output = output.slice(0, tail.index);
	}
	const { body, notice } = splitNotice(output);
	return { output: body === "(no output)" ? "" : body, exitCode, status, notice };
}

function registerBash(pi: ExtensionAPI): void {
	register(pi, "bash", createBashToolDefinition as Factory, {
		renderCall(args, ctx) {
			return reuse(ctx, (width) => {
				const s = store.s;
				const { line, extra } = operativeCommand(str(args?.command));
				const status = ctx.state.status ?? statusOf(ctx);
				const time = elapsed(ctx);
				// status sits right after the command (not pinned to the far edge)
				let status_ = "";
				if (status === "running") status_ = time ? muted(time) : "";
				else if (status === "done") status_ = `${s.fg("success", s.glyphs.success)}${time ? muted(` ${time}`) : ""}`;
				else if (status === "error") {
					const code = ctx.state.exitCode as number | undefined;
					const label = code !== undefined ? `exit ${code}` : ((ctx.state.bashStatus as string | undefined) ?? "failed");
					status_ = `${s.fg("error", `${s.glyphs.error} ${label}`)}${time ? muted(` ${time}`) : ""}`;
				}
				const extraText = extra > 0 ? muted(`+${extra} lines`) : "";
				const detail = [extraText, status_].filter(Boolean).join("  ") || undefined;
				const argWidth = Math.max(10, width - 14 - (status_ ? 14 : 0) - (extraText ? 10 : 0));
				const { line: header, animated } = headerLine(width, ctx, {
					verb: "Run",
					arg: middleTruncate(line, argWidth),
					argToken: "command",
					detail: detail ? ` ${detail}` : undefined,
				});
				return { lines: [header], animated: animated || status === "running" };
			});
		},
		renderResult(result, ctx) {
			return reuse(ctx, (width) => {
				const s = store.s;
				const parsed = parseBashOutput(textOf(result));
				ctx.state.exitCode = parsed.exitCode;
				ctx.state.bashStatus = parsed.status?.replace(/^Command /, "");
				const all = trimTrailingBlank(expandTabs(parsed.output).split("\n"));
				const lines = all.length === 1 && all[0] === "" ? [] : all;
				const status = ctx.state.status ?? statusOf(ctx);
				if (lines.length === 0) {
					ctx.state.compact = true;
					return { lines: [], animated: status === "running" };
				}
				ctx.state.compact = false;
				const cfg = store.config.tools;
				let shown: string[];
				if (ctx.expanded) shown = lines.slice(-cfg.expandedMaxLines);
				else if (status === "running") shown = lines.slice(-Math.max(1, cfg.bashTail));
				else shown = styleMarkers(headTail(lines, cfg.bashHead, cfg.bashTail).lines);
				const colored = shown.map((l) => (status === "error" && !l.includes("\x1b") ? s.fg("error", l) : l));
				const out = bodyLines(colored, width, ctx, true);
				if (parsed.notice && ctx.expanded) out.push(...bodyLines([s.fg("dim", parsed.notice)], width, ctx));
				return { lines: out, animated: status === "running" };
			});
		},
	});
}

// ─── edit ────────────────────────────────────────────────────────────────────

function diffStats(additions: number, deletions: number): string {
	const s = store.s;
	return `${s.fg("diffAddFg", `+${additions}`)} ${s.fg("diffDelFg", `−${deletions}`)}`;
}

function registerEdit(pi: ExtensionAPI): void {
	register(pi, "edit", createEditToolDefinition as Factory, {
		renderCall(args, ctx) {
			return reuse(ctx, (width) => {
				const path = displayPath(str(args?.path ?? args?.file_path), ctx.cwd);
				const edits = Array.isArray(args?.edits) ? args.edits.length : 0;
				const detail = (ctx.state.detail as string | undefined) ?? (edits > 1 ? muted(`(${edits} edits)`) : undefined);
				const { line, animated } = headerLine(width, ctx, { verb: "Edit", arg: path, detail });
				return { lines: [line], animated };
			});
		},
		renderResult(result, ctx) {
			return reuse(ctx, (width) => {
				if (ctx.isError) {
					ctx.state.compact = false;
					return { lines: errorBody(ctx, result, width) };
				}
				const patch = result?.details?.patch as string | undefined;
				if (!patch) {
					ctx.state.compact = true;
					return { lines: [] };
				}
				const diff = parseUnifiedPatch(patch);
				ctx.state.detail = diffStats(diff.additions, diff.deletions);
				if (!store.config.tools.expandEdits && !ctx.expanded) {
					ctx.state.compact = true;
					return { lines: [] };
				}
				ctx.state.compact = false;
				const path = str((ctx.args as any)?.path ?? (ctx.args as any)?.file_path);
				const lines = renderDiff(diff, {
					width: width - BODY_INDENT,
					lang: langFromPath(path),
					expanded: ctx.expanded,
					onReady: ctx.invalidate,
				});
				return { lines: bodyLines(lines, width, ctx) };
			});
		},
	});
}

// ─── write ───────────────────────────────────────────────────────────────────

interface WriteDetails {
	pmt?: { created: boolean; lines: number; patch?: string };
}

function registerWrite(pi: ExtensionAPI): void {
	register(pi, "write", createWriteToolDefinition as Factory, {
		wrapExecute(exec) {
			return async (id, params: any, signal, onUpdate, ctx) => {
				const cwd = ctx?.cwd ?? process.cwd();
				let path = str(params?.path).replace(/^@/, "");
				if (path === "~" || path.startsWith("~/")) path = homedir() + path.slice(1);
				const abs = isAbsolute(path) ? path : resolve(cwd, path);
				let before: string | undefined;
				try {
					before = await readFile(abs, "utf8");
				} catch {
					before = undefined;
				}
				const result = await exec(id, params, signal, onUpdate, ctx);
				if (!result || (result as any).isError) return result;
				const content = str(params?.content);
				const pmt: WriteDetails["pmt"] = { created: before === undefined, lines: content.split("\n").length };
				if (before !== undefined && before.length + content.length < MAX_WRITE_PATCH_CHARS * 4) {
					const patch = makePatch(path, before, content);
					if (patch.length <= MAX_WRITE_PATCH_CHARS) pmt.patch = patch;
				}
				return { ...result, details: { ...((result.details as object) ?? {}), pmt } };
			};
		},
		renderCall(args, ctx) {
			return reuse(ctx, (width) => {
				const path = displayPath(str(args?.path), ctx.cwd);
				const info = ctx.state.info as WriteDetails["pmt"] | undefined;
				const verb = info ? (info.created ? "Create" : "Write") : "Write";
				const lineCount = str(args?.content).split("\n").length;
				const detail =
					(ctx.state.detail as string | undefined) ??
					(args?.content != null ? muted(`(${plural(lineCount, "line")}${ctx.argsComplete ? "" : "…"})`) : undefined);
				const { line, animated } = headerLine(width, ctx, { verb, arg: path, detail });
				return { lines: [line], animated };
			});
		},
		renderResult(result, ctx) {
			return reuse(ctx, (width) => {
				if (ctx.isError) {
					ctx.state.compact = false;
					return { lines: errorBody(ctx, result, width) };
				}
				const info = (result?.details as WriteDetails | undefined)?.pmt;
				ctx.state.info = info;
				const args = ctx.args as any;
				const path = str(args?.path);
				const content = str(args?.content);
				let diff;
				if (info?.patch) {
					diff = parseUnifiedPatch(info.patch);
					ctx.state.detail = diffStats(diff.additions, diff.deletions);
				} else if (info?.created !== false) {
					const lines = content.split("\n");
					if (lines[lines.length - 1] === "") lines.pop();
					diff = {
						rows: lines.map((text, i) => ({ kind: "add" as const, newNo: i + 1, text: expandTabs(text) })),
						additions: lines.length,
						deletions: 0,
						maxLineNo: lines.length,
					};
					ctx.state.detail = muted(`(${plural(lines.length, "line")})`);
				}
				// Sessions recorded before this package don't say whether the write created
				// the file, so don't paint a possible overwrite as all-new; show it on Ctrl+O.
				const legacy = info === undefined && !ctx.expanded;
				if (!diff || diff.rows.length === 0 || legacy || (!store.config.tools.expandEdits && !ctx.expanded)) {
					ctx.state.compact = true;
					return { lines: [] };
				}
				ctx.state.compact = false;
				const lines = renderDiff(diff, {
					width: width - BODY_INDENT,
					lang: langFromPath(path),
					expanded: ctx.expanded,
					layout: diff.deletions === 0 ? "unified" : undefined,
					onReady: ctx.invalidate,
				});
				return { lines: bodyLines(lines, width, ctx) };
			});
		},
	});
}

// ─── grep / find / ls ────────────────────────────────────────────────────────

function registerGrep(pi: ExtensionAPI): void {
	register(pi, "grep", createGrepToolDefinition as Factory, {
		renderCall(args, ctx) {
			return reuse(ctx, (width) => {
				const s = store.s;
				const where = [args?.glob ? str(args.glob) : "", args?.path ? displayPath(str(args.path), ctx.cwd) : ""].filter(Boolean);
				const scope = where.length ? `${muted("in ")}${s.fg("path", where.join(" in "))}` : "";
				const detail = `${scope}${ctx.state.detail ? ` ${ctx.state.detail}` : ""}`.trim();
				const { line, animated } = headerLine(width, ctx, {
					verb: "Search",
					arg: `"${str(args?.pattern)}"`,
					argToken: "pattern",
					detail: detail || undefined,
				});
				return { lines: [line], animated };
			});
		},
		renderResult(result, ctx) {
			return reuse(ctx, (width) => {
				if (ctx.isError) {
					ctx.state.compact = false;
					return { lines: errorBody(ctx, result, width) };
				}
				const s = store.s;
				const { body, notice } = splitNotice(textOf(result));
				if (/^No matches found/.test(body.trim())) {
					ctx.state.detail = muted("(no matches)");
					ctx.state.compact = true;
					return { lines: [] };
				}
				const groups = new Map<string, Array<{ ln: string; text: string; match: boolean }>>();
				let matches = 0;
				for (const raw of body.split("\n")) {
					const hit = raw.match(/^(.+?):(\d+): (.*)$/);
					const ctxLine = raw.match(/^(.+?)-(\d+)- (.*)$/);
					const m = hit && ctxLine ? (hit[1]!.length <= ctxLine[1]!.length ? hit : ctxLine) : (hit ?? ctxLine);
					if (!m) continue;
					const isMatch = m === hit;
					if (isMatch) matches++;
					if (!groups.has(m[1]!)) groups.set(m[1]!, []);
					groups.get(m[1]!)!.push({ ln: m[2]!, text: expandTabs(m[3]!), match: isMatch });
				}
				ctx.state.detail = muted(`(${plural(matches, "match", "matches")} in ${plural(groups.size, "file")}${notice ? ", truncated" : ""})`);
				if (!ctx.expanded) {
					ctx.state.compact = true;
					return { lines: [] };
				}
				ctx.state.compact = false;
				const out: string[] = [];
				for (const [file, hits] of groups) {
					out.push(s.fg("path", file));
					for (const h of hits) out.push(`${s.fg("gutter", h.ln.padStart(5))}  ${h.match ? h.text : s.fg("muted", h.text)}`);
				}
				return { lines: bodyLines(out.slice(0, store.config.tools.expandedMaxLines), width, ctx, true) };
			});
		},
	});
}

function listResult(kind: "find" | "ls") {
	return (result: any, ctx: RenderCtx) =>
		reuse(ctx, (width) => {
			if (ctx.isError) {
				ctx.state.compact = false;
				return { lines: errorBody(ctx, result, width) };
			}
			const s = store.s;
			const { body, notice } = splitNotice(textOf(result));
			const empty = /^(No files found|\(empty directory\))/.test(body.trim());
			const entries = empty ? [] : body.split("\n").filter((l) => l.trim());
			const noun = kind === "ls" ? "entry" : "file";
			ctx.state.detail = muted(`(${empty ? (kind === "ls" ? "empty" : "no files") : plural(entries.length, noun, kind === "ls" ? "entries" : "files")}${notice ? ", truncated" : ""})`);
			if (!ctx.expanded || entries.length === 0) {
				ctx.state.compact = true;
				return { lines: [] };
			}
			ctx.state.compact = false;
			const out = entries
				.slice(0, store.config.tools.expandedMaxLines)
				.map((e) => (e.endsWith("/") ? s.fg("info", e) : s.fg("textSecondary", e)));
			return { lines: bodyLines(out, width, ctx, true) };
		});
}

function registerFind(pi: ExtensionAPI): void {
	register(pi, "find", createFindToolDefinition as Factory, {
		renderCall(args, ctx) {
			return reuse(ctx, (width) => {
				const s = store.s;
				const scope = args?.path ? `${muted("in ")}${s.fg("path", displayPath(str(args.path), ctx.cwd))}` : "";
				const detail = [scope, ctx.state.detail as string | undefined].filter(Boolean).join(" ");
				const { line, animated } = headerLine(width, ctx, { verb: "Find", arg: str(args?.pattern), argToken: "pattern", detail: detail || undefined });
				return { lines: [line], animated };
			});
		},
		renderResult: listResult("find"),
	});
}

function registerLs(pi: ExtensionAPI): void {
	register(pi, "ls", createLsToolDefinition as Factory, {
		renderCall(args, ctx) {
			return reuse(ctx, (width) => {
				const path = args?.path ? displayPath(str(args.path), ctx.cwd) : ".";
				const { line, animated } = headerLine(width, ctx, { verb: "List", arg: path, detail: ctx.state.detail as string | undefined });
				return { lines: [line], animated };
			});
		},
		renderResult: listResult("ls"),
	});
}

export function registerTools(pi: ExtensionAPI): void {
	registerRead(pi);
	registerBash(pi);
	registerEdit(pi);
	registerWrite(pi);
	registerGrep(pi);
	registerFind(pi);
	registerLs(pi);
}
