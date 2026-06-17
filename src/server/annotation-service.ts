import { mkdir, rm, readdir, readFile, writeFile, rename, access, constants, stat } from "node:fs/promises";
import { join, basename as pathBasename, resolve } from "node:path";
import type { Annotation } from "../shared/types";

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

export class SessionLockedError extends Error {
  constructor(public readonly holdingPid: number, public readonly holdingUrl?: string) {
    super(
      `Session is locked by PID ${holdingPid}${holdingUrl ? ` (server at ${holdingUrl})` : ""}`
    );
    this.name = "SessionLockedError";
  }
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface SessionOptions {
  tmpDir: string;
  fresh?: boolean;
  sessionId?: string;  // session id for multi-file sessions
}

export interface Session {
  dir: string;
  list(): Promise<Annotation[]>;
  save(a: Annotation): Promise<Annotation>;
  remove(id: string): Promise<void>;
  release(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a short random id (8 hex chars). */
function generateId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Check if a PID is alive (returns false if dead or current process). */
function isPidAlive(pid: number): boolean {
  try {
    // process.kill with signal 0 doesn't kill, just checks existence
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "ESRCH" ? false : true; // unexpected error, be conservative
  }
}

/** Derive the session directory path.
 *
 * Uses a hash of the absolute file path (stable across content edits)
 * instead of the content hash, so that re-running `mdr` on an edited
 * file resumes the same session and relocation can detect stale/orphan.
 */
export function sessionDir(filePath: string, tmpDir: string): string {
  // Simple hash of the file path for a stable, filesystem-safe directory name
  let h = 0x811c9dc5;
  for (let i = 0; i < filePath.length; i++) {
    h ^= filePath.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const pathHash = (h >>> 0).toString(16).padStart(8, "0");
  const baseName = pathBasename(filePath) ?? "unknown";
  return join(tmpDir, "annotations", `${baseName}-${pathHash}`);
}

/** Derive the annotation file path. */
function annotationPath(sessionDir: string, id: string): string {
  return join(sessionDir, `${id}.json`);
}

/** Derive the lock file path. */
function lockPath(sessionDir: string): string {
  return join(sessionDir, ".lock");
}

// ---------------------------------------------------------------------------
// Lock management
// ---------------------------------------------------------------------------

interface LockData {
  pid: number;
  timestamp: number;
  url?: string;
}

async function acquireLock(dir: string): Promise<void> {
  const lp = lockPath(dir);
  const myPid = process.pid;

  // Try exclusive create first (atomic — no TOCTOU)
  const lockData: LockData = { pid: myPid, timestamp: Date.now() };
  const raw = JSON.stringify(lockData);
  try {
    await writeFile(lp, raw, { flag: "wx" });
    return; // Lock acquired
  } catch (e: any) {
    if (e?.code === "EEXIST") {
      // Lock file exists — check if holder is still alive
      try {
        const existingRaw = await readFile(lp, "utf-8");
        const existing: LockData = JSON.parse(existingRaw);
        if (isPidAlive(existing.pid)) {
          throw new SessionLockedError(existing.pid, existing.url);
        }
        // Stale lock — remove and retry exclusive create
        await rm(lp, { force: true });
        await writeFile(lp, raw, { flag: "wx" });
      } catch (e2: any) {
        if (e2 instanceof SessionLockedError) throw e2;
        // If retry fails, fall through to best-effort overwrite
        await writeFile(lp, raw, "utf-8");
      }
      return;
    }
    // Other error — fall through to best-effort
    await writeFile(lp, raw, "utf-8");
  }
}

async function releaseLock(dir: string): Promise<void> {
  const lp = lockPath(dir);
  try {
    await rm(lp, { force: true });
  } catch {
    // Idempotent — ignore if already gone
  }
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

async function listAnnotations(dir: string): Promise<Annotation[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: Annotation[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;

    const path = join(dir, entry.name);
    try {
      const raw = await readFile(path, "utf-8");
      const annotation: Annotation = JSON.parse(raw);
      results.push(annotation);
    } catch (e) {
      // Skip corrupt files with a warning
      console.warn(`[annotation-service] skipping corrupt annotation file: ${entry.name}`, e);
    }
  }

  return results;
}

async function saveAnnotation(dir: string, input: Annotation): Promise<Annotation> {
  const now = Date.now();

  // Determine if this is a create or update
  const existingPath = annotationPath(dir, input.id);
  let existing: Annotation | null = null;

  if (input.id) {
    try {
      const raw = await readFile(existingPath, "utf-8");
      existing = JSON.parse(raw);
    } catch {
      // File doesn't exist — treat as new
    }
  }

  const annotation: Annotation = {
    id: input.id || generateId(),
    anchor: input.anchor,
    blockType: input.blockType,
    blockText: input.blockText,
    blockLineRange: input.blockLineRange,
    comment: input.comment,
    status: input.status ?? (existing?.status ?? "ok"),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  // Atomic write: write to temp file (non-.json suffix so listAnnotations
  // won't load crash residue as a duplicate), then rename
  const tmpPath = join(dir, `${annotation.id}.tmp`);
  const finalPath = annotationPath(dir, annotation.id);
  const raw = JSON.stringify(annotation, null, 2);

  await writeFile(tmpPath, raw, "utf-8");
  await rename(tmpPath, finalPath);

  return annotation;
}

async function removeAnnotation(dir: string, id: string): Promise<void> {
  const path = annotationPath(dir, id);
  try {
    await rm(path, { force: true });
  } catch {
    // Idempotent — ignore if already gone
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open (or reclaim) a session for the given file.
 *
 * - Derives `<tmpDir>/annotations/<basename>-<pathHash>` (stable across edits)
 * - If `fresh: true`, wipes existing session contents first
 * - Acquires (or reclaims) the session lock
 * - Returns a `Session` handle for CRUD + release
 */
export async function openSession(
  filePath: string,
  opts: SessionOptions
): Promise<Session> {
  const dir = sessionDir(filePath, opts.tmpDir);

  // Ensure parent dirs exist
  await mkdir(dir, { recursive: true });

  // Acquire lock BEFORE any modifications (prevents --fresh from destroying
  // a live session and avoids TOCTOU between wipe and lock)
  await acquireLock(dir);

  // Fresh mode: wipe session contents (after lock acquired)
  // Skip .lock — we just acquired it and need it to remain in place
  if (opts.fresh) {
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (entry === ".lock") continue;
      await rm(join(dir, entry), { recursive: true, force: true });
    }
  }

  // Write .path and .session markers after lock acquired
  const resolvedPath = resolve(filePath);
  await writeFile(join(dir, ".path"), resolvedPath, "utf-8");
  if (opts.sessionId) {
    await writeFile(join(dir, ".session"), opts.sessionId, "utf-8");
  }

  // Return session handle
  const session: Session = {
    dir,
    list: () => listAnnotations(dir),
    save: (a: Annotation) => saveAnnotation(dir, a),
    remove: (id: string) => removeAnnotation(dir, id),
    release: () => releaseLock(dir),
  };

  return session;
}
