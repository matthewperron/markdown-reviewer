import { mkdir, rm, readdir, readFile, writeFile, rename, access, realpath } from "node:fs/promises";
import { join, dirname, resolve as resolvePath } from "node:path";
import { sessionDir } from "./annotation-service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionManifestFile {
  filePath: string;
  firstLoadedAt: number;
  lastLoadedAt: number;
}

export interface SessionManifest {
  id: string;
  createdAt: number;
  sessionRoot: string;
  entryFilePath: string;
  files: SessionManifestFile[];
  updatedAt: number;
}

export interface SessionFile {
  filePath: string;
  sessionDir: string;
  annotationCount: number;
  isEntry: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a short random session id (8 hex chars). */
export function generateShortId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Get the sessions directory path. */
function sessionsDir(tmpDir: string): string {
  return join(tmpDir, "sessions");
}

/** Get the manifest file path. */
export function manifestPathDirect(tmpDir: string, sessionId: string): string {
  return join(sessionsDir(tmpDir), `${sessionId}.json`);
}



/** Check if a file exists. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Count .json annotation files in a session dir. */
async function countAnnotationJsonFiles(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith(".json") && !e.startsWith(".")).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Marker reads/writes
// ---------------------------------------------------------------------------

/** Read .session marker from a file's annotation dir. */
export async function readSessionMarker(
  filePath: string,
  tmpDir: string
): Promise<string | null> {
  const dir = sessionDir(filePath, tmpDir);
  const path = join(dir, ".session");
  try {
    return (await readFile(path, "utf-8")).trim();
  } catch {
    return null;
  }
}

/**
 * Read a .session marker only if its manifest still exists.
 *
 * Stale markers are possible after merges where an older manifest survives and
 * the absorbed manifest is deleted. Callers that are deciding whether to merge
 * should treat those markers as absent instead of attempting a doomed merge.
 */
export async function readLiveSessionMarker(
  filePath: string,
  tmpDir: string
): Promise<string | null> {
  const sessionId = await readSessionMarker(filePath, tmpDir);
  if (!sessionId) return null;
  const manifest = await loadManifestDirect(sessionId, tmpDir);
  return manifest ? sessionId : null;
}

/** Write .path and .session markers. */
export async function writeSessionMarkers(
  filePath: string,
  tmpDir: string,
  sessionId: string
): Promise<void> {
  const dir = sessionDir(filePath, tmpDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".path"), filePath, "utf-8");
  await writeFile(join(dir, ".session"), sessionId, "utf-8");
}

// ---------------------------------------------------------------------------
// Manifest CRUD
// ---------------------------------------------------------------------------

/** Save manifest atomically (temp + rename). */
export async function saveSessionManifest(
  manifest: SessionManifest,
  tmpDir: string
): Promise<void> {
  const dir = sessionsDir(tmpDir);
  await mkdir(dir, { recursive: true });
  const path = manifestPathDirect(tmpDir, manifest.id);
  const tmpPath = path + ".tmp";
  await writeFile(tmpPath, JSON.stringify(manifest, null, 2), "utf-8");
  await rename(tmpPath, path);
}

/** Load a manifest by id. */
export async function loadManifestDirect(
  sessionId: string,
  tmpDir: string
): Promise<SessionManifest | null> {
  const path = manifestPathDirect(tmpDir, sessionId);
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}



/** Scan all manifests for one containing a given filePath. */
async function findManifestContaining(
  filePath: string,
  tmpDir: string
): Promise<SessionManifest | null> {
  const dir = sessionsDir(tmpDir);
  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -5);
      const manifest = await loadManifestDirect(id, tmpDir);
      if (manifest && manifest.files.some((f) => f.filePath === filePath)) {
        return manifest;
      }
    }
  } catch {
    // sessions dir doesn't exist yet
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Load existing or create new manifest for entry file. */
export async function loadOrCreateSessionManifest(
  entryFilePath: string,
  tmpDir: string
): Promise<SessionManifest> {
  // Read .session marker
  const existingSessionId = await readSessionMarker(entryFilePath, tmpDir);

  if (existingSessionId) {
    // Try to load the manifest
    const manifest = await loadManifestDirect(existingSessionId, tmpDir);
    if (manifest) {
      // Ensure entry file is in the manifest
      const updated = await addFileToSessionManifest(manifest, entryFilePath, tmpDir);
      // Ensure marker is current
      await writeSessionMarkers(entryFilePath, tmpDir, updated.id);
      return updated;
    }
    // Recovery: manifest is missing, scan for one containing this path
    const found = await findManifestContaining(entryFilePath, tmpDir);
    if (found) {
      // Rewrite the marker and return
      const updated = await addFileToSessionManifest(found, entryFilePath, tmpDir);
      await writeSessionMarkers(entryFilePath, tmpDir, updated.id);
      return updated;
    }
  }

  // Create new manifest
  const now = Date.now();
  const manifest: SessionManifest = {
    id: generateShortId(),
    createdAt: now,
    sessionRoot: dirname(entryFilePath),
    entryFilePath: entryFilePath,
    files: [
      { filePath: entryFilePath, firstLoadedAt: now, lastLoadedAt: now },
    ],
    updatedAt: now,
  };
  await saveSessionManifest(manifest, tmpDir);
  await writeSessionMarkers(entryFilePath, tmpDir, manifest.id);
  return manifest;
}

/** Add a file to the manifest (or update timestamps if already present). */
export async function addFileToSessionManifest(
  manifest: SessionManifest,
  filePath: string,
  tmpDir: string
): Promise<SessionManifest> {
  const existing = manifest.files.find((f) => f.filePath === filePath);
  const now = Date.now();

  if (existing) {
    existing.lastLoadedAt = now;
  } else {
    manifest.files.push({ filePath, firstLoadedAt: now, lastLoadedAt: now });
  }
  manifest.updatedAt = now;
  await saveSessionManifest(manifest, tmpDir);
  return { ...manifest };
}

/** Discover session files from manifest only. */
export async function discoverSessionFiles(
  manifest: SessionManifest,
  tmpDir: string
): Promise<SessionFile[]> {
  const results: SessionFile[] = [];
  for (const f of manifest.files) {
    if (!(await fileExists(f.filePath))) continue;
    const sessionDirPath = sessionDir(f.filePath, tmpDir);
    results.push({
      filePath: f.filePath,
      sessionDir: sessionDirPath,
      annotationCount: await countAnnotationJsonFiles(sessionDirPath),
      isEntry: f.filePath === manifest.entryFilePath,
    });
  }
  return results;
}

/**
 * Merge two sessions — older survives.
 *
 * @param idA - First session id
 * @param idB - Second session id
 * @param tmpDir - Temporary directory root
 * @param ownedPaths - Paths currently held by locks; only these files get .session marker
 *   rewrites. Files not owned are still added to the manifest union but their markers are
 *   left untouched to avoid clobbering another mdr instance's session claim.
 * @returns The surviving (older) manifest.
 *
 * Tie-break: when createdAt is equal, the smaller id string wins (deterministic but arbitrary).
 * This is intentional — sessions created within the same millisecond are rare, and when they
 * occur the choice of survivor is arbitrary. The id-based tie-break ensures deterministic,
 * order-independent behavior regardless of which session is passed as idA vs idB.
 */
export async function mergeSessions(
  idA: string,
  idB: string,
  tmpDir: string,
  ownedPaths: string[]
): Promise<SessionManifest> {
  const manifestA = await loadManifestDirect(idA, tmpDir);
  const manifestB = await loadManifestDirect(idB, tmpDir);

  if (!manifestA || !manifestB) {
    throw new Error(
      `Cannot merge: missing manifest (${!manifestA ? idA : idB})`
    );
  }

  // Survivor = older (smaller createdAt); ties broken by id string compare.
  // R3: this makes the merge order-independent and fully deterministic —
  // mergeSessions(A, B) and mergeSessions(B, A) pick the same survivor, even
  // when both manifests were created within the same millisecond (the id
  // comparison is a stable, arbitrary-but-consistent tie-break).
  let survivor: SessionManifest;
  let absorbed: SessionManifest;
  if (
    manifestA.createdAt < manifestB.createdAt ||
    (manifestA.createdAt === manifestB.createdAt && manifestA.id < manifestB.id)
  ) {
    survivor = manifestA;
    absorbed = manifestB;
  } else {
    survivor = manifestB;
    absorbed = manifestA;
  }

  // Union: add absorbed files to survivor
  for (const f of absorbed.files) {
    const existing = survivor.files.find((s) => s.filePath === f.filePath);
    if (existing) {
      existing.firstLoadedAt = Math.min(existing.firstLoadedAt, f.firstLoadedAt);
      existing.lastLoadedAt = Math.max(existing.lastLoadedAt, f.lastLoadedAt);
    } else {
      survivor.files.push({ ...f });
    }
  }
  survivor.updatedAt = Date.now();

  // Re-point .session markers only for files we own (hold locks on).
  // Files not owned may be held by another mdr instance — don't clobber their markers.
  // The manifest union already guarantees membership for all absorbed files.
  const ownedSet = new Set(ownedPaths);
  for (const f of absorbed.files) {
    if (!ownedSet.has(f.filePath)) continue;
    try {
      const dir = sessionDir(f.filePath, tmpDir);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, ".session"), survivor.id, "utf-8");
    } catch {
      // Best-effort — manifest union already guarantees membership
    }
  }

  // Save survivor and delete absorbed
  await saveSessionManifest(survivor, tmpDir);
  await rm(manifestPathDirect(tmpDir, absorbed.id), { force: true });

  return survivor;
}

/**
 * Clean up session data for a single file after its review has been applied.
 *
 * Removes:
 * - The .mdr reviewed output file
 * - The annotation directory (annotations, lock, markers)
 * - The file entry from the session manifest
 * - The manifest itself if it becomes empty
 *
 * Idempotent: safe to call even if the file has no session data.
 */
export async function cleanupFile(
  filePath: string,
  tmpDir: string
): Promise<void> {
  // Normalize with realpath for cross-platform case-insensitive matching
  // (e.g. "readme.md" vs "README.md" on Windows)
  const resolvedPath = await realpath(resolvePath(filePath)).catch(
    () => resolvePath(filePath)
  );

  // Read session marker BEFORE deleting the annotation directory
  const sessionId = await readSessionMarker(resolvedPath, tmpDir).catch(() => null);

  // Delete the .mdr output file
  const mdrPath = resolvedPath.replace(/\.md$/i, ".mdr");
  await rm(mdrPath, { force: true });

  // Delete annotation directory (annotations, lock, markers)
  const sessDir = sessionDir(resolvedPath, tmpDir);
  await rm(sessDir, { recursive: true, force: true });

  // If no session was tracked, we're done
  if (!sessionId) return;

  // Try to load the manifest (may have been deleted)
  const manifest = await loadManifestDirect(sessionId, tmpDir).catch(() => null);
  if (!manifest) return;

  // Remove the file from the manifest (case-insensitive on Windows)
  const isWin = process.platform === "win32";
  const lowerPath = isWin ? resolvedPath.toLowerCase() : resolvedPath;
  manifest.files = manifest.files.filter((f) => {
    const stored = isWin ? f.filePath.toLowerCase() : f.filePath;
    return stored !== lowerPath;
  });
  manifest.updatedAt = Date.now();

  if (manifest.files.length === 0) {
    // Empty manifest — delete it
    await rm(manifestPathDirect(tmpDir, sessionId), { force: true });
  } else {
    await saveSessionManifest(manifest, tmpDir);
  }
}
