# pi-minimal-tui

A clean, minimal TUI for [pi](https://github.com/earendil-works/pi): Grok Build's layout with Claude Code's ergonomics. Everything is themeable.

```
╭──────────────────────────────────────────────────────────── 8:19 PM ─╮
│ ❯ add validation to the checkout flow [Image #1]                      │
╰───────────────────────────────────────────────────────────────────────╯

  ∴ Thought for 2.0s

  ◆ Read checkout.ts (1–120 of 240)

  ◆ Edit src/api/checkout.ts +4 −1
      43    const total = sum(cart.items);                ← red band, word-level highlight
      43    const total = calculateTotal(cart.items);     ← green band
      44    if (total <= 0) {

  ◆ Run npm test  ✓ 4.2s
    └ PASS src/api/checkout.test.ts
      … +38 lines (ctrl+o to expand)

  ◆ Added a guard so empty carts can't be charged.

 ⠋ Responding…                                          17s ⇣9.45k  esc:stop

╭─ ~/D/mine · main ─────────────────────────────────────── 9.5K / 500K ─╮
│                                                                       │
│  ❯ Build anything                                                     │
│                                                                       │
╰──────────────────────────────────────────────── gpt-6.1-sol (high) ──╯
```

## What you get

- **Even rhythm**: every block (reply, thinking, tool) gets a `◆` in the same column. Blocks are separated by one blank line, and tool output hangs off a `└` at a single shared indent. Nothing is italic.
- **Grouped reads**: runs of finished Read/Search/Find/List rows fold into one line, `● Read 3 files, searched 2 patterns`, like Claude Code. Ctrl+O shows them individually.
- **Tools**: all 7 built-ins (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) render as one-line `◆ Verb arg (detail)` rows. Execution is pi's own, so the tool schemas and behaviour are unchanged.
- **Diffs**: Shiki-highlighted, with line numbers and full-width add/remove bands. Matching old/new lines get word-level highlights. Layouts are **unified** and **split**; `auto` picks split on wide terminals when both sides changed.
- **Bash**: the real exit code (`✓ 4.2s` / `✗ exit 1`), first and last lines of output (errors are at the end), and a live tail while running.
- **Your messages**: prompts, skill invocations and `!commands` sit in rounded boxes like the input box, with the timestamp in the border. Set `messages.userStyle` to `"band"` or `"plain"` to change this.
- **Pasted images**: they show as `[Image #1]` in the input, the chat and Read rows. The model still gets the real file path.
- **Thinking**: one quiet dim line, `∴ Thought for 2.0s`, like Claude Code. Timing comes from the stream and is kept across `/resume`. While streaming it shows `∴ Thinking…` with a faint live preview. Ctrl+T or a click expands it to plain dim text.
- **Chrome**: the input box carries cwd, branch, a context gauge (yellow at 75%, red at 95%) and model plus thinking level in its borders. The working row shows the current phase (Thinking / Responding / Running *cmd*), elapsed time and output tokens, then `✻ Worked for …` after the turn. There is no footer by default; set `chrome.footer: true` for key hints, and `chrome.showStatuses: true` to show other extensions' statuses. The terminal title reads `⠋ Responding - <session> - pi`.
- **Subagent dock**: running and finished agents from pi-subagents' lifecycle events.

## Install

```bash
pi install npm:pi-minimal-tui          # or, from a checkout: pi install /path/to/pi-minimal-tui
```

Remove other packages that re-render the built-in tools, such as `pi-claude-code-ui`, `pi-tool-display` and `pi-pretty`. For pi, the first registration of a tool name wins.

Recommended in `~/.pi/agent/settings.json`: `"hideThinkingBlock": true`, so thinking starts collapsed.

## Customise

`/tui` opens a menu. Subcommands:

| Command | Effect |
|---|---|
| `/tui theme <name>` | Switch skin: `claudecode` (Claude Code's own look), `groknight`, `grokday`, `claude`, `auto`, or your own |
| `/tui shiki <name\|path>` | Code theme: any bundled Shiki theme, or a path to a VS Code / TextMate theme JSON |
| `/tui diff auto\|unified\|split` | Diff layout |
| `/tui timestamps on\|off` | Timestamps on prompts and replies |
| `/tui reload` | Re-read config and skins |
| `/tui paths` | Show where config and skins live |

### Config

`~/.pi/agent/pi-minimal-tui.json`. A project file at `<project>/.pi/pi-minimal-tui.json` overrides it. Every key is optional; the defaults are:

```jsonc
{
  "theme": "groknight",          // skin
  "applyPiTheme": true,          // also switch pi's theme to the skin's piTheme
  "colors": {},                  // per-token overrides, e.g. { "accent": "#ff79c6" }
  "glyphs": {},                  // e.g. { "bullet": "●", "prompt": ">", "spinner": ["|","/","-","\\"] }
  "shiki": { "theme": "", "lightTheme": "", "maxChars": 32000, "cacheSize": 128, "fixContrast": true },
  "diff": { "layout": "auto", "splitMinWidth": 150, "splitMinCodeWidth": 60, "wordDiff": true, "maxLines": 60, "maxWrapRows": 3 },
  "tools": { "expandEdits": true, "bashHead": 2, "bashTail": 3, "expandedMaxLines": 4000, "lineNumbers": true },
  "messages": { "timestamps": true, "replyTimestamps": false, "timeFormat": "12h", "collapseUserAfter": 0, "userStyle": "box" },
  "thinking": { "showDuration": true, "streamPreviewLines": 3 },
  "chrome": {
    "editor": true, "editorPaddingY": 0,
    "caret": "bar", "caretBlink": true, "caretAccent": true,   // "bar" | "underline" | "block" (pi's painted block)
    "workingRow": true, "footer": false, "title": true, "header": true,
    "placeholder": "Build anything",
    "hints": [["Shift+Tab", "thinking"], ["Esc", "stop"], ["Ctrl+o", "expand"], ["Ctrl+t", "thoughts"]],
    "showStatuses": false
  },
  "subagents": { "dock": true, "maxRows": 8, "lingerMs": 4000 },
  "layout": { "groupTools": true, "stackRows": false },          // true = Grok-style stacked one-line rows
  "animation": { "intervalMs": 100 }
}
```

### Custom skins

Drop a JSON file in `~/.pi/agent/pi-minimal-tui/skins/<name>.json`, then run `/tui theme <name>`. Any token you leave out falls back to the active pi theme, so a skin can be as small as:

```json
{ "name": "mine", "colors": { "accent": "#ff79c6", "path": "#8be9fd", "band": "#282a36" } }
```

Each colour value can be:
- `#hex`, `oklch()`, `okhsl()`, or a 0–255 index;
- another token's name (`"running": "accent"`);
- `"pi:<token>"` to borrow a colour from the active pi theme (`"band": "pi:userMessageBg"`).

The full form: `{ name, appearance: "dark"|"light", piTheme?, shiki?, colors, glyphs, style?: { codeBold } }`. See `skins/claudecode.json` for a complete example.

**Tokens**

| Group | Tokens |
|---|---|
| Surfaces | `band`, `panel` |
| Text | `text`, `textSecondary`, `muted`, `dim`, `timestamp` |
| Accents | `accent`, `toolBullet`, `replyBullet`, `prompt`, `thinking`, `running`, `model` |
| Tool arguments | `path`, `pattern`, `command` |
| Status | `success`, `error`, `warning`, `info` |
| Borders | `border`, `borderActive`, `borderBash` |
| Diff | `diffAddBg`, `diffDelBg`, `diffAddWordBg`, `diffDelWordBg`, `diffAddFg`, `diffDelFg`, `diffContextFg`, `gutter`, `stripe` |
| Markdown | `h1`–`h4`, `code`, `link`, `bullet` |

If you leave out the diff backgrounds, they are mixed from the diff foregrounds and `panel`.

**Glyphs**: `prompt`, `bullet`, `thinking`, `listBullet`, `bulletHollow`, `group`, `rail`, `success`, `error`, `ellipsis`, `tokens`, `sep`, `stripe`, `expand`, `collapse`, `spinner[]`, `agentSpinner[]`, `border{tl,tr,bl,br,h,v}`.

The pi themes `claudecode`, `groknight` and `grokday` ship in `themes/`. Pick them in `/settings` or let a skin's `piTheme` apply them.

### Custom code themes

```bash
/tui shiki dracula                          # any bundled Shiki theme
/tui shiki ~/themes/my-theme.json           # a VS Code / TextMate theme file
```

Dark and light are separate (`shiki.theme` and `shiki.lightTheme`), so switching between a dark and a light skin keeps the right code theme for each.

## How it works

Most of it uses pi's supported extension API: `registerTool` with `renderShell: "self"`, `setEditorComponent`, `setWidget`, `setFooter`, `setHeader`, `setTitle`, `setWorkingVisible` and `registerCommand`.

Pi has no API for a few things, which are small, guarded prototype patches in `src/messages/patches.ts`:
- boxed prompts, skills and `!commands`;
- "Thought for Xs" and bulleted replies;
- optional row stacking.

Each patch checks that the method exists, and falls back to pi's own rendering on any error. All of them are removed on session shutdown. If a pi update changes these internals, you get a warning and stock rendering for that one part; nothing breaks.

Message content is never changed. Thinking durations live in a hidden custom session entry (`pi-minimal-tui:thinking`).

## Development

```bash
npm install
npm run typecheck
npx tsx --tsconfig scripts/tsconfig.json scripts/harness.ts 120 /tmp/out.ansi   # render every component against real pi classes
pi -e ./src/index.ts                                                           # try it without installing; /reload after edits
```
