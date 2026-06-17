import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { autoDiscover, type ManifestRef } from "./file-crawler";
import { createMutex } from "./manifest-mutex";
import {
  loadOrCreateSessionManifest,
  addFileToSessionManifest,
  saveSessionManifest,
  writeSessionMarkers,
  readSessionMarker,
  generateShortId,
  type SessionManifest,
} from "./session-manifest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Real mutex — uncontended in these single-threaded unit tests.
const noopMutex = createMutex();

async function createFixture(
  tmpDir: string,
  files: Record<string, string>,
): Promise<Record<string, string>> {
  const paths: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    const path = join(tmpDir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
    // Store realpath'd version so comparisons work across /tmp ↔ /private/tmp
    paths[name] = await realpath(path);
  }
  return paths;
}

async function cleanup(tmpDir: string): Promise<void> {
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

/** Resolve all manifest file paths to realpaths for comparison. */
function toRealPaths(manifest: SessionManifest): Promise<string[]> {
  return Promise.all(manifest.files.map(async (f) => realpath(f.filePath).catch(() => f.filePath)));
}

// ---------------------------------------------------------------------------
// Tests: autoDiscover (unit-level)
// ---------------------------------------------------------------------------

describe("autoDiscover", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `mdr-crawler-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanup(tmpDir);
  });

  test("basic crawl: entry → B → C registers all three", async () => {
    const paths = await createFixture(tmpDir, {
      "a.md": `# A\n\nSee [B](b.md) and [C](c.md).`,
      "b.md": `# B\n\nBack to [A](a.md).`,
      "c.md": `# C\n\nLinked from A.`,
    });

    // Create manifest for entry file (uses non-realpath'd path)
    const manifest = await loadOrCreateSessionManifest(paths["a.md"], tmpDir);
    const manifestRef: ManifestRef = {
      get: () => manifest,
      set: (m) => { Object.assign(manifest, m); },
    };

    await autoDiscover(paths["a.md"], tmpDir, tmpDir, manifestRef, noopMutex);

    const filePaths = await toRealPaths(manifestRef.get());
    expect(filePaths).toContain(paths["a.md"]);
    expect(filePaths).toContain(paths["b.md"]);
    expect(filePaths).toContain(paths["c.md"]);
    expect(manifestRef.get().files.length).toBe(3);
  });

  test("cycle safety: A ↔ B each processed once", async () => {
    const paths = await createFixture(tmpDir, {
      "a.md": `# A\n\nSee [B](b.md).`,
      "b.md": `# B\n\nSee [A](a.md).`,
    });

    const manifest = await loadOrCreateSessionManifest(paths["a.md"], tmpDir);
    const manifestRef: ManifestRef = {
      get: () => manifest,
      set: (m) => { Object.assign(manifest, m); },
    };

    await autoDiscover(paths["a.md"], tmpDir, tmpDir, manifestRef, noopMutex);

    const filePaths = await toRealPaths(manifestRef.get());
    expect(filePaths).toContain(paths["a.md"]);
    expect(filePaths).toContain(paths["b.md"]);
    // Each appears exactly once
    expect(filePaths.filter((p) => p === paths["a.md"]).length).toBe(1);
    expect(filePaths.filter((p) => p === paths["b.md"]).length).toBe(1);
    expect(manifestRef.get().files.length).toBe(2);
  });

  test("non-.md files are not followed", async () => {
    const paths = await createFixture(tmpDir, {
      "a.md": `# A\n\nSee [text](text.txt) and [mdr](note.mdr).`,
      "text.txt": "plain text file",
      "note.mdr": "reviewed markdown",
    });

    const manifest = await loadOrCreateSessionManifest(paths["a.md"], tmpDir);
    const manifestRef: ManifestRef = {
      get: () => manifest,
      set: (m) => { Object.assign(manifest, m); },
    };

    await autoDiscover(paths["a.md"], tmpDir, tmpDir, manifestRef, noopMutex);

    // Only a.md should be registered (detectMdLinks filters non-.md)
    expect(manifestRef.get().files.length).toBe(1);
  });

  test("parse failure is non-fatal: crawl continues past broken file", async () => {
    const paths = await createFixture(tmpDir, {
      "a.md": `# A\n\nSee [broken](broken.md) and [ok](ok.md).`,
      "broken.md": `# Broken\n\nSee [ok](ok.md).`,
      "ok.md": `# OK\n\nThis file is fine.`,
    });

    const manifest = await loadOrCreateSessionManifest(paths["a.md"], tmpDir);
    const manifestRef: ManifestRef = {
      get: () => manifest,
      set: (m) => { Object.assign(manifest, m); },
    };

    // Should not throw — all files parse fine in this case
    await autoDiscover(paths["a.md"], tmpDir, tmpDir, manifestRef, noopMutex);

    const filePaths = await toRealPaths(manifestRef.get());
    expect(filePaths).toContain(paths["a.md"]);
    expect(filePaths).toContain(paths["broken.md"]);
    expect(filePaths).toContain(paths["ok.md"]);
  });

  test("session merge during crawl: discovered file in another session", async () => {
    const paths = await createFixture(tmpDir, {
      "a.md": `# A\n\nSee [B](b.md).`,
      "b.md": `# B\n\nLinked from A.`,
    });

    // Create a separate session for b.md first (older session)
    const now = Date.now();
    const oldId = generateShortId();
    const oldManifest: SessionManifest = {
      id: oldId,
      createdAt: now - 1000, // older
      sessionRoot: tmpDir,
      entryFilePath: paths["b.md"],
      files: [
        { filePath: paths["b.md"], firstLoadedAt: now - 1000, lastLoadedAt: now - 1000 },
      ],
      updatedAt: now - 1000,
    };
    await saveSessionManifest(oldManifest, tmpDir);
    await writeSessionMarkers(paths["b.md"], tmpDir, oldId);

    // Now create manifest for a.md (newer session)
    const manifest = await loadOrCreateSessionManifest(paths["a.md"], tmpDir);
    const manifestRef: ManifestRef = {
      get: () => manifest,
      set: (m) => { Object.assign(manifest, m); },
    };

    await autoDiscover(paths["a.md"], tmpDir, tmpDir, manifestRef, noopMutex);

    // After merge, the older session (oldId) should survive
    const finalManifest = manifestRef.get();
    expect(finalManifest.id).toBe(oldId);
    const filePaths = await toRealPaths(finalManifest);
    expect(filePaths).toContain(paths["a.md"]);
    expect(filePaths).toContain(paths["b.md"]);
  });

  test("stale session marker does not block discovered file registration", async () => {
    const paths = await createFixture(tmpDir, {
      "a.md": `# A\n\nSee [B](b.md).`,
      "b.md": `# B\n\nLinked from A.`,
    });

    await writeSessionMarkers(paths["b.md"], tmpDir, "deadbeef");

    const manifest = await loadOrCreateSessionManifest(paths["a.md"], tmpDir);
    const manifestRef: ManifestRef = {
      get: () => manifest,
      set: (m) => { Object.assign(manifest, m); },
    };

    await autoDiscover(paths["a.md"], tmpDir, tmpDir, manifestRef, noopMutex);

    const filePaths = await toRealPaths(manifestRef.get());
    expect(filePaths).toContain(paths["a.md"]);
    expect(filePaths).toContain(paths["b.md"]);
    expect(await readSessionMarker(paths["b.md"], tmpDir)).toBe(manifestRef.get().id);
  });

  test("entry file already in manifest: no duplicates", async () => {
    const paths = await createFixture(tmpDir, {
      "a.md": `# A\n\nSelf-reference [A](a.md).`,
    });

    const manifest = await loadOrCreateSessionManifest(paths["a.md"], tmpDir);
    const manifestRef: ManifestRef = {
      get: () => manifest,
      set: (m) => { Object.assign(manifest, m); },
    };

    await autoDiscover(paths["a.md"], tmpDir, tmpDir, manifestRef, noopMutex);

    // Entry file should appear exactly once
    expect(manifestRef.get().files.length).toBe(1);
  });

  test("non-existent link target is skipped gracefully", async () => {
    const paths = await createFixture(tmpDir, {
      "a.md": `# A\n\nSee [missing](missing.md).`,
    });

    const manifest = await loadOrCreateSessionManifest(paths["a.md"], tmpDir);
    const manifestRef: ManifestRef = {
      get: () => manifest,
      set: (m) => { Object.assign(manifest, m); },
    };

    // Should not throw even though missing.md doesn't exist
    await autoDiscover(paths["a.md"], tmpDir, tmpDir, manifestRef, noopMutex);

    expect(manifestRef.get().files.length).toBe(1);
  });

  test("deep chain: A → B → C → D → E", async () => {
    const paths = await createFixture(tmpDir, {
      "a.md": `# A\n\n[B](b.md)`,
      "b.md": `# B\n\n[C](c.md)`,
      "c.md": `# C\n\n[D](d.md)`,
      "d.md": `# D\n\n[E](e.md)`,
      "e.md": `# E\n\nEnd of chain.`,
    });

    const manifest = await loadOrCreateSessionManifest(paths["a.md"], tmpDir);
    const manifestRef: ManifestRef = {
      get: () => manifest,
      set: (m) => { Object.assign(manifest, m); },
    };

    await autoDiscover(paths["a.md"], tmpDir, tmpDir, manifestRef, noopMutex);

    const filePaths = await toRealPaths(manifestRef.get());
    expect(filePaths).toContain(paths["a.md"]);
    expect(filePaths).toContain(paths["b.md"]);
    expect(filePaths).toContain(paths["c.md"]);
    expect(filePaths).toContain(paths["d.md"]);
    expect(filePaths).toContain(paths["e.md"]);
    expect(manifestRef.get().files.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Tests: server-level (autoDiscover flag)
// ---------------------------------------------------------------------------

const { startServer: _startServer } = await import("./index");
type RunningServer = Awaited<ReturnType<typeof _startServer>>;

describe("server --auto-discover", () => {
  let tmpDir: string;
  let server: RunningServer | null = null;

  async function cleanup() {
    if (server) {
      try {
        await server.stop();
      } catch {
        // Server may already be stopped
      }
      server = null;
    }
    if (tmpDir) {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  }

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `mdr-server-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanup();
  });

  test("off by default: only entry file in session", async () => {
    await mkdir(join(tmpDir, "docs"), { recursive: true });
    const entryPath = join(tmpDir, "docs", "entry.md");
    await writeFile(entryPath, `# Entry\n\n[Other](other.md).`, "utf-8");
    await writeFile(join(tmpDir, "docs", "other.md"), `# Other`, "utf-8");

    server = await _startServer({ filePath: entryPath, tmpDir, port: 0 });

    // Give a moment for any background work
    await new Promise((r) => setTimeout(r, 500));

    const res = await fetch(`${server.url}/api/session-files`);
    const data = await res.json();

    // Without autoDiscover, only the entry file should be in the session
    expect(data.files.length).toBe(1);
    expect(data.discovering).toBeUndefined();
  });

  test("with --auto-discover: all linked files appear after crawl", async () => {
    await mkdir(join(tmpDir, "docs"), { recursive: true });
    const entryPath = join(tmpDir, "docs", "entry.md");
    await writeFile(entryPath, `# Entry\n\n[Alpha](alpha.md) and [Beta](beta.md).`, "utf-8");
    await writeFile(join(tmpDir, "docs", "alpha.md"), `# Alpha\n\nBack to [Entry](entry.md).`, "utf-8");
    await writeFile(join(tmpDir, "docs", "beta.md"), `# Beta\n\nLinked from Entry.`, "utf-8");

    server = await _startServer({
      filePath: entryPath,
      tmpDir,
      port: 0,
      autoDiscover: true,
    });

    // Wait for the background crawl to complete (give it generous time)
    await new Promise((r) => setTimeout(r, 2000));

    const res = await fetch(`${server.url}/api/session-files`);
    const data = await res.json();

    expect(data.discovering).toBe(false);
    expect(data.files.length).toBe(3);

    const names = data.files.map((f: any) => f.fileName);
    expect(names).toContain("entry.md");
    expect(names).toContain("alpha.md");
    expect(names).toContain("beta.md");
  });

  test("navigation works after auto-discover merges into an older session", async () => {
    await mkdir(join(tmpDir, "docs"), { recursive: true });
    const entryPath = join(tmpDir, "docs", "entry.md");
    const linkedPath = join(tmpDir, "docs", "linked.md");
    await writeFile(entryPath, `# Entry\n\n[Linked](linked.md).`, "utf-8");
    await writeFile(linkedPath, `# Linked\n\nBack to [Entry](entry.md).`, "utf-8");

    const linkedRealPath = await realpath(linkedPath);
    const now = Date.now();
    const oldId = "old00001";
    const oldManifest: SessionManifest = {
      id: oldId,
      createdAt: now - 1000,
      sessionRoot: await realpath(join(tmpDir, "docs")),
      entryFilePath: linkedRealPath,
      files: [
        { filePath: linkedRealPath, firstLoadedAt: now - 1000, lastLoadedAt: now - 1000 },
      ],
      updatedAt: now - 1000,
    };
    await saveSessionManifest(oldManifest, tmpDir);
    await writeSessionMarkers(linkedRealPath, tmpDir, oldId);

    server = await _startServer({
      filePath: entryPath,
      tmpDir,
      port: 0,
      autoDiscover: true,
    });

    await new Promise((r) => setTimeout(r, 2000));

    const res = await fetch(`${server.url}/api/files/${encodeURIComponent("linked.md")}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.fileName).toBe("linked.md");
  });

  test("navigation ignores stale markers that point at missing manifests", async () => {
    await mkdir(join(tmpDir, "docs"), { recursive: true });
    const entryPath = join(tmpDir, "docs", "entry.md");
    const linkedPath = join(tmpDir, "docs", "linked.md");
    await writeFile(entryPath, `# Entry\n\n[Linked](linked.md).`, "utf-8");
    await writeFile(linkedPath, `# Linked`, "utf-8");

    const manifest = await loadOrCreateSessionManifest(await realpath(entryPath), tmpDir);
    await addFileToSessionManifest(manifest, await realpath(linkedPath), tmpDir);
    await writeSessionMarkers(await realpath(linkedPath), tmpDir, "deadbeef");

    server = await _startServer({ filePath: entryPath, tmpDir, port: 0 });

    const res = await fetch(`${server.url}/api/files/${encodeURIComponent("linked.md")}`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.fileName).toBe("linked.md");
    expect(await readSessionMarker(await realpath(linkedPath), tmpDir)).toBe(
      await readSessionMarker(await realpath(entryPath), tmpDir)
    );
  });

  test("discovering flag is boolean when autoDiscover is set", async () => {
    await mkdir(join(tmpDir, "docs"), { recursive: true });
    const entryPath = join(tmpDir, "docs", "entry.md");
    await writeFile(entryPath, `# Entry\n\n[F2](f2.md) and [F3](f3.md).`, "utf-8");
    await writeFile(join(tmpDir, "docs", "f2.md"), `# F2`, "utf-8");
    await writeFile(join(tmpDir, "docs", "f3.md"), `# F3`, "utf-8");

    server = await _startServer({
      filePath: entryPath,
      tmpDir,
      port: 0,
      autoDiscover: true,
    });

    // Immediately check — discovering should be a boolean
    const res = await fetch(`${server.url}/api/session-files`);
    const data = await res.json();

    expect(typeof data.discovering).toBe("boolean");
  });
});
