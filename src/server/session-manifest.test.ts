import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm, readdir, readFile, access, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanupFile,
  loadOrCreateSessionManifest,
  saveSessionManifest,
  loadManifestDirect,
  addFileToSessionManifest,
  writeSessionMarkers,
  readSessionMarker,
  discoverSessionFiles,
  mergeSessions,
  generateShortId,
  manifestPathDirect,
  type SessionManifest,
} from "./session-manifest";
import { sessionDir } from "./annotation-service";

let tmpDir: string;
let fileDir: string;

async function createTestFile(name: string, content = "# Test"): Promise<string> {
  const path = join(fileDir, name);
  // We create the file synchronously for test setup
  Bun.write(path, content);
  // Return realpath-normalized path so cleanupFile (which uses realpath internally)
  // can find the session marker written during loadOrCreateSessionManifest
  return realpath(path);
}

beforeEach(async () => {
  tmpDir = join(
    tmpdir(),
    `mdr-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fileDir = join(tmpDir, "files");
  await mkdir(fileDir, { recursive: true });
});

afterEach(async () => {
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Basic manifest creation
// ---------------------------------------------------------------------------

describe("loadOrCreateSessionManifest", () => {
  test("creates a new manifest for a file with no existing session", async () => {
    const filePath = await createTestFile("doc.md");

    const manifest = await loadOrCreateSessionManifest(filePath, tmpDir);

    expect(manifest.id).toBeDefined();
    expect(manifest.id.length).toBe(8);
    expect(manifest.createdAt).toBeGreaterThan(0);
    expect(manifest.entryFilePath).toBe(filePath);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].filePath).toBe(filePath);
    expect(manifest.files[0].firstLoadedAt).toBeGreaterThan(0);
    expect(manifest.files[0].lastLoadedAt).toBeGreaterThan(0);
    expect(manifest.updatedAt).toBeGreaterThan(0);

    // Verify manifest was saved to disk
    const saved = await loadManifestDirect(manifest.id, tmpDir);
    expect(saved).not.toBeNull();
    expect(saved!.id).toBe(manifest.id);
  });

  test("loads existing manifest from .session marker", async () => {
    const filePath = await createTestFile("doc.md");

    // First call creates the manifest
    const manifest1 = await loadOrCreateSessionManifest(filePath, tmpDir);

    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));

    // Second call should load the same manifest
    const manifest2 = await loadOrCreateSessionManifest(filePath, tmpDir);

    expect(manifest2.id).toBe(manifest1.id);
    expect(manifest2.createdAt).toBe(manifest1.createdAt);
    expect(manifest2.updatedAt).toBeGreaterThan(manifest1.updatedAt);
  });
});

// ---------------------------------------------------------------------------
// Recovery: marker points at missing manifest
// ---------------------------------------------------------------------------

describe("recovery", () => {
  test("recovers when .session marker points at a missing manifest", async () => {
    const filePath = await createTestFile("doc.md");

    // Create a manifest and write the marker
    const manifest = await loadOrCreateSessionManifest(filePath, tmpDir);
    const marker = await readSessionMarker(filePath, tmpDir);
    expect(marker).toBe(manifest.id);

    // Delete the manifest file
    await rm(manifestPathDirect(tmpDir, manifest.id), { force: true });

    // Verify it's gone
    const gone = await loadManifestDirect(manifest.id, tmpDir);
    expect(gone).toBeNull();

    // Now create another file in a new session, then add the original file
    // Actually, recovery scans all manifests for one containing the path.
    // So let's create a new manifest that has this file in its list.
    const now = Date.now();
    const newManifest: SessionManifest = {
      id: generateShortId(),
      createdAt: now,
      sessionRoot: fileDir,
      entryFilePath: filePath,
      files: [
        { filePath, firstLoadedAt: now, lastLoadedAt: now },
      ],
      updatedAt: now,
    };
    await saveSessionManifest(newManifest, tmpDir);

    // Now loadOrCreateSessionManifest should find this manifest via recovery
    const recovered = await loadOrCreateSessionManifest(filePath, tmpDir);

    expect(recovered.id).toBe(newManifest.id);
    // The marker should have been rewritten
    const newMarker = await readSessionMarker(filePath, tmpDir);
    expect(newMarker).toBe(newManifest.id);
  });

  test("creates new manifest when recovery finds nothing", async () => {
    const filePath = await createTestFile("doc.md");

    // Write a stale .session marker pointing at a non-existent manifest
    const dir = sessionDir(filePath, tmpDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".session"), "deadbeef", "utf-8");

    // loadOrCreateSessionManifest should create a new manifest
    const manifest = await loadOrCreateSessionManifest(filePath, tmpDir);

    expect(manifest.id).not.toBe("deadbeef");
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].filePath).toBe(filePath);

    // Marker should be updated
    const marker = await readSessionMarker(filePath, tmpDir);
    expect(marker).toBe(manifest.id);
  });
});

// ---------------------------------------------------------------------------
// writeSessionMarkers / readSessionMarker
// ---------------------------------------------------------------------------

describe("writeSessionMarkers", () => {
  test("writes .path and .session correctly", async () => {
    const filePath = await createTestFile("doc.md");
    const sessionId = "abcdef12";

    await writeSessionMarkers(filePath, tmpDir, sessionId);

    const dir = sessionDir(filePath, tmpDir);
    const pathContent = (await readFile(join(dir, ".path"), "utf-8")).trim();
    const sessionContent = (await readFile(join(dir, ".session"), "utf-8")).trim();

    expect(pathContent).toBe(filePath);
    expect(sessionContent).toBe(sessionId);
  });
});

describe("readSessionMarker", () => {
  test("returns null when no marker exists", async () => {
    const filePath = await createTestFile("doc.md");
    const marker = await readSessionMarker(filePath, tmpDir);
    expect(marker).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// addFileToSessionManifest
// ---------------------------------------------------------------------------

describe("addFileToSessionManifest", () => {
  test("adds a new file to the manifest", async () => {
    const filePath1 = await createTestFile("a.md");
    const filePath2 = await createTestFile("b.md");

    const manifest = await loadOrCreateSessionManifest(filePath1, tmpDir);
    expect(manifest.files).toHaveLength(1);

    const updated = await addFileToSessionManifest(manifest, filePath2, tmpDir);
    expect(updated.files).toHaveLength(2);
    expect(updated.files.some((f) => f.filePath === filePath1)).toBe(true);
    expect(updated.files.some((f) => f.filePath === filePath2)).toBe(true);

    // Verify saved on disk
    const saved = await loadManifestDirect(updated.id, tmpDir);
    expect(saved!.files).toHaveLength(2);
  });

  test("updates timestamps for existing file", async () => {
    const filePath = await createTestFile("doc.md");

    const manifest = await loadOrCreateSessionManifest(filePath, tmpDir);
    const originalLastLoadedAt = manifest.files[0].lastLoadedAt;

    await new Promise((r) => setTimeout(r, 10));

    const updated = await addFileToSessionManifest(manifest, filePath, tmpDir);
    expect(updated.files).toHaveLength(1);
    expect(updated.files[0].lastLoadedAt).toBeGreaterThan(originalLastLoadedAt);
    expect(updated.files[0].firstLoadedAt).toBe(originalLastLoadedAt); // firstLoadedAt unchanged
  });
});

// ---------------------------------------------------------------------------
// discoverSessionFiles
// ---------------------------------------------------------------------------

describe("discoverSessionFiles", () => {
  test("reads only manifest files", async () => {
    const filePath1 = await createTestFile("a.md");
    const filePath2 = await createTestFile("b.md");

    const manifest = await loadOrCreateSessionManifest(filePath1, tmpDir);
    await addFileToSessionManifest(manifest, filePath2, tmpDir);

    const files = await discoverSessionFiles(manifest, tmpDir);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.filePath === filePath1)).toBe(true);
    expect(files.some((f) => f.filePath === filePath2)).toBe(true);
    expect(files[0].annotationCount).toBe(0);
    expect(files[0].isEntry).toBe(true);
    expect(files[1].isEntry).toBe(false);
  });

  test("skips deleted files", async () => {
    const filePath1 = await createTestFile("a.md");
    const filePath2 = await createTestFile("b.md");

    const manifest = await loadOrCreateSessionManifest(filePath1, tmpDir);
    await addFileToSessionManifest(manifest, filePath2, tmpDir);

    // Delete one file
    await rm(filePath2, { force: true });

    const files = await discoverSessionFiles(manifest, tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0].filePath).toBe(filePath1);
  });
});

// ---------------------------------------------------------------------------
// mergeSessions
// ---------------------------------------------------------------------------

describe("mergeSessions", () => {
  test("merges two sessions, older survives", async () => {
    const filePathA = await createTestFile("a.md");
    const filePathB = await createTestFile("b.md");

    // Create older session with A
    const now1 = Date.now();
    const manifestA: SessionManifest = {
      id: "aaaaaaaa",
      createdAt: now1,
      sessionRoot: fileDir,
      entryFilePath: filePathA,
      files: [
        { filePath: filePathA, firstLoadedAt: now1, lastLoadedAt: now1 },
      ],
      updatedAt: now1,
    };
    await saveSessionManifest(manifestA, tmpDir);
    await writeSessionMarkers(filePathA, tmpDir, manifestA.id);

    // Small delay
    await new Promise((r) => setTimeout(r, 10));

    // Create younger session with B
    const now2 = Date.now();
    const manifestB: SessionManifest = {
      id: "bbbbbbbb",
      createdAt: now2,
      sessionRoot: fileDir,
      entryFilePath: filePathB,
      files: [
        { filePath: filePathB, firstLoadedAt: now2, lastLoadedAt: now2 },
      ],
      updatedAt: now2,
    };
    await saveSessionManifest(manifestB, tmpDir);
    await writeSessionMarkers(filePathB, tmpDir, manifestB.id);

    // Merge — pass both file paths as owned (in a real scenario these would be locked files)
    const survivor = await mergeSessions(
      manifestA.id,
      manifestB.id,
      tmpDir,
      [filePathA, filePathB]
    );

    // Older (A) survives
    expect(survivor.id).toBe(manifestA.id);
    expect(survivor.createdAt).toBe(now1); // createdAt unchanged
    expect(survivor.files).toHaveLength(2);
    expect(survivor.files.some((f) => f.filePath === filePathA)).toBe(true);
    expect(survivor.files.some((f) => f.filePath === filePathB)).toBe(true);

    // Younger manifest deleted
    const gone = await loadManifestDirect(manifestB.id, tmpDir);
    expect(gone).toBeNull();

    // Markers re-pointed to survivor
    const markerA = await readSessionMarker(filePathA, tmpDir);
    const markerB = await readSessionMarker(filePathB, tmpDir);
    expect(markerA).toBe(manifestA.id);
    expect(markerB).toBe(manifestA.id);
  });

  test("merge is order-independent", async () => {
    const filePathA = await createTestFile("a.md");
    const filePathB = await createTestFile("b.md");

    const now1 = Date.now();
    const manifestA: SessionManifest = {
      id: "aaaaaaaa",
      createdAt: now1,
      sessionRoot: fileDir,
      entryFilePath: filePathA,
      files: [
        { filePath: filePathA, firstLoadedAt: now1, lastLoadedAt: now1 },
      ],
      updatedAt: now1,
    };
    await saveSessionManifest(manifestA, tmpDir);

    await new Promise((r) => setTimeout(r, 10));

    const now2 = Date.now();
    const manifestB: SessionManifest = {
      id: "bbbbbbbb",
      createdAt: now2,
      sessionRoot: fileDir,
      entryFilePath: filePathB,
      files: [
        { filePath: filePathB, firstLoadedAt: now2, lastLoadedAt: now2 },
      ],
      updatedAt: now2,
    };
    await saveSessionManifest(manifestB, tmpDir);

    // merge(A, B) should produce same survivor as merge(B, A)
    const survivor1 = await mergeSessions(manifestA.id, manifestB.id, tmpDir, [filePathA, filePathB]);
    expect(survivor1.id).toBe(manifestA.id);

    // Re-create B for second test (it was deleted by merge)
    await saveSessionManifest(manifestB, tmpDir);

    const survivor2 = await mergeSessions(manifestB.id, manifestA.id, tmpDir, [filePathA, filePathB]);
    expect(survivor2.id).toBe(manifestA.id);
  });

  test("throws when a manifest is missing", async () => {
    const filePath = await createTestFile("a.md");

    const now = Date.now();
    const manifest: SessionManifest = {
      id: "aaaaaaaa",
      createdAt: now,
      sessionRoot: fileDir,
      entryFilePath: filePath,
      files: [
        { filePath, firstLoadedAt: now, lastLoadedAt: now },
      ],
      updatedAt: now,
    };
    await saveSessionManifest(manifest, tmpDir);

    await expect(
      mergeSessions("aaaaaaaa", "nonexist", tmpDir, [])
    ).rejects.toThrow("Cannot merge: missing manifest");
  });
});

// ---------------------------------------------------------------------------
// Six-file merge test (explicit acceptance criterion)
// ---------------------------------------------------------------------------

describe("six-file merge", () => {
  test("session {A,B,C} (older) + {D,E,F} (younger) → one manifest with all six", async () => {
    // Create 6 test files
    const files = await Promise.all(
      ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"].map(
        (name) => createTestFile(name)
      )
    );

    // Create older session {A, B, C}
    const now1 = Date.now();
    const olderId = "older001";
    const olderManifest: SessionManifest = {
      id: olderId,
      createdAt: now1,
      sessionRoot: fileDir,
      entryFilePath: files[0]!,
      files: [
        { filePath: files[0]!, firstLoadedAt: now1, lastLoadedAt: now1 },
        { filePath: files[1]!, firstLoadedAt: now1, lastLoadedAt: now1 },
        { filePath: files[2]!, firstLoadedAt: now1, lastLoadedAt: now1 },
      ],
      updatedAt: now1,
    };
    await saveSessionManifest(olderManifest, tmpDir);
    for (const fp of [files[0]!, files[1]!, files[2]!]) {
      await writeSessionMarkers(fp, tmpDir, olderId);
    }

    await new Promise((r) => setTimeout(r, 10));

    // Create younger session {D, E, F}
    const now2 = Date.now();
    const youngerId = "younger01";
    const youngerManifest: SessionManifest = {
      id: youngerId,
      createdAt: now2,
      sessionRoot: fileDir,
      entryFilePath: files[3]!,
      files: [
        { filePath: files[3]!, firstLoadedAt: now2, lastLoadedAt: now2 },
        { filePath: files[4]!, firstLoadedAt: now2, lastLoadedAt: now2 },
        { filePath: files[5]!, firstLoadedAt: now2, lastLoadedAt: now2 },
      ],
      updatedAt: now2,
    };
    await saveSessionManifest(youngerManifest, tmpDir);
    for (const fp of [files[3]!, files[4]!, files[5]!]) {
      await writeSessionMarkers(fp, tmpDir, youngerId);
    }

    // Merge — pass all file paths as owned
    const survivor = await mergeSessions(olderId, youngerId, tmpDir, files);

    // (1) Exactly one session manifest remains, and it's the older id
    expect(survivor.id).toBe(olderId);

    // (2) The younger manifest file is gone
    const youngerGone = await loadManifestDirect(youngerId, tmpDir);
    expect(youngerGone).toBeNull();

    // (3) The surviving manifest's files is the union of all six
    expect(survivor.files).toHaveLength(6);
    const filePaths = survivor.files.map((f) => f.filePath).sort();
    const expectedPaths = [...files].sort();
    expect(filePaths).toEqual(expectedPaths);

    // (4) discoverSessionFiles returns all six
    const discovered = await discoverSessionFiles(survivor, tmpDir);
    expect(discovered).toHaveLength(6);

    // (5) The .session markers of A–F all point at the surviving id
    for (const fp of files) {
      const marker = await readSessionMarker(fp, tmpDir);
      expect(marker).toBe(olderId);
    }
  });
});

// ---------------------------------------------------------------------------
// Fresh mode
// ---------------------------------------------------------------------------

describe("fresh mode", () => {
  test("creates new manifest and removes from old", async () => {
    const filePath = await createTestFile("doc.md");

    // Create an existing manifest with this file
    const now1 = Date.now();
    const oldManifest: SessionManifest = {
      id: "oldsess01",
      createdAt: now1,
      sessionRoot: fileDir,
      entryFilePath: filePath,
      files: [
        { filePath, firstLoadedAt: now1, lastLoadedAt: now1 },
      ],
      updatedAt: now1,
    };
    await saveSessionManifest(oldManifest, tmpDir);
    await writeSessionMarkers(filePath, tmpDir, oldManifest.id);

    // Verify old session exists
    const oldExists = await loadManifestDirect(oldManifest.id, tmpDir);
    expect(oldExists).not.toBeNull();

    // Simulate fresh reset: detach from old manifest, create new one
    const oldSessionId = await readSessionMarker(filePath, tmpDir);
    expect(oldSessionId).toBe(oldManifest.id);

    // Remove from old manifest
    const oldM = await loadManifestDirect(oldSessionId!, tmpDir);
    if (oldM) {
      oldM.files = oldM.files.filter((f) => f.filePath !== filePath);
      if (oldM.files.length === 0) {
        await rm(manifestPathDirect(tmpDir, oldM.id), { force: true });
      } else {
        oldM.updatedAt = Date.now();
        await saveSessionManifest(oldM, tmpDir);
      }
    }

    // Create new manifest
    const now2 = Date.now();
    const newId = generateShortId();
    const newManifest: SessionManifest = {
      id: newId,
      createdAt: now2,
      sessionRoot: fileDir,
      entryFilePath: filePath,
      files: [
        { filePath, firstLoadedAt: now2, lastLoadedAt: now2 },
      ],
      updatedAt: now2,
    };
    await saveSessionManifest(newManifest, tmpDir);
    await writeSessionMarkers(filePath, tmpDir, newId);

    // Old manifest should be gone (it was empty)
    const oldGone = await loadManifestDirect(oldManifest.id, tmpDir);
    expect(oldGone).toBeNull();

    // New manifest should exist with only the entry file
    const newLoaded = await loadManifestDirect(newId, tmpDir);
    expect(newLoaded).not.toBeNull();
    expect(newLoaded!.files).toHaveLength(1);
    expect(newLoaded!.files[0].filePath).toBe(filePath);

    // Marker should point to new session
    const marker = await readSessionMarker(filePath, tmpDir);
    expect(marker).toBe(newId);
  });
});

// ---------------------------------------------------------------------------
// generateShortId
// ---------------------------------------------------------------------------

describe("generateShortId", () => {
  test("generates 8-char hex string", () => {
    const id = generateShortId();
    expect(id.length).toBe(8);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  test("generates unique ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateShortId());
    }
    expect(ids.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// saveSessionManifest / manifest persistence
// ---------------------------------------------------------------------------

describe("saveSessionManifest", () => {
  test("saves manifest atomically (no .tmp residue)", async () => {
    const filePath = await createTestFile("doc.md");
    const now = Date.now();
    const manifest: SessionManifest = {
      id: "test1234",
      createdAt: now,
      sessionRoot: fileDir,
      entryFilePath: filePath,
      files: [
        { filePath, firstLoadedAt: now, lastLoadedAt: now },
      ],
      updatedAt: now,
    };

    await saveSessionManifest(manifest, tmpDir);

    const sessionsDir = join(tmpDir, "sessions");
    const entries = await readdir(sessionsDir);
    const tmpFiles = entries.filter((e) => e.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);

    // Verify file exists
    const path = manifestPathDirect(tmpDir, manifest.id);
    const exists = await access(path).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cleanupFile
// ---------------------------------------------------------------------------

describe("cleanupFile", () => {
  test("removes .mdr file, annotation directory, and manifest entry", async () => {
    const filePath = await createTestFile("doc.md");
    const mdrPath = filePath.replace(/\.md$/, ".mdr");

    // Create a session with the file
    const manifest = await loadOrCreateSessionManifest(filePath, tmpDir);
    const sessionId = manifest.id;

    // Create a .mdr output file
    await writeFile(mdrPath, "# Review of doc.md");
    const mdrExistsBefore = await access(mdrPath).then(() => true).catch(() => false);
    expect(mdrExistsBefore).toBe(true);

    // Create some annotation files in the session dir
    const sessDir = sessionDir(filePath, tmpDir);
    await writeFile(join(sessDir, "abc123.json"), JSON.stringify({ id: "abc123" }));

    // Cleanup
    await cleanupFile(filePath, tmpDir);

    // .mdr file should be gone
    const mdrExistsAfter = await access(mdrPath).then(() => true).catch(() => false);
    expect(mdrExistsAfter).toBe(false);

    // Annotation directory should be gone
    const dirExists = await access(sessDir).then(() => true).catch(() => false);
    expect(dirExists).toBe(false);

    // Manifest should be deleted (was the only file)
    const manifestAfter = await loadManifestDirect(sessionId, tmpDir);
    expect(manifestAfter).toBeNull();
  });

  test("keeps manifest when other files remain after cleanup", async () => {
    const fileA = await createTestFile("a.md");
    const fileB = await createTestFile("b.md");

    // Create session with file A
    const manifestA = await loadOrCreateSessionManifest(fileA, tmpDir);
    // Add file B to the same session
    const manifestWithBoth = await addFileToSessionManifest(manifestA, fileB, tmpDir);
    // Write session markers for B so it's tracked
    await writeSessionMarkers(fileB, tmpDir, manifestWithBoth.id);

    expect(manifestWithBoth.files).toHaveLength(2);

    // Create .mdr for file A
    const mdrA = fileA.replace(/\.md$/, ".mdr");
    await writeFile(mdrA, "# Review of a.md");

    // Cleanup only file A
    await cleanupFile(fileA, tmpDir);

    // .mdr should be gone
    const mdrExists = await access(mdrA).then(() => true).catch(() => false);
    expect(mdrExists).toBe(false);

    // Manifest should still exist with only file B
    const manifestAfter = await loadManifestDirect(manifestWithBoth.id, tmpDir);
    expect(manifestAfter).not.toBeNull();
    expect(manifestAfter!.files).toHaveLength(1);
    expect(manifestAfter!.files[0].filePath).toBe(fileB);
  });

  test("is idempotent — safe to call when no session or .mdr exists", async () => {
    const filePath = await createTestFile("nope.md");

    // Should not throw even though there's no session data or .mdr
    await expect(cleanupFile(filePath, tmpDir)).resolves.toBeUndefined();
    await expect(cleanupFile(filePath, tmpDir)).resolves.toBeUndefined();
  });

  test("realpath normalization — cleanup resolves path before lookup", async () => {
    const filePath = await createTestFile("NormFile.md");
    const mdrPath = filePath.replace(/\.md$/i, ".mdr");

    // Create a session (stores realpath-normalized path)
    const manifest = await loadOrCreateSessionManifest(filePath, tmpDir);
    const sessionId = manifest.id;

    // Create .mdr and annotation files
    await writeFile(mdrPath, "# Review");
    const sessDir = sessionDir(filePath, tmpDir);
    await writeFile(join(sessDir, "norm123.json"), JSON.stringify({ id: "norm123" }));

    // On Windows, use a different-case path to exercise case-insensitive matching.
    // On Unix, realpath of the same path still validates the normalization path.
    const inputPath = process.platform === "win32"
      ? filePath.replace("NormFile.md", "normfile.md")
      : filePath;

    await cleanupFile(inputPath, tmpDir);

    // .mdr should be deleted
    const mdrExists = await access(mdrPath).then(() => true).catch(() => false);
    expect(mdrExists).toBe(false);

    // Annotation directory should be deleted
    const sessDirExists = await access(sessDir).then(() => true).catch(() => false);
    expect(sessDirExists).toBe(false);

    // Manifest should be deleted (only file)
    const manifestAfter = await loadManifestDirect(sessionId, tmpDir).catch(() => null);
    expect(manifestAfter).toBeNull();
  });
});
