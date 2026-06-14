import { join, basename as pathBasename, extname, dirname, relative, resolve as resolvePath } from "node:path";
import { readFile, access, stat, realpath, rm } from "node:fs/promises";
import { loadDocument } from "./markdown-service";
import { autoDiscover as autoDiscoverCrawl } from "./file-crawler";
import { relocate } from "./anchoring";
import { openSession, SessionLockedError, type Session } from "./annotation-service";
import { writeReview } from "../review/generator";
import { FileStore, type FileEntry } from "./file-store";
import { createMutex } from "./manifest-mutex";
import {
  loadOrCreateSessionManifest,
  saveSessionManifest,
  loadManifestDirect,
  manifestPathDirect,
  generateShortId,
  addFileToSessionManifest,
  writeSessionMarkers,
  discoverSessionFiles,
  readSessionMarker,
  readLiveSessionMarker,
  mergeSessions,
  type SessionManifest,
} from "./session-manifest";
import type { Annotation, FileKey } from "../shared/types";

// Re-export for consumers
export { SessionLockedError } from "./annotation-service";

// ---------------------------------------------------------------------------
// MIME types for static assets
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServerOptions {
  filePath: string;       // the markdown file being reviewed (absolute or cwd-relative)
  port?: number;          // if omitted, auto-select a free port (port 0 → OS assigns)
  tmpDir: string;         // annotation storage root
  fresh?: boolean;        // pass through to openSession
  autoDiscover?: boolean; // crawl relative-.md link graph into session
  lan?: boolean;          // bind to all interfaces for opt-in LAN access
  allowedHosts?: string[]; // optional Host header allow-list for LAN exposure
  /** Override heartbeat timeout (ms). Default 30 minutes. For testing only. */
  heartbeatTimeout?: number;
  /** Override heartbeat check interval (ms). Default 5000. For testing only. */
  heartbeatInterval?: number;
  /** Override grace timeout for never-pinged servers (ms). Default 30 minutes. For testing only. */
  graceTimeout?: number;
}

export interface RunningServer {
  url: string;
  port: number;
  host: string;
  stop(): Promise<void>;
  /** Resolves when the server has stopped (either via stop() or self-shutdown). */
  stopped: Promise<void>;
}

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

let _pageHtml: string | null = null;
let _appJs: string | null = null;

async function loadPageHtml(): Promise<string> {
  if (!_pageHtml) {
    _pageHtml = await readFile(
      join(import.meta.dir, "..", "frontend", "page.html"),
      "utf-8"
    );
  }
  return _pageHtml;
}

async function loadAppJs(): Promise<string> {
  if (!_appJs) {
    _appJs = await readFile(
      join(import.meta.dir, "..", "frontend", "app.js"),
      "utf-8"
    );
  }
  return _appJs;
}

// ---------------------------------------------------------------------------
// Per-file regeneration helper
// ---------------------------------------------------------------------------

async function regenerateReviewedFile(entry: FileEntry): Promise<void> {
  const annotations = await entry.session.list();
  const relocated = relocate(annotations, entry.blocks);
  await writeReview(entry.filePath, entry.source, relocated);
}

// ---------------------------------------------------------------------------
// C1: Shared annotation CRUD handlers (used by both per-file and backward-compat routes)
// ---------------------------------------------------------------------------

/** Validate that an anchor matches at least one current block (tier-1 or tier-2). */
function validateAnchor(entry: FileEntry, anchor: Annotation["anchor"]): boolean {
  const anchorStr = `${anchor.blockType}:${anchor.textHash}:${anchor.siblingOrdinal}`;
  const contentKey = `${anchor.blockType}:${anchor.textHash}`;
  return entry.blocks.some(
    (b) => `${b.anchor.blockType}:${b.anchor.textHash}:${b.anchor.siblingOrdinal}` === anchorStr
  ) || entry.blocks.some(
    (b) => `${b.anchor.blockType}:${b.anchor.textHash}` === contentKey
  );
}

/** Persist any status/ordinal changes from relocation. */
async function persistRelocations(entry: FileEntry, annotations: Annotation[], relocated: ReturnType<typeof relocate>): Promise<void> {
  for (const r of relocated) {
    const original = annotations.find((a) => a.id === r.annotation.id);
    if (original) {
      const statusChanged = original.status !== r.annotation.status;
      const ordinalChanged = original.anchor.siblingOrdinal !== r.annotation.anchor.siblingOrdinal;
      if (statusChanged || ordinalChanged) {
        await entry.session.save(r.annotation);
      }
    }
  }
}

/** Relocate an entry's annotations, persist any moves, refresh its count. */
async function relocatedAnnotations(entry: FileEntry): Promise<Annotation[]> {
  const annotations = await entry.session.list();
  const relocated = relocate(annotations, entry.blocks);
  await persistRelocations(entry, annotations, relocated);
  entry.annotationCount = relocated.length;
  return relocated.map((r) => r.annotation);
}

/** Shared GET /annotations handler — returns relocated annotations. */
async function handleGetAnnotations(entry: FileEntry): Promise<Response> {
  return json({ annotations: await relocatedAnnotations(entry) });
}

/** Shared POST /annotations handler — creates or updates an annotation. */
async function handlePostAnnotations(entry: FileEntry, req: Request): Promise<Response> {
  const body = await req.json();
  const { anchor, blockType, blockText, blockLineRange, comment, id } = body;

  if (!anchor || !blockType || !comment) {
    return json(
      { ok: false, error: "Missing required fields: anchor, blockType, comment" },
      400
    );
  }

  if (!validateAnchor(entry, anchor)) {
    return json(
      { ok: false, error: "Anchor does not match any current block" },
      400
    );
  }

  const now = Date.now();
  const annotation: Annotation = {
    id: id ?? crypto.randomUUID().replace(/-/g, "").slice(0, 8),
    anchor,
    blockType,
    blockText: blockText ?? "",
    blockLineRange: blockLineRange ?? [0, 0],
    comment,
    status: "ok",
    createdAt: now,
    updatedAt: now,
  };

  const saved = await entry.session.save(annotation);
  const relocated = relocate([saved], entry.blocks);
  const resolved = relocated[0]?.annotation;

  if (resolved && resolved.status !== saved.status) {
    await entry.session.save(resolved);
  }
  entry.annotationCount = (await entry.session.list()).length;
  await regenerateReviewedFile(entry);
  return json({ annotation: resolved ?? saved }, id ? 200 : 201);
}

/** Shared DELETE /annotations/:id handler. */
async function handleDeleteAnnotation(entry: FileEntry, id: string): Promise<Response> {
  const annotations = await entry.session.list();
  const exists = annotations.some((a) => a.id === id);
  if (!exists) {
    return json({ ok: false, error: `Annotation ${id} not found` }, 404);
  }
  await entry.session.remove(id);
  entry.annotationCount = (await entry.session.list()).length;
  await regenerateReviewedFile(entry);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { filePath, port = 0, tmpDir, fresh, autoDiscover, lan = false, allowedHosts, heartbeatTimeout, heartbeatInterval, graceTimeout } = opts;

  // Resolve entry file to absolute path
  const entryFilePathRaw = resolvePath(filePath);
  const sessionRootRaw = dirname(entryFilePathRaw);
  // Normalize with realpath so keys computed via relative(sessionRoot, filePath)
  // match regardless of /tmp → /private/tmp symlink resolution
  let sessionRoot = await realpath(sessionRootRaw);
  const entryFilePath = await realpath(entryFilePathRaw);

  // --- Session manifest startup ---
  let currentManifest: SessionManifest;
  let currentSessionId: string;

  if (fresh) {
    // --fresh session reset: detach from old manifest, create new one
    const oldSessionId = await readSessionMarker(entryFilePath, tmpDir);
    if (oldSessionId) {
      const oldManifest = await loadManifestDirect(oldSessionId, tmpDir);
      if (oldManifest) {
        // Remove entry file from old manifest
        oldManifest.files = oldManifest.files.filter(
          (f) => f.filePath !== entryFilePath
        );
        if (oldManifest.files.length === 0) {
          // Delete empty manifest
          await rm(manifestPathDirect(tmpDir, oldSessionId), { force: true });
        } else {
          oldManifest.updatedAt = Date.now();
          await saveSessionManifest(oldManifest, tmpDir);
        }
      }
    }
    // Create brand-new manifest with only the entry file
    const now = Date.now();
    const newId = generateShortId();
    currentManifest = {
      id: newId,
      createdAt: now,
      sessionRoot: sessionRoot,
      entryFilePath: entryFilePath,
      files: [
        { filePath: entryFilePath, firstLoadedAt: now, lastLoadedAt: now },
      ],
      updatedAt: now,
    };
    await saveSessionManifest(currentManifest, tmpDir);
    currentSessionId = newId;
  } else {
    // Normal startup: load or create manifest
    currentManifest = await loadOrCreateSessionManifest(entryFilePath, tmpDir);
    currentSessionId = currentManifest.id;
    // B4: reuse persisted sessionRoot when resuming an existing session
    if (currentManifest.sessionRoot && currentManifest.sessionRoot !== sessionRoot) {
      sessionRoot = currentManifest.sessionRoot;
    }
    // Ensure the manifest's sessionRoot matches our normalized value
    currentManifest.sessionRoot = sessionRoot;
  }

  // Write session markers for entry file
  await writeSessionMarkers(entryFilePath, tmpDir, currentSessionId);

  // Load and parse document with link detection (B1: entry-page .md links must be clickable)
  const { source, fileHash, blocks, fullHtml, links } = await loadDocument(entryFilePath, {
    sessionRoot,
    currentFileDir: dirname(entryFilePath),
  });

  // Open annotation session for entry file (with sessionId)
  const entrySession = await openSession(entryFilePath, {
    tmpDir,
    fresh,
    sessionId: currentSessionId,
  });

  // Create FileStore with entry file
  const entryKey = relative(sessionRoot, entryFilePath) as FileKey;
  const fileStore = new FileStore(sessionRoot, entryKey);

  const entryFileEntry: FileEntry = {
    key: entryKey,
    filePath: entryFilePath,
    source,
    fileHash,
    blocks,
    fullHtml,
    links,
    fileName: pathBasename(entryFilePath),
    annotationCount: 0,
    session: entrySession,
  };
  fileStore.add(entryFileEntry);

  // Read templates
  const pageHtml = await loadPageHtml();
  const appJs = await loadAppJs();

  // Inject full-document HTML and file name
  const fileName = entryFileEntry.fileName;
  const renderedPage = pageHtml
    .replace("<!--BLOCKS-->", fullHtml)
    .replace("<!--FILE_NAME-->", fileName)
    .replace("<!--FILE_KEY-->", entryKey);

  // Pre-gzip the two large, static text responses once at startup. The page
  // and app.js never change for the life of the server, so there is no reason
  // to recompress per request. Cuts critical-path bytes ~75% on the wire.
  const renderedPageGz = Bun.gzipSync(renderedPage);
  const appJsGz = Bun.gzipSync(appJs);

  // Stopped promise — resolves when the server shuts down (via stop() or self-shutdown)
  let resolveStopped: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });

  // B5: serialize manifest writes so the background crawl and request handlers
  // can't interleave at await boundaries and lose updates. See manifest-mutex.ts.
  const manifestMutex = createMutex();

  function setCurrentManifest(manifest: SessionManifest): void {
    currentManifest = manifest;
    currentSessionId = manifest.id;
  }

  // Heartbeat — tracks browser pings, shuts down after inactivity
  let lastPing: number | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const host = lan ? "0.0.0.0" : "127.0.0.1";
  const hostAllowList = buildHostAllowList(allowedHosts);
  let actualPort: number | null = null;

  // Start the HTTP server (localhost-only by default; LAN exposure is opt-in)
  const bunServer = Bun.serve({
    hostname: host,
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (lan && hostAllowList && !isAllowedRequestHost(req.headers.get("host"), hostAllowList, actualPort)) {
        return json({ ok: false, error: "Host header is not allowed" }, 403);
      }

      // GET / — prerendered page
      if (pathname === "/" && req.method === "GET") {
        if (acceptsGzip(req)) {
          return new Response(renderedPageGz, {
            headers: { "Content-Type": "text/html; charset=utf-8", "Content-Encoding": "gzip" },
          });
        }
        return new Response(renderedPage, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // GET /app.js — inline JS
      if (pathname === "/app.js" && req.method === "GET") {
        if (acceptsGzip(req)) {
          return new Response(appJsGz, {
            headers: { "Content-Type": "application/javascript; charset=utf-8", "Content-Encoding": "gzip" },
          });
        }
        return new Response(appJs, {
          headers: { "Content-Type": "application/javascript; charset=utf-8" },
        });
      }

      // GET /static/* — static assets from public/
      if (pathname.startsWith("/static/") && req.method === "GET") {
        const relPath = pathname.slice("/static/".length);
        const publicDir = join(import.meta.dir, "..", "..", "public");
        const assetPath = join(publicDir, relPath);
        // Containment: ensure resolved path is inside public/
        // C8: trailing path.sep guard prevents prefix-match on siblings like public-x/
        if (!assetPath.startsWith(publicDir + "/")) {
          return json({ ok: false, error: `Not found: ${pathname}` }, 404);
        }
        try {
          await access(assetPath);
          const ext = extname(assetPath).toLowerCase();
          const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
          const data = await readFile(assetPath);
          return new Response(data, {
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "public, max-age=31536000, immutable",
            },
          });
        } catch {
          return json({ ok: false, error: `Not found: ${pathname}` }, 404);
        }
      }

      // GET /api/files — list loaded files + activeKey
      if (pathname === "/api/files" && req.method === "GET") {
        const files = fileStore.list().map((entry) => ({
          key: entry.key,
          fileName: entry.fileName,
          annotationCount: entry.annotationCount,
        }));
        return json({ files, activeKey: fileStore.getEntryKey() });
      }

      // GET /api/session-files — manifest-backed file list (authoritative for file zone)
      if (pathname === "/api/session-files" && req.method === "GET") {
        const sessionFiles = await discoverSessionFiles(currentManifest, tmpDir);
        const files = sessionFiles.map((sf) => ({
          key: relative(sessionRoot, sf.filePath) as FileKey,
          fileName: pathBasename(sf.filePath),
          annotationCount: sf.annotationCount,
          isEntry: sf.isEntry,
        }));
        const result: Record<string, unknown> = { files };
        if (autoDiscover) {
          result.discovering = discovering;
        }
        return json(result);
      }

      // GET /api/files/:key — load file on-demand
      if (pathname.match(/^\/api\/files\/[^/]+$/) && req.method === "GET") {
        const encodedKey = pathname.replace("/api/files/", "");
        if (!encodedKey) {
          return json({ ok: false, error: "Missing file key" }, 400);
        }

        let key: string;
        try {
          key = decodeURIComponent(encodedKey);
        } catch {
          return json({ ok: false, error: "Malformed file key" }, 400);
        }

        // Return cached data if already loaded
        const cached = fileStore.get(key as FileKey);
        if (cached) {
          // Fold relocated annotations into the load response so the client
          // needs only one round trip per navigation (refreshes the count too).
          const annotations = await relocatedAnnotations(cached);

          return json({
            source: cached.source,
            blocks: cached.blocks,
            fullHtml: cached.fullHtml,
            links: cached.links,
            fileName: cached.fileName,
            key: cached.key,
            annotationCount: cached.annotationCount,
            annotations,
          });
        }

        // Resolve key relative to session root
        const resolvedPath = resolvePath(fileStore.getSessionRoot(), key);

        // Validate: must be an existing regular .md file
        try {
          const realPath = await realpath(resolvedPath);
          const fileStat = await stat(realPath);

          if (!fileStat.isFile()) {
            return json({ ok: false, error: `Not a regular file: ${key}` }, 404);
          }

          if (!realPath.toLowerCase().endsWith(".md")) {
            return json({ ok: false, error: `Not a .md file: ${key}` }, 404);
          }

          // Check if this file belongs to a different session → MERGE
          // Must happen BEFORE openSession (which writes the session marker)
          const existingSession = await readLiveSessionMarker(realPath, tmpDir);
          if (existingSession && existingSession !== currentSessionId) {
            // MERGE — older session survives (under mutex to prevent races)
            const release = await manifestMutex.acquire();
            try {
              setCurrentManifest(await mergeSessions(
                currentSessionId,
                existingSession,
                tmpDir,
                fileStore.list().map((e) => e.filePath)
              ));
            } finally {
              release();
            }
          }

          // Acquire per-file lock (after merge, so sessionId is correct)
          let session: Session;
          try {
            session = await openSession(realPath, { tmpDir, sessionId: currentSessionId });
          } catch (err: any) {
            if (err instanceof SessionLockedError) {
              return json(
                { ok: false, error: `File is locked by another session: ${key}` },
                409
              );
            }
            throw err;
          }

          // Write session markers and add to manifest (under mutex to prevent races)
          await writeSessionMarkers(realPath, tmpDir, currentSessionId);
          const release = await manifestMutex.acquire();
          try {
            const updated = await addFileToSessionManifest(currentManifest, realPath, tmpDir);
            setCurrentManifest(updated);
          } finally {
            release();
          }

          // Parse the document with link detection
          const doc = await loadDocument(realPath, {
            sessionRoot: fileStore.getSessionRoot(),
            currentFileDir: dirname(realPath),
          });

          // Add to FileStore
          const newEntry: FileEntry = {
            key: key as FileKey,
            filePath: realPath,
            source: doc.source,
            fileHash: doc.fileHash,
            blocks: doc.blocks,
            fullHtml: doc.fullHtml,
            links: doc.links,
            fileName: pathBasename(realPath),
            annotationCount: 0,
            session,
          };
          fileStore.add(newEntry);

          return json({
            source: newEntry.source,
            blocks: newEntry.blocks,
            fullHtml: newEntry.fullHtml,
            links: newEntry.links,
            fileName: newEntry.fileName,
            key: newEntry.key,
            annotationCount: newEntry.annotationCount,
            annotations: await relocatedAnnotations(newEntry),
          });
        } catch (err: any) {
          if (err.code === "ENOENT") {
            return json({ ok: false, error: `File not found: ${key}` }, 404);
          }
          if (err instanceof SessionLockedError) {
            return json(
              { ok: false, error: `File is locked by another session: ${key}` },
              409
            );
          }
          return json(
            { ok: false, error: err.message ?? "Failed to load file" },
            500
          );
        }
      }

      // GET /api/files/:key/annotations — file-scoped annotations
      if (pathname.match(/^\/api\/files\/[^/]+\/annotations$/) && req.method === "GET") {
        const encodedKey = pathname.replace("/api/files/", "").replace("/annotations", "");
        if (!encodedKey) {
          return json({ ok: false, error: "Missing file key" }, 400);
        }

        let key: string;
        try {
          key = decodeURIComponent(encodedKey);
        } catch {
          return json({ ok: false, error: "Malformed file key" }, 400);
        }

        const entry = fileStore.get(key as FileKey);
        if (!entry) {
          return json({ ok: false, error: `File not loaded: ${key}` }, 404);
        }

        return handleGetAnnotations(entry);
      }

      // POST /api/files/:key/annotations — create/update annotation scoped to file
      if (pathname.match(/^\/api\/files\/[^/]+\/annotations$/) && req.method === "POST") {
        const encodedKey = pathname.replace("/api/files/", "").replace("/annotations", "");
        if (!encodedKey) {
          return json({ ok: false, error: "Missing file key" }, 400);
        }

        let key: string;
        try {
          key = decodeURIComponent(encodedKey);
        } catch {
          return json({ ok: false, error: "Malformed file key" }, 400);
        }

        const entry = fileStore.get(key as FileKey);
        if (!entry) {
          return json({ ok: false, error: `File not loaded: ${key}` }, 404);
        }

        return handlePostAnnotations(entry, req);
      }

      // DELETE /api/files/:key/annotations/:id
      if (pathname.match(/^\/api\/files\/[^/]+\/annotations\/[^/]+$/) && req.method === "DELETE") {
        const match = pathname.match(/^\/api\/files\/([^/]+)\/annotations\/([^/]+)$/);
        if (!match) {
          return json({ ok: false, error: "Invalid path" }, 400);
        }

        const encodedKey = match[1]!;
        const id = match[2]!;

        let key: string;
        try {
          key = decodeURIComponent(encodedKey);
        } catch {
          return json({ ok: false, error: "Malformed file key" }, 400);
        }

        const entry = fileStore.get(key as FileKey);
        if (!entry) {
          return json({ ok: false, error: `File not loaded: ${key}` }, 404);
        }

        return handleDeleteAnnotation(entry, id);
      }

      // --- Backward-compatible routes (delegate to entry file) ---

      // GET /api/markdown → entry file
      if (pathname === "/api/markdown" && req.method === "GET") {
        const entry = fileStore.get(fileStore.getEntryKey());
        if (!entry) {
          return json({ ok: false, error: "Entry file not found" }, 500);
        }
        return json({ source: entry.source, blocks: entry.blocks });
      }

      // GET /api/annotations → entry file
      if (pathname === "/api/annotations" && req.method === "GET") {
        const entry = fileStore.get(fileStore.getEntryKey());
        if (!entry) {
          return json({ ok: false, error: "Entry file not found" }, 500);
        }
        return handleGetAnnotations(entry);
      }

      // POST /api/annotations → entry file
      if (pathname === "/api/annotations" && req.method === "POST") {
        const entry = fileStore.get(fileStore.getEntryKey());
        if (!entry) {
          return json({ ok: false, error: "Entry file not found" }, 500);
        }
        return handlePostAnnotations(entry, req);
      }

      // DELETE /api/annotations/:id → entry file
      if (pathname.startsWith("/api/annotations/") && req.method === "DELETE") {
        const id = pathname.replace("/api/annotations/", "");
        if (!id) {
          return json({ ok: false, error: "Missing annotation id" }, 400);
        }

        const entry = fileStore.get(fileStore.getEntryKey());
        if (!entry) {
          return json({ ok: false, error: "Entry file not found" }, 500);
        }
        return handleDeleteAnnotation(entry, id);
      }

      // GET /api/ping — heartbeat (tracks browser presence)
      if (pathname === "/api/ping" && req.method === "GET") {
        lastPing = Date.now();
        return json({ ok: true });
      }

      // GET /api/reviewed-files — files with annotations (have .mdr)
      // B2: source from manifest/session, not just loaded files in FileStore
      if (pathname === "/api/reviewed-files" && req.method === "GET") {
        const reviewedFiles = [];
        const sessionFiles = await discoverSessionFiles(currentManifest, tmpDir);
        for (const sf of sessionFiles) {
          if (sf.annotationCount > 0) {
            reviewedFiles.push({
              key: relative(sessionRoot, sf.filePath) as FileKey,
              reviewedPath: sf.filePath.replace(/\.md$/i, ".mdr"),
              sourcePath: sf.filePath,
              annotationCount: sf.annotationCount,
            });
          }
        }
        return json({ files: reviewedFiles });
      }

      // POST /api/done — regenerate entry .mdr, return path (non-terminating)
      if (pathname === "/api/done" && req.method === "POST") {
        const entry = fileStore.get(fileStore.getEntryKey());
        if (!entry) {
          return json({ ok: false, error: "Entry file not found" }, 500);
        }

        try {
          const annotations = await entry.session.list();
          const relocated = relocate(annotations, entry.blocks);
          const outputPath = await writeReview(entry.filePath, entry.source, relocated);
          return json({ ok: true, path: outputPath });
        } catch (err: any) {
          return json(
            { ok: false, error: err.message ?? "Failed to generate review" },
            500
          );
        }
      }

      // Fallback: 404
      return json({ ok: false, error: `Not found: ${pathname}` }, 404);
    },
  });

  const boundPort = bunServer.port ?? 0;
  actualPort = boundPort;
  const url = `http://localhost:${boundPort}`;

  // Start auto-discover crawl in background (non-blocking)
  let discovering = false;
  if (autoDiscover) {
    discovering = true;
    // B5: pass the manifest mutex so the crawl serializes writes with request handlers
    autoDiscoverCrawl(
      entryFilePath,
      sessionRoot,
      tmpDir,
      {
        get: () => currentManifest,
        set: setCurrentManifest,
      },
      manifestMutex,
    ).then(() => {
      discovering = false;
    }).catch(() => {
      // Best-effort — crawl may fail if tmpDir was cleaned up
      discovering = false;
    });
  }

  // R1: grace timeout — if no ping arrives within the inactivity window,
  // shut down even without a first ping (handles --no-open, browser crash, etc.)
  const serverStartTime = Date.now();
  const HEARTBEAT_TIMEOUT = heartbeatTimeout ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const GRACE_TIMEOUT = graceTimeout ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const CHECK_INTERVAL = heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  // Heartbeat timer — shuts down after inactivity (same window for silence or no first ping)
  heartbeat = setInterval(async () => {
    const now = Date.now();
    const shouldShutdown =
      (lastPing !== null && now - lastPing > HEARTBEAT_TIMEOUT) ||
      (lastPing === null && now - serverStartTime > GRACE_TIMEOUT);
    if (shouldShutdown) {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      bunServer.stop(true);
      await fileStore.releaseAll();
      resolveStopped();
    }
  }, CHECK_INTERVAL);

  return {
    url,
    port: boundPort,
    host,
    async stop() {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      bunServer.stop();
      await fileStore.releaseAll();
      resolveStopped();
    },
    stopped,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** True when the client advertises gzip support in Accept-Encoding. */
function acceptsGzip(req: Request): boolean {
  return (req.headers.get("accept-encoding") ?? "").toLowerCase().includes("gzip");
}

function normalizeHostname(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

interface ParsedHostHeader {
  hostname: string;
  port?: number;
}

function parseHostPort(portText: string): number | undefined {
  if (!/^\d+$/.test(portText)) return undefined;
  const port = Number(portText);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : undefined;
}

function parseHostHeader(hostHeader: string | null): ParsedHostHeader | null {
  if (!hostHeader) return null;
  const host = hostHeader.trim();
  if (!host) return null;

  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end <= 1) return null;
    const parsed: ParsedHostHeader = { hostname: normalizeHostname(host.slice(0, end + 1)) };
    const rest = host.slice(end + 1);
    if (rest.startsWith(":")) {
      parsed.port = parseHostPort(rest.slice(1));
    }
    return parsed;
  }

  const [hostname, portText] = host.split(":");
  if (!hostname) return null;
  const parsed: ParsedHostHeader = { hostname: normalizeHostname(hostname) };
  if (portText !== undefined) {
    parsed.port = parseHostPort(portText);
  }
  return parsed;
}

function buildHostAllowList(allowedHosts: string[] | undefined): Set<string> | null {
  if (!allowedHosts || allowedHosts.length === 0) return null;

  const hosts = new Set(["localhost", "127.0.0.1", "::1"]);
  for (const host of allowedHosts) {
    const normalized = normalizeHostname(host);
    if (normalized) hosts.add(normalized);
  }
  return hosts;
}

function isAllowedRequestHost(
  hostHeader: string | null,
  allowedHosts: Set<string>,
  expectedPort: number | null,
): boolean {
  const parsed = parseHostHeader(hostHeader);
  if (!parsed || !allowedHosts.has(parsed.hostname)) return false;
  return parsed.port === undefined || expectedPort === null || parsed.port === expectedPort;
}
