# AGENTS.md — markdown-reviewer

## What it is

A browser-based markdown annotation tool. Run `mdr file.md`, click blocks in the browser to add comments, hit **Done**, and get a `.mdr` file with inline review markers and an AGENT PROTOCOL block. Designed so an LLM agent can read the output and act on the feedback.

## Toolchain

- **Bun only** — runtime, HTTP server, package manager, test runner.
- **ESM-only remark v11 stack** — `unified`, `remark-parse`, `remark-gfm`, `remark-frontmatter`, `remark-rehype`, `hast-util-to-html`, `mdast-util-to-string`, `unist-util-visit`.
- **QR codes** — `qrcode-terminal` for LAN mode sharing.
- **Fonts** - all self-hosted from `public/fonts` (served via `/static/fonts`), no external/Google requests: IBM Plex Sans Condensed (titles/headings), IBM Plex Sans (body/UI), and MesloLGM Nerd Font Mono Regular (inline code, code blocks, and `<pre>`). These are the only three typefaces used by the app. The IBM Plex woff2s are latin/latin-ext subsets declared with `unicode-range` + `font-display: swap` in `page.html` (no preloads — on a throttled connection they steal critical bandwidth and `swap` already paints a fallback). The served Meslo `woff2` is a **subset** of the full Nerd Font (the upstream is ~1.25 MB because of thousands of private-use icon glyphs that code never uses; subsetting drops it to ~66 KB). The full `MesloLGMNerdFontMono-Regular.ttf` is kept in `public/fonts` as the regeneration source — it is not referenced at runtime. To regenerate the subset after a font update: `pyftsubset MesloLGMNerdFontMono-Regular.ttf --unicodes="U+0000-00FF,U+0100-017F,U+2000-206F,U+2070-209F,U+20A0-20BF,U+2100-214F,U+2190-21FF,U+2200-22FF,U+2300-23FF,U+2500-257F,U+2580-259F,U+25A0-25FF,U+2600-26FF" --layout-features='*' --flavor=woff2 --output-file=MesloLGMNerdFontMono-Regular.woff2` (glyphs outside these ranges fall back per-glyph to the system mono in the stack). Do **not** gzip woff2 responses — woff2 is already Brotli-compressed internally (gzip saves <1%). The `GET /` page and `GET /app.js` responses are pre-gzipped once at startup (`Bun.gzipSync`) and served with `Content-Encoding: gzip` when the client accepts it; `/app.js` is loaded with `defer`.
- **TypeScript** — strict, no emit (`module: esnext`, `moduleResolution: bundler`, `verbatimModuleSyntax`, `noEmit`).
- **No build step** — the server renders HTML via `remark-rehype` → `hast-util-to-html`; the review generator splices markers directly into the original source string.

## Commands

```sh
bun install              # install dependencies
bun run typecheck        # tsc --noEmit (must pass clean)
bun test                 # run all tests (must be green)
bun run start <file>     # start the tool against a markdown file
bun run dev <file>       # start with --watch for dev iteration
```

## Nix / NixOS integration

- Keep the flake working whenever dependencies, runtime files, or packaging inputs change. If `package.json`, `bun.lock`, `bunfig.toml`, `flake.nix`, `src/`, or `public/` changes in a way that affects the packaged app, run or explicitly account for `nix build .#markdown-reviewer` and `nix flake check`.
- The `node_modules` derivation in `flake.nix` is fixed-output. After dependency changes, update its `outputHash` so the packaged `mdr` can resolve every runtime import.

## User preferences

- The user prefers to do hands-on UI testing themselves. For UI changes, keep automated/end-to-end browser verification light unless explicitly requested; share the local URL or changed files so the user can quickly test and give feedback.

## Project structure

```
src/
├── cli/
│   └── index.ts               # CLI entry: arg parsing, server launch, signal handling, LAN/QR
├── frontend/
│   ├── app.js                 # vanilla JS frontend (IIFE, no build step)
│   └── page.html              # server-rendered HTML page template
├── review/
│   ├── generator.ts           # review generator: AGENT PROTOCOL + summary + inline marker splicing
│   └── generator.test.ts
├── server/
│   ├── index.ts               # Bun HTTP server, all API routes, static serving, heartbeat
│   ├── index.test.ts
│   ├── integration-routes.test.ts  # integration tests for multi-file routes
│   ├── markdown-service.ts    # parseDocument / loadDocument (remark pipeline + link detection)
│   ├── markdown-service.test.ts
│   ├── anchoring.ts           # computeAnchor, relocate (four-tier matcher), serializeAnchor
│   ├── anchoring.test.ts
│   ├── annotation-service.ts  # JSON file persistence, session lock (PID-based), CRUD
│   ├── annotation-service.test.ts
│   ├── file-store.ts          # in-memory registry of loaded files (FileStore class)
│   ├── file-crawler.ts        # cycle-safe BFS auto-discover of relative .md link graph
│   ├── file-crawler.test.ts
│   ├── session-manifest.ts    # session manifest CRUD, .session/.path markers, session merge
│   ├── session-manifest.test.ts
│   └── manifest-mutex.ts      # async FIFO mutex to serialize manifest read-modify-write
│   └── manifest-mutex.test.ts
├── shared/
│   └── types.ts               # BlockAnchor, BlockNode, Annotation, AnnotationStatus, FileKey, MdLink
└── types/
    └── qrcode-terminal.d.ts   # type declaration for qrcode-terminal
```

## Server API routes

### Multi-file routes (file-scoped)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/files` | List loaded files + active key → `{ files, activeKey }` |
| GET | `/api/session-files` | Manifest-backed session file list → `{ files }` (with `discovering` flag during auto-discover) |
| GET | `/api/files/:key` | Load file on-demand (parse, session merge, lock) → `{ source, blocks, fullHtml, links, fileName, key, annotationCount }` |
| GET | `/api/files/:key/annotations` | File-scoped annotations with relocation → `{ annotations }` |
| POST | `/api/files/:key/annotations` | Create/update annotation → `{ annotation }` (201/200); triggers `.mdr` regeneration |
| DELETE | `/api/files/:key/annotations/:id` | Remove annotation → `{ ok }` or 404; triggers `.mdr` regeneration |

### Backward-compatible routes (delegate to entry file)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Prerendered HTML page with injected block HTML |
| GET | `/app.js` | Frontend JavaScript |
| GET | `/static/*` | Static assets from `public/` |
| GET | `/api/markdown` | `{ source, blocks }` — delegates to entry file |
| GET | `/api/annotations` | `{ annotations }` — delegates to entry file |
| POST | `/api/annotations` | Create/update annotation → delegates to entry file |
| DELETE | `/api/annotations/:id` | Remove annotation → delegates to entry file |

### Lifecycle / utility routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ping` | Heartbeat ping — resets server inactivity timer → `{ ok }` |
| GET | `/api/reviewed-files` | Files with annotations → `{ files: [{ key, reviewedPath, sourcePath, annotationCount }] }` |
| POST | `/api/done` | Regenerate entry `.mdr` → `{ ok, path }` or `{ ok: false, error }` (non-terminating) |

## CLI flags

`mdr <file> [options]`

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | auto (0) | Port for the local server |
| `--tmp-dir <dir>` | `/tmp/markdown-review` | Root for annotation session storage |
| `--no-open` | false | Don't auto-open the browser |
| `--lan` | false | Expose the server on the local network and print a QR code; implies `--no-open` |
| `--host <host>` | detected IPv4 | Public LAN URL host for `--lan` QR codes (requires `--lan`) |
| `--fresh` | false | Discard existing session, start clean |
| `--auto-discover` | false | Eagerly crawl the relative-`.md` link graph and add reachable files to session |
| `--clean` | false | Delete all session data (manifests, markers, annotations) and exit |
| `-h, --help` | — | Show help |

## Config file

Persistent defaults can be set in an env-style file at `$XDG_CONFIG_HOME/mdr/config.env`
(default `~/.config/mdr/config.env`). Format is `KEY=value`, with `#` comments and blank lines
ignored and optional surrounding quotes stripped. Supported keys: `MDR_PORT`, `MDR_HOST`,
`MDR_LAN`, `MDR_TMP_DIR`, `MDR_NO_OPEN`, `MDR_AUTO_DISCOVER` (the destructive/transient
`--fresh`, `--clean`, `--help` are intentionally not configurable). Precedence, low to high:
**hardcoded defaults < config file < `MDR_*` environment variables < CLI flags**. Parsing lives in
`loadConfigEnv` / `resolveConfigDefaults` in `src/cli/index.ts`, feeding `parseArgs`'s defaults.

## Load-bearing invariants

These must not be accidentally broken:

1. **Composite anchor** — `blockType:textHash:siblingOrdinal`. The `textHash` is an FNV-1a hash of the block's *own* inline text (not nested children), normalized (whitespace collapsed, headings lowercased). The `siblingOrdinal` is the index within the *immediate* parent container (from `unist-util-visit`). Line numbers are advisory only — never used for relocation.

2. **Source fidelity** — the review generator splices HTML comment markers into the *original source string* at `endOffset` positions. It never re-serializes the AST. This preserves the author's exact formatting.

3. **Comment sanitization** — `sanitizeComment()` replaces `--` with `- -` so that `-->` can never appear inside a comment body and prematurely terminate the HTML comment. Markers are placed *after* closing code fences (at `endOffset`, which points past the fence).

4. **Skipped node types** — frontmatter (`yaml`, `toml`), thematic breaks (`thematicBreak`), and raw HTML (`html`) are never annotated. List items anchor on `listItem` nodes (not `<p>` children), and paragraphs that are direct children of `listItem`/`blockquote` containers are skipped to avoid double-anchoring.

5. **Four-tier relocation** — `relocate()` matches annotations to blocks in priority order:
   - **Tier 1**: Exact composite match (`blockType:textHash:siblingOrdinal`) → `ok`
   - **Tier 2**: Content match, different position (`blockType:textHash`) → `ok`, rebind ordinal
   - **Tier 3**: Position match, content changed (`blockType:siblingOrdinal`) → `stale`
   - **Tier 4**: No match → `orphaned`
   - One-block-one-claim: each block can only be bound to one annotation.

6. **Manifest mutex** — all session manifest read-modify-write sequences are serialized through an async FIFO mutex (`manifest-mutex.ts`). This prevents the background auto-discover crawl and request handlers from interleaving at `await` boundaries and losing each other's updates.

7. **Session merge determinism** — when two sessions are merged (via file navigation or auto-discover), the older session survives (`createdAt` tie-broken by lexicographic session id). The absorbed manifest is deleted. A file is never in two sessions simultaneously.

8. **Atomic file writes** — annotation JSON files, session manifests, and `.mdr` output all use temp-file + rename for atomic writes to avoid corrupt partial output on crash.

## Output format

Each annotated file generates a `.mdr` file alongside the original (e.g., `spec.md` → `spec.mdr`). The `.mdr` is regenerated on every annotation save or delete, so it is always current.

The `.mdr` file contains:

1. **AGENT PROTOCOL block** — an HTML comment at the top with authoritative instructions for an agent applying the review. It covers triage (APPLY vs ASK), consistency across files, preservation rules, per-file reporting, and cleanup (delete `.mdr` after applying). The "Copy prompt" in the Done modal defers to this block.

2. **Summary section** — `# Review of {filename}` with total annotation count, numbered annotations (block type, line range, comment), and a separate "Unresolved / orphaned annotations" section.

3. **Thematic break** separator (`---`).

4. **Full original source** with inline `<!-- Review: [N] comment -->` markers spliced at each annotated block's position.

The original formatting is preserved byte-for-byte — markers are inserted into the source string, never re-serialized from an AST.

## How it works (user flow)

1. **CLI** — `mdr file.md` starts a local Bun HTTP server and opens the browser.
2. **Server** — Parses the markdown into annotatable blocks (headings, paragraphs, list items, code blocks, blockquotes, table cells), detects relative `.md` links, and serves a single-page view.
3. **Browser** — Click any block to add or edit a comment. The sidebar shows all active and orphaned annotations. Relative `.md` links are clickable for navigation.
4. **Done** — The server regenerates all `.mdr` files and opens a modal showing reviewed file paths and a consolidated agent prompt. The server stays alive after Done.

Annotations persist as JSON files and **auto-resume** on re-run. Blocks are matched by content hash (not line numbers), so annotations survive reordering and unrelated edits. `.mdr` files are regenerated continuously — after every annotation save or delete — so they always reflect the current state.

## Multi-file review

- Start with a single entry file: `mdr <file.md>`
- Relative `.md` links in the rendered document are clickable
- Clicking a link loads the target file and adds it to the session (triggers session merge if it belongs to another session)
- Annotations are scoped per-file (via `FileKey` — relative path from session root)
- The sidebar shows a "Files" zone when >1 file is loaded
- Reviewed files are written as `<name>.mdr` after every annotation save or delete (always current)
- Each `.mdr` begins with an "AGENT PROTOCOL" comment block — the authoritative instructions for an agent applying the review
- The protocol block tells the agent to delete a file's `.mdr` once its review has been applied (it is a consumed artifact)
- Done opens a modal with all reviewed `.mdr` paths plus the related (un-annotated) cluster files to check for repercussions, and a consolidated prompt
- Sessions merge: when navigation links two sessions, the older one survives and the younger one's manifest is deleted — a file is never in two sessions
- Relaunching `mdr` on any session file restores the whole cluster, including files with no `.mdr`
- `mdr <file> --auto-discover` eagerly crawls the relative-`.md` link graph (cycle-safe BFS) and maps the whole cluster into the session up front
- `mdr <file> --clean` deletes all session data and exits

### Session management

- **Session manifest** (`session-manifest.ts`) — JSON manifest per session (`<tmpDir>/sessions/<id>.json`) tracking all files, entry file, session root, and timestamps. Saved atomically (temp + rename).
- **Session markers** — each file's annotation dir contains `.session` (session id) and `.path` (absolute file path) markers for resume and merge detection.
- **FileStore** (`file-store.ts`) — in-memory registry of loaded files with per-file `Session` handles. Used by request handlers to route annotation CRUD to the correct file.
- **Auto-discover** (`file-crawler.ts`) — cycle-safe BFS crawl of relative `.md` link graph. Register-only (does not open annotation locks or render HTML). Uses the manifest mutex to serialize writes with request handlers.

## Server lifecycle

The server stays alive after Done and shuts down via heartbeat inactivity:

- **Heartbeat** — the browser pings `GET /api/ping` periodically. The server tracks the last ping time.
- **Grace timeout** — if no ping arrives within 30 minutes of server start (handles `--no-open`, browser crash, etc.), the server shuts down.
- **Inactivity timeout** — after the first ping, if no ping arrives within 30 minutes, the server shuts down.
- **Manual stop** — `Ctrl-C` / `SIGTERM` triggers cleanup (release locks, stop server).

## LAN mode

Opt-in via `--lan`:

- Binds to `0.0.0.0` instead of `127.0.0.1`
- Prints a LAN URL and QR code to the terminal
- Validates `Host` headers against an allow-list (localhost + specified `--host`)
- `--host` lets you override the detected IPv4 for the QR code URL

## History

Built in 8 phases (scaffold → parsing → storage → review → server → CLI → UI → docs), followed by a comprehensive meta-review that fixed 26 issues across anchoring, sanitization, locking, fonts, and frontend correctness. Subsequently extended with multi-file review (session manifests, file store, auto-discover, session merge), heartbeat lifecycle, LAN mode, and continuous `.mdr` regeneration. See `specs/001/` for the original specification.
