# markdown-reviewer (`mdr`)

A browser-based markdown annotation tool. Open a `.md` file, click blocks to add comments, hit **Done**, and get a `.mdr` file with inline review markers — structured feedback an LLM agent can read and act on.

```
mdr proposal.md
→ browser opens → click blocks → add comments → Done → proposal.mdr
```

## Usage

```bash
mdr <path-to-markdown> [options]
```

Start reviewing a markdown file. Click relative `.md` links in the rendered document to navigate to
related files and annotate them in the same session. Reviewed output is written next to each source
as `<name>.mdr`.

### Options
- `--port <n>` — Port for the local server (default: auto-select)
- `--tmp-dir <dir>` — Annotation session storage root
- `--no-open` — Don't auto-open the browser
- `--lan` — Expose the full review session on your local network, print the LAN URL, and show a QR code for phone/tablet access. Devices that can reach it can view the session, change annotations, and regenerate `.mdr` files. This is opt-in, implies `--no-open`, and default runs are localhost-only.
- `--host <host>` — Public LAN URL host for `--lan` QR codes, useful when a DNS name points at your machine
- `--fresh` — Discard existing session, start clean
- `--auto-discover` — Crawl the relative-`.md` link graph from the entry file and map the whole cluster into the session up front
- `--pi <port>` — Enable pi integration mode. Injects a "Send to pi" button in the review terminal that POSTs the review prompt to a pi callback server on the given port. Use with `--lan --no-open` for the [pi extension](#agent-harness-integrations).
- `--cleanup <file>` — Remove session artifacts for a single file (`.mdr` file, annotation directory, and manifest entry). Use after all annotations have been applied.

### Configuration file

Set persistent defaults in an env-style file so you don't have to retype flags on every run:
- **Unix:** `~/.config/mdr/config.env` (or `$XDG_CONFIG_HOME/mdr/config.env`)
- **Windows:** `%APPDATA%/markdown-review/config.env`

```sh
# ~/.config/mdr/config.env
MDR_LAN=1
MDR_PORT=7000
MDR_HOST=your-host.local
```

Supported keys: `MDR_PORT`, `MDR_HOST`, `MDR_LAN`, `MDR_TMP_DIR`, `MDR_NO_OPEN`,
`MDR_AUTO_DISCOVER`. Precedence, low to high: **config file < `MDR_*` environment variables < CLI
flags** — so an explicit flag (e.g. `--port 8000`) always wins over the file.

`MDR_HOST` only takes effect when LAN mode is enabled (`MDR_LAN=1` or `--lan`); set on its own it is
ignored with a warning.

## How it works

1. **CLI** — `mdr file.md` starts a local Bun HTTP server and opens your browser.
2. **Server** — Parses the markdown into annotatable blocks (headings, paragraphs, list items, code blocks, blockquotes, table cells) and serves a single-page view.
3. **Browser** — Click any block to add or edit a comment. The sidebar shows all active and orphaned annotations.
4. **Done** — The server regenerates all `.mdr` files and shows a terminal with the reviewed file paths. The server stays alive and shuts down after 30 minutes without a browser heartbeat.

Annotations persist as JSON files and **auto-resume** on re-run. Blocks are matched by content hash (not line numbers), so annotations survive reordering and unrelated edits. `.mdr` files are regenerated after every annotation save or delete — they always reflect the current state.

## Server API

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/api/markdown` | `{ source, blocks }` |
| `GET` | `/api/annotations` | `{ annotations }` |
| `POST` | `/api/annotations` | `{ annotation }` (201 create / 200 update) |
| `DELETE` | `/api/annotations/:id` | `{ ok }` or 404 |
| `POST` | `/api/done` | `{ ok, path }` or `{ ok: false, error }` |

## Output format

Each annotated file generates a `.mdr` file alongside the original (e.g., `spec.md` → `spec.mdr`). The `.mdr` file contains:

1. **AGENT PROTOCOL block** — an HTML comment at the top with authoritative instructions for an agent applying the review (triage, consistency, preservation rules, cleanup).
2. **Summary section** — numbered annotations with block type, line range, and comment text. Orphaned annotations (blocks that were deleted) are listed separately.
3. **Thematic break** separator.
4. **Full original source** with inline `<!-- Review: [N] comment -->` markers spliced at each annotated block's position.

The original formatting is preserved byte-for-byte — markers are inserted into the source string, never re-serialized from an AST.

## Install

**Prerequisite:** [Bun](https://bun.sh) (v1.0+)

**macOS / Linux:**

```bash
curl -fsSL https://bun.sh/install | bash
```

**Windows (PowerShell):**

```bash
powershell -c "irm https://bun.sh/install.ps1 | iex"
```

**Windows (winget):**

```bash
winget install oven-sh.Bun
```

```sh
git clone <repo>
cd markdown-reviewer
bun install
```

Run against a file:

```sh
bun run start path/to/doc.md
```

Or install globally. `bun install -g .` is [broken](https://github.com/oven-sh/bun/issues) — use one of these instead:

**Option 1:** `bun link` (re-run after code changes to update the binary)

```sh
bun link
mdr path/to/doc.md
```

**Option 2:** `bun install -g` with an absolute path

```sh
bun install -g /path/to/markdown-reviewer
mdr path/to/doc.md
```

## Development

```sh
bun run dev path/to/doc.md    # watch mode
bun run typecheck             # TypeScript check
bun test                      # run tests
```

## Project structure

```
src/
├── cli/
│   └── index.ts                # CLI entry: arg parsing, server launch, signal handling, LAN/QR
├── frontend/
│   ├── app.js                  # vanilla JS frontend (IIFE, no build step)
│   └── page.html               # server-rendered HTML page template
├── review/
│   ├── generator.ts            # review generator: AGENT PROTOCOL + summary + inline marker splicing
│   └── generator.test.ts
├── server/
│   ├── index.ts                # Bun HTTP server, all API routes, static serving, heartbeat
│   ├── index.test.ts
│   ├── integration-routes.test.ts  # integration tests for multi-file routes
│   ├── markdown-service.ts     # parseDocument / loadDocument (remark pipeline + link detection)
│   ├── markdown-service.test.ts
│   ├── anchoring.ts            # computeAnchor, relocate (four-tier matcher), serializeAnchor
│   ├── anchoring.test.ts
│   ├── annotation-service.ts   # JSON file persistence, session lock (PID-based), CRUD
│   ├── annotation-service.test.ts
│   ├── file-store.ts           # in-memory registry of loaded files (FileStore class)
│   ├── file-crawler.ts         # cycle-safe BFS auto-discover of relative .md link graph
│   ├── file-crawler.test.ts
│   ├── session-manifest.ts     # session manifest CRUD, .session/.path markers, session merge
│   ├── session-manifest.test.ts
│   ├── manifest-mutex.ts       # async FIFO mutex to serialize manifest read-modify-write
│   └── manifest-mutex.test.ts
├── shared/
│   └── types.ts                # BlockAnchor, BlockNode, Annotation, AnnotationStatus, FileKey, MdLink
└── types/
    └── qrcode-terminal.d.ts    # type declaration for qrcode-terminal
```

## Agent harness integrations

### pi

The [pi](https://github.com/earendil-works/pi-coding-agent) extension (`~/.pi/agent/extensions/mdr.ts`) provides a browser-based annotation workflow that feeds reviews directly into your pi conversation.

**Commands:**

| Command | Action |
|---------|--------|
| `/mdr file.md` | Start a review session — opens your browser on the LAN URL |
| `/mdr kill` | Stop the current review (kills mdr + callback server) |
| `/mdr clean` | Delete all session data |

**Workflow:**

1. Run `/mdr path/to/file.md` in pi
2. Annotate blocks in your browser
3. Click **Done**, then **Send to pi** — the review prompt is injected into your conversation
4. Ask pi to apply the review — it reads the `.mdr` file and edits your source
5. When all annotations are applied, pi runs `mdr --cleanup` to remove session artifacts

The extension is maintained in `~/.pi/agent/extensions/mdr.ts` — not bundled in this repo.
