import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openSession,
  SessionLockedError,
  type Session,
} from "./annotation-service";
import type { Annotation } from "../shared/types";

let tmpDir: string;
let session: Session | null = null;

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: overrides.id ?? "test-abc123",
    anchor: overrides.anchor ?? {
      blockType: "heading",
      textHash: "9f2a",
      siblingOrdinal: 0,
    },
    blockType: overrides.blockType ?? "heading",
    blockText: overrides.blockText ?? "# Introduction",
    blockLineRange: overrides.blockLineRange ?? [1, 2],
    comment: overrides.comment ?? "Test comment",
    status: overrides.status ?? "ok",
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
  };
}

beforeEach(async () => {
  // Create a unique temp dir for each test
  tmpDir = join(tmpdir(), `mdr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  // Release any open session
  if (session) {
    await session.release();
    session = null;
  }
  // Clean up temp dir
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Round-trip: save then list
// ---------------------------------------------------------------------------

describe("round-trip", () => {
  test("save then list returns annotation with stable id", async () => {
    session = await openSession(join(tmpDir, "doc.md"), { tmpDir });

    const saved = await session.save(makeAnnotation());
    expect(saved.id).toBe("test-abc123");

    const list = await session.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("test-abc123");
    expect(list[0].comment).toBe("Test comment");
    expect(list[0].createdAt).toBeGreaterThan(0);
    expect(list[0].updatedAt).toBeGreaterThan(0);
  });

  test("save without id generates one", async () => {
    session = await openSession(join(tmpDir, "doc.md"), { tmpDir });

    const annotation = makeAnnotation({ id: undefined as any });
    const saved = await session.save(annotation);
    expect(saved.id).toBeDefined();
    expect(saved.id).not.toBe("");
    expect(saved.id.length).toBeGreaterThan(0);

    const list = await session.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(saved.id);
  });
});

// ---------------------------------------------------------------------------
// Update in place
// ---------------------------------------------------------------------------

describe("update in place", () => {
  test("save with existing id updates, bumps updatedAt, preserves createdAt", async () => {
    session = await openSession(join(tmpDir, "doc.md"), { tmpDir });

    const original = await session.save(makeAnnotation());
    const originalCreatedAt = original.createdAt;

    // Wait a tick to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));

    const updated = await session.save({
      ...original,
      comment: "Updated comment",
    });

    expect(updated.id).toBe(original.id);
    expect(updated.createdAt).toBe(originalCreatedAt);
    expect(updated.updatedAt).toBeGreaterThan(original.updatedAt);
    expect(updated.comment).toBe("Updated comment");

    const list = await session.list();
    expect(list).toHaveLength(1);
    expect(list[0].comment).toBe("Updated comment");
    expect(list[0].createdAt).toBe(originalCreatedAt);
  });
});

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

describe("remove", () => {
  test("deletes only the targeted file", async () => {
    session = await openSession(join(tmpDir, "doc.md"), { tmpDir });

    await session.save(makeAnnotation({ id: "a1" }));
    await session.save(makeAnnotation({ id: "a2" }));
    await session.save(makeAnnotation({ id: "a3" }));

    expect(await session.list()).toHaveLength(3);

    await session.remove("a2");

    const list = await session.list();
    expect(list).toHaveLength(2);
    const ids = list.map((a) => a.id).sort();
    expect(ids).toEqual(["a1", "a3"]);
  });

  test("remove is idempotent (no error if already gone)", async () => {
    session = await openSession(join(tmpDir, "doc.md"), { tmpDir });

    await session.save(makeAnnotation({ id: "a1" }));
    await session.remove("a1");
    await session.remove("a1"); // should not throw

    expect(await session.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

describe("atomicity", () => {
  test("no *.tmp residue after save", async () => {
    session = await openSession(join(tmpDir, "doc.md"), { tmpDir });

    await session.save(makeAnnotation());

    const entries = await readdir(session.dir);
    const tmpFiles = entries.filter((e) => e.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lock management
// ---------------------------------------------------------------------------

describe("lock", () => {
  test("second openSession against a live lock throws SessionLockedError", async () => {
    const first = await openSession(join(tmpDir, "doc.md"), { tmpDir });

    try {
      let thrown: any;
      try {
        await openSession(join(tmpDir, "doc.md"), { tmpDir });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SessionLockedError);
    } finally {
      await first.release();
    }
  });

  test("SessionLockedError includes holding PID", async () => {
    const first = await openSession(join(tmpDir, "doc.md"), { tmpDir });

    try {
      let thrown: SessionLockedError | undefined;
      try {
        await openSession(join(tmpDir, "doc.md"), { tmpDir });
      } catch (e: any) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SessionLockedError);
      expect(thrown!.holdingPid).toBe(process.pid);
    } finally {
      await first.release();
    }
  });

  test("stale lock (dead PID) is reclaimed", async () => {
    // First open a session to create the dir, then write a stale lock
    const filePath = join(tmpDir, "doc.md");
    const first = await openSession(filePath, { tmpDir });
    await first.release();

    // Now write a lock file with a dead PID
    const lockPath = join(first.dir, ".lock");
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999999, timestamp: Date.now() }),
      "utf-8"
    );

    // openSession should reclaim the stale lock
    session = await openSession(filePath, { tmpDir });
    expect(session.dir).toBeDefined();

    // Should be able to use the session
    await session.save(makeAnnotation());
    expect(await session.list()).toHaveLength(1);
  });

  test("release is idempotent", async () => {
    session = await openSession(join(tmpDir, "doc.md"), { tmpDir });

    await session.release();
    await session.release(); // should not throw
  });
});

// ---------------------------------------------------------------------------
// Fresh mode
// ---------------------------------------------------------------------------

describe("fresh mode", () => {
  test("fresh: true empties previously-populated session", async () => {
    // First, populate the session
    session = await openSession(join(tmpDir, "doc.md"), { tmpDir });
    await session.save(makeAnnotation({ id: "old1" }));
    await session.save(makeAnnotation({ id: "old2" }));
    expect(await session.list()).toHaveLength(2);
    await session.release();
    session = null;

    // Re-open with fresh: true
    session = await openSession(join(tmpDir, "doc.md"), { tmpDir, fresh: true });
    expect(await session.list()).toHaveLength(0);

    // Can save new annotations
    await session.save(makeAnnotation({ id: "new1" }));
    expect(await session.list()).toHaveLength(1);
    expect(session.list()).resolves.toHaveLength(1);
  });

  test("fresh: true preserves .lock file (regression)", async () => {
    // Populate the session
    session = await openSession(join(tmpDir, "doc.md"), { tmpDir });
    await session.save(makeAnnotation({ id: "old1" }));
    await session.release();
    session = null;

    // Re-open with fresh: true — .lock must survive the wipe
    session = await openSession(join(tmpDir, "doc.md"), { tmpDir, fresh: true });
    const lockPath = join(session.dir, ".lock");
    const lockExists = await access(lockPath).then(() => true).catch(() => false);
    expect(lockExists).toBe(true);

    // A second openSession should be blocked by the lock
    await expect(
      openSession(join(tmpDir, "doc.md"), { tmpDir })
    ).rejects.toThrow(SessionLockedError);
  });
});

// ---------------------------------------------------------------------------
// Resilience
// ---------------------------------------------------------------------------

describe("resilience", () => {
  test("list skips corrupt annotation files", async () => {
    session = await openSession(join(tmpDir, "doc.md"), { tmpDir });

    // Save a valid annotation
    await session.save(makeAnnotation({ id: "valid1" }));

    // Write a corrupt file manually
    const corruptPath = join(session.dir, "corrupt.json");
    await writeFile(corruptPath, "{ not valid json", "utf-8");

    // list should still work, returning only the valid one
    const list = await session.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("valid1");
  });
});
