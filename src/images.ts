/**
 * Pasted images show as "[Image #1]" instead of a temp-file path.
 *
 * pi pastes a clipboard image by saving it to a temp file and inserting the path
 * into the prompt; the model then reads that path. We insert a token in the
 * editor instead, swap the real path back in when the prompt is submitted, and
 * display tokens wherever such paths appear (prompts, Read rows).
 */
import { isAbsolute } from "node:path";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif|tiff?|avif)$/i;
const CLIPBOARD_PATH = /(?:\/[^\s"'`]+)?\/pi-clipboard-[0-9a-f-]+\.[a-z0-9]+/gi;
const TOKEN = /\[Image #(\d+)\]/g;

const numberByPath = new Map<string, number>();
const pathByNumber = new Map<number, string>();
let next = 1;

export function isImagePath(path: string): boolean {
	return isAbsolute(path) && IMAGE_EXT.test(path);
}

export function imageToken(path: string): string {
	let n = numberByPath.get(path);
	if (n === undefined) {
		n = next++;
		numberByPath.set(path, n);
		pathByNumber.set(n, path);
	}
	return `[Image #${n}]`;
}

/** Unquote / unescape a path as terminals paste it on drag-and-drop. */
function cleanPath(raw: string): string {
	let p = raw.trim();
	if ((p.startsWith("'") && p.endsWith("'")) || (p.startsWith('"') && p.endsWith('"'))) p = p.slice(1, -1);
	return p.replace(/\\ /g, " ");
}

/**
 * Turn pasted text into tokens when every non-empty line is an image path;
 * otherwise return it unchanged.
 */
export function tokenizePaste(text: string): string | undefined {
	const parts = text
		.split("\n")
		.map(cleanPath)
		.filter(Boolean);
	if (parts.length === 0 || !parts.every(isImagePath)) return undefined;
	return parts.map(imageToken).join(" ");
}

/** Replace known tokens with their paths (on submit). */
export function expandTokens(text: string): string {
	return text.replace(TOKEN, (match, n: string) => pathByNumber.get(Number(n)) ?? match);
}

export function hasTokens(text: string): boolean {
	TOKEN.lastIndex = 0;
	const found = TOKEN.test(text);
	TOKEN.lastIndex = 0;
	return found;
}

/** Matches both chip kinds: "[Image #2]" and pi's "[paste #1 +42 lines]" / "[Pasted text #1 +42 lines]". */
export const CHIP = /\[(?:Image #\d+|paste #\d+(?: (?:\+\d+ lines|\d+ chars))?|Pasted text #\d+(?: (?:\+\d+ lines|\d+ chars))?)\]/g;

/** Large pastes, remembered at submit so the sent message shows a chip, not the wall of text. */
const pasteLabels = new Map<string, string>();

export function rememberPaste(id: number, content: string): void {
	const key = content.trim();
	if (key.length < 200) return;
	const lines = key.split("\n").length;
	pasteLabels.set(key, `[Pasted text #${id} ${lines > 10 ? `+${lines} lines` : `${key.length} chars`}]`);
}

/** Display form: image paths and large pasted blocks become chips. */
export function displayImages(text: string): string {
	let out = text.replace(CLIPBOARD_PATH, (path) => imageToken(path));
	for (const [path] of numberByPath) {
		if (out.includes(path)) out = out.split(path).join(imageToken(path));
	}
	for (const [content, label] of pasteLabels) {
		if (out.includes(content)) out = out.split(content).join(label);
	}
	return out;
}

/** Spans of image tokens in a line (for atomic cursor/delete handling). */
export function imageTokenSpans(text: string): Array<{ start: number; end: number }> {
	const spans: Array<{ start: number; end: number }> = [];
	for (const m of text.matchAll(/\[Image #\d+\]/g)) spans.push({ start: m.index!, end: m.index! + m[0].length });
	return spans;
}
