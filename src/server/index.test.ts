import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm, chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "./index";
import { SessionLockedError } from "./annotation-service";
import type { RunningServer } from "./index";

describe("HTTP server & API routes", () => {
  let tmpDir: string;
  let mdPath: string;
  let server: RunningServer | null = null;

  const sampleMd = `# Hello

A paragraph.

- Item 1
- Item 2

\`\`\`js
const x = 1;
\`\`\`
`;

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
        // Ignore cleanup errors
      }
    }
  }

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `mdr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
    mdPath = join(tmpDir, "test.md");
    await writeFile(mdPath, sampleMd, "utf-8");
  });

  afterEach(async () => {
    await cleanup();
  });

  test("GET /api/markdown returns { source, blocks } with proper shapes", async () => {
    server = await startServer({ filePath: mdPath, tmpDir, port: 0 });
    const res = await fetch(`${server.url}/api/markdown`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.source).toBe(sampleMd);
    expect(Array.isArray(data.blocks)).toBe(true);
    expect(data.blocks.length).toBeGreaterThan(0);

    const block = data.blocks[0];
    expect(block.id).toBeDefined();
    expect(block.anchor).toBeDefined();
    expect(typeof block.anchor.siblingOrdinal).toBe("number");
    expect(block.type).toBeDefined();
    expect(block.text).toBeDefined();
    expect(block.html).toBeDefined();
  });

  test("GET /api/annotations returns { annotations }", async () => {
    server = await startServer({ filePath: mdPath, tmpDir, port: 0 });
    const res = await fetch(`${server.url}/api/annotations`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(Array.isArray(data.annotations)).toBe(true);
    expect(data.annotations.length).toBe(0);
  });

  test("POST /api/annotations creates, then DELETE removes", async () => {
    server = await startServer({ filePath: mdPath, tmpDir, port: 0 });

    // Fetch blocks to get a real anchor
    const mdRes = await fetch(`${server.url}/api/markdown`);
    const mdData = await mdRes.json();
    const headingBlock = mdData.blocks.find((b: any) => b.type === "heading");
    expect(headingBlock).toBeDefined();

    // Create annotation with a real anchor
    const createRes = await fetch(`${server.url}/api/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        anchor: headingBlock.anchor,
        blockType: headingBlock.type,
        blockText: headingBlock.text,
        blockLineRange: headingBlock.lineRange,
        comment: "Test comment",
      }),
    });
    expect(createRes.status).toBe(201);

    const createData = await createRes.json();
    expect(createData.annotation).toBeDefined();
    expect(createData.annotation.id).toBeDefined();
    expect(createData.annotation.comment).toBe("Test comment");
    const id = createData.annotation.id;

    // Verify it shows up in GET
    const listRes = await fetch(`${server.url}/api/annotations`);
    const listData = await listRes.json();
    expect(listData.annotations.length).toBe(1);
    expect(listData.annotations[0].status).toBeDefined();

    // Delete annotation
    const deleteRes = await fetch(`${server.url}/api/annotations/${id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);

    const deleteData = await deleteRes.json();
    expect(deleteData.ok).toBe(true);

    // Verify it's gone
    const listRes2 = await fetch(`${server.url}/api/annotations`);
    const listData2 = await listRes2.json();
    expect(listData2.annotations.length).toBe(0);
  });

  test("DELETE of missing id returns 404", async () => {
    server = await startServer({ filePath: mdPath, tmpDir, port: 0 });

    const res = await fetch(`${server.url}/api/annotations/nonexistent`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);

    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  test("forced-failure POST /api/done returns error body, server stays up", async () => {
    // Create a source file in a read-only directory to force writeReview failure
    const failDir = join(tmpDir, "readonly");
    await mkdir(failDir, { recursive: true });
    const failMdPath = join(failDir, "fail.md");
    await writeFile(failMdPath, "# Fail test\n\nContent.", "utf-8");

    // Make directory read-only so writeReview can't create _reviewed.md
    await chmod(failDir, 0o555);

    server = await startServer({ filePath: failMdPath, tmpDir, port: 0 });

    // POST /api/done should fail
    const res = await fetch(`${server.url}/api/done`, { method: "POST" });
    expect(res.status).toBe(500);

    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe("string");

    // Server should still be running
    const stillAlive = await fetch(`${server.url}/api/markdown`);
    expect(stillAlive.status).toBe(200);

    // Restore permissions for cleanup
    await chmod(failDir, 0o755);
  });

  test("success POST /api/done writes file, server stays up", async () => {
    // Use a fresh tmp dir for this test to avoid stale session data
    const freshDir = join(tmpdir(), `mdr-done-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(freshDir, { recursive: true });
    const doneMdPath = join(freshDir, "done.md");
    await writeFile(doneMdPath, "# Done test\n\nSome content.", "utf-8");

    server = await startServer({ filePath: doneMdPath, tmpDir: freshDir, port: 0 });

    // Fetch blocks to get a real anchor
    const doneMdRes = await fetch(`${server.url}/api/markdown`);
    const doneMdData = await doneMdRes.json();
    const doneHeadingBlock = doneMdData.blocks.find((b: any) => b.type === "heading");
    expect(doneHeadingBlock).toBeDefined();

    // Add an annotation with a real anchor
    const createRes = await fetch(`${server.url}/api/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        anchor: doneHeadingBlock.anchor,
        blockType: doneHeadingBlock.type,
        blockText: doneHeadingBlock.text,
        blockLineRange: doneHeadingBlock.lineRange,
        comment: "Final comment",
      }),
    });
    expect(createRes.status).toBe(201);

    // POST /api/done — should succeed and NOT shut down the server
    const doneRes = await fetch(`${server.url}/api/done`, { method: "POST" });
    expect(doneRes.status).toBe(200);

    const doneData = await doneRes.json();
    expect(doneData.ok).toBe(true);
    expect(typeof doneData.path).toBe("string");
    expect(doneData.path).toContain(".mdr");

    // Verify the file was written
    const content = await readFile(doneData.path, "utf-8");
    expect(content).toContain("Review of done.md");
    expect(content).toContain("Final comment");

    // Server should still be running (no longer shuts down on done)
    const stillAlive = await fetch(`${server.url}/api/markdown`);
    expect(stillAlive.status).toBe(200);

    // Cleanup
    try {
      await rm(freshDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  test("GET /api/reviewed-files returns files with annotations", async () => {
    server = await startServer({ filePath: mdPath, tmpDir, port: 0 });

    // Initially no annotations, so no reviewed files
    const res1 = await fetch(`${server.url}/api/reviewed-files`);
    expect(res1.status).toBe(200);
    const data1 = await res1.json();
    expect(data1.files.length).toBe(0);

    // Add an annotation
    const mdRes = await fetch(`${server.url}/api/markdown`);
    const mdData = await mdRes.json();
    const headingBlock = mdData.blocks.find((b: any) => b.type === "heading");

    await fetch(`${server.url}/api/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        anchor: headingBlock.anchor,
        blockType: headingBlock.type,
        blockText: headingBlock.text,
        blockLineRange: headingBlock.lineRange,
        comment: "Test annotation",
      }),
    });

    // Now should have one reviewed file
    const res2 = await fetch(`${server.url}/api/reviewed-files`);
    expect(res2.status).toBe(200);
    const data2 = await res2.json();
    expect(data2.files.length).toBe(1);
    expect(data2.files[0].key).toBe("test.md");
    expect(data2.files[0].reviewedPath).toContain(".mdr");
    expect(data2.files[0].sourcePath).toContain("test.md");
    expect(data2.files[0].annotationCount).toBe(1);
  });

  test("GET /api/ping returns ok and tracks last ping", async () => {
    server = await startServer({ filePath: mdPath, tmpDir, port: 0 });

    const res = await fetch(`${server.url}/api/ping`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  test("binds to localhost by default", async () => {
    server = await startServer({ filePath: mdPath, tmpDir, port: 0 });

    expect(server.host).toBe("127.0.0.1");
    expect(server.url).toBe(`http://localhost:${server.port}`);
  });

  test("--lan binds to all interfaces but keeps local browser URL", async () => {
    server = await startServer({ filePath: mdPath, tmpDir, port: 0, lan: true });

    expect(server.host).toBe("0.0.0.0");
    expect(server.url).toBe(`http://localhost:${server.port}`);
  });

  test("--lan allows configured Host headers plus local browser host", async () => {
    server = await startServer({
      filePath: mdPath,
      tmpDir,
      port: 0,
      lan: true,
      allowedHosts: ["dev-machine"],
    });

    const localRes = await fetch(`${server.url}/api/markdown`);
    expect(localRes.status).toBe(200);

    const lanRes = await fetch(`${server.url}/api/markdown`, {
      headers: { Host: `dev-machine:${server.port}` },
    });
    expect(lanRes.status).toBe(200);
  });

  test("--lan rejects unexpected Host headers when an allow-list is configured", async () => {
    server = await startServer({
      filePath: mdPath,
      tmpDir,
      port: 0,
      lan: true,
      allowedHosts: ["dev-machine"],
    });

    const res = await fetch(`${server.url}/api/markdown`, {
      headers: { Host: "evil.example" },
    });
    expect(res.status).toBe(403);

    const wrongPortRes = await fetch(`${server.url}/api/markdown`, {
      headers: { Host: "dev-machine:1" },
    });
    expect(wrongPortRes.status).toBe(403);
  });

  test("session lock: second server on same file throws locked error", async () => {
    server = await startServer({ filePath: mdPath, tmpDir, port: 0 });

    // Try to start a second server on the same file
    await expect(
      startServer({ filePath: mdPath, tmpDir, port: 0 })
    ).rejects.toThrow(SessionLockedError);
  });

  test("GET / injects file name into data-file-name attribute", async () => {
    // Use a file with a distinctive name
    const namedPath = join(tmpDir, "my-proposal.md");
    await writeFile(namedPath, sampleMd, "utf-8");

    server = await startServer({ filePath: namedPath, tmpDir, port: 0 });

    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain('data-file-name="my-proposal.md"');
  });

  // R2: heartbeat self-shutdown test — verifies the server actually shuts down
  // after the configured timeout when no pings arrive (grace timeout path)
  test("heartbeat: server shuts down after grace timeout with no pings", async () => {
    const srv = await startServer({
      filePath: mdPath,
      tmpDir,
      port: 0,
      graceTimeout: 1500,     // 1.5s grace for testing
      heartbeatInterval: 250, // check every 250ms
    });

    // Verify server is running (use /api/markdown, not /api/ping — ping would reset grace)
    const res = await fetch(`${srv.url}/api/markdown`);
    expect(res.status).toBe(200);

    // Wait for self-shutdown via stopped promise
    await expect(Promise.race([
      srv.stopped,
      new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown timeout")), 5000)),
    ])).resolves.toBeUndefined();
  }, 10000);

  // R2: heartbeat shutdown after ping + silence
  test("heartbeat: server shuts down after heartbeat timeout following a ping", async () => {
    const srv = await startServer({
      filePath: mdPath,
      tmpDir,
      port: 0,
      heartbeatTimeout: 1500,  // 1.5s timeout for testing
      heartbeatInterval: 250,  // check every 250ms
      graceTimeout: 60000,     // long grace so it doesn't interfere
    });

    // Ping to start the heartbeat clock
    const res = await fetch(`${srv.url}/api/ping`);
    expect(res.status).toBe(200);

    // Wait for self-shutdown via stopped promise
    await expect(Promise.race([
      srv.stopped,
      new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown timeout")), 5000)),
    ])).resolves.toBeUndefined();
  }, 10000);
});
