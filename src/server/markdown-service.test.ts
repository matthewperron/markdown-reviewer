import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { parseDocument, loadDocument, detectMdLinks, markNavigationalLinks } from "./markdown-service";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkRehype from "remark-rehype";
import { toHtml } from "hast-util-to-html";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { realpath } from "node:fs/promises";

describe("parseDocument", () => {
  test("returns source, blocks, and fullHtml", () => {
    const source = "# Hello\n\nWorld";
    const { source: returnedSource, blocks, fullHtml } = parseDocument(source);
    expect(returnedSource).toBe(source);
    expect(blocks.length).toBeGreaterThan(0);
    expect(fullHtml).toContain("<h1");
    expect(fullHtml).toContain("<p");
  });

  test("fullHtml contains structurally correct tables", () => {
    const source = "| A | B |\n|---|---|\n| 1 | 2 |";
    const { fullHtml } = parseDocument(source);
    expect(fullHtml).toContain("<table");
    expect(fullHtml).toContain("<thead");
    expect(fullHtml).toContain("<tbody");
    expect(fullHtml).toContain("<tr");
    expect(fullHtml).toContain("<th ");
    expect(fullHtml).toContain("<td ");
  });

  test("fullHtml contains nested lists", () => {
    const source = "- Item 1\n  - Nested 1\n- Item 2";
    const { fullHtml } = parseDocument(source);
    expect(fullHtml).toContain("<ul");
    expect(fullHtml).toContain("<li");
  });

  test("renders headings with data-block-id", () => {
    const { blocks } = parseDocument("# Hello\n\n## World");
    const headingBlocks = blocks.filter((b) => b.type === "heading");
    expect(headingBlocks).toHaveLength(2);
    for (const block of headingBlocks) {
      expect(block.html).toContain(`data-block-id="${block.id}"`);
    }
  });

  test("renders paragraphs with data-block-id", () => {
    const { blocks } = parseDocument("Hello world\n\nFoo bar");
    const paraBlocks = blocks.filter((b) => b.type === "paragraph");
    expect(paraBlocks).toHaveLength(2);
    for (const block of paraBlocks) {
      expect(block.html).toContain(`data-block-id="${block.id}"`);
    }
  });

  test("renders list items with data-block-id on <li>", () => {
    const { blocks } = parseDocument("- Item one\n- Item two");
    const liBlocks = blocks.filter((b) => b.type === "listItem");
    expect(liBlocks).toHaveLength(2);
    for (const block of liBlocks) {
      expect(block.html).toContain(`data-block-id="${block.id}"`);
      // data-block-id should be on the <li> element
      expect(block.html).toMatch(/<li[^>]*data-block-id/);
    }
  });

  test("renders code blocks with data-block-id", () => {
    const { blocks } = parseDocument("```\ncode here\n```");
    const codeBlocks = blocks.filter((b) => b.type === "code");
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0].html).toContain(`data-block-id="${codeBlocks[0].id}"`);
  });

  test("highlights code blocks with explicit language classes", () => {
    const source = "```ts\nexport function greet(name: string) { return name; }\n```";
    const { blocks, fullHtml } = parseDocument(source);
    const code = blocks.find((b) => b.type === "code");

    expect(code).toBeDefined();
    expect(code!.html).toContain("hljs language-ts");
    expect(code!.html).toContain("hljs-title function_");
    expect(fullHtml).toContain("hljs-keyword");
  });

  test("auto-detects and highlights unlabeled code blocks", () => {
    const source = "```\nfunction greet(name) { return name; }\n```";
    const { blocks } = parseDocument(source);
    const code = blocks.find((b) => b.type === "code");

    expect(code).toBeDefined();
    expect(code!.html).toContain("hljs");
    expect(code!.html).toContain("language-");
    expect(code!.html).toContain("<span");
  });

  test("leaves explicit plain text code blocks unhighlighted", () => {
    const source = "```text\nthis is an example, not executable code\n```";
    const { blocks } = parseDocument(source);
    const code = blocks.find((b) => b.type === "code");

    expect(code).toBeDefined();
    expect(code!.html).toContain("language-text");
    expect(code!.html).not.toContain("hljs");
    expect(code!.html).not.toContain("<span");
  });

  test("renders blockquotes with data-block-id", () => {
    const { blocks } = parseDocument("> This is a quote");
    const bqBlocks = blocks.filter((b) => b.type === "blockquote");
    expect(bqBlocks).toHaveLength(1);
    expect(bqBlocks[0].html).toContain(`data-block-id="${bqBlocks[0].id}"`);
  });

  test("renders table cells with data-block-id", () => {
    const { blocks } = parseDocument("| A | B |\n|---|---|\n| 1 | 2 |");
    const cellBlocks = blocks.filter((b) => b.type === "tableCell");
    expect(cellBlocks.length).toBeGreaterThan(0);
    for (const block of cellBlocks) {
      expect(block.html).toContain(`data-block-id="${block.id}"`);
    }
  });

  test("no data-block-id on frontmatter", () => {
    const { blocks } = parseDocument("---\ntitle: test\n---\n\nHello");
    const fmBlocks = blocks.filter((b) => b.type === "yaml" || b.type === "toml");
    expect(fmBlocks).toHaveLength(0);
    // No block should have a yaml/toml type
    for (const block of blocks) {
      expect(block.type).not.toBe("yaml");
      expect(block.type).not.toBe("toml");
    }
  });

  test("no data-block-id on thematicBreak", () => {
    const { blocks } = parseDocument("Hello\n\n---\n\nWorld");
    const tbBlocks = blocks.filter((b) => b.type === "thematicBreak");
    expect(tbBlocks).toHaveLength(0);
  });

  test("no data-block-id on raw HTML blocks", () => {
    const { blocks } = parseDocument("<div>raw html</div>\n\nHello");
    const htmlBlocks = blocks.filter((b) => b.type === "html");
    expect(htmlBlocks).toHaveLength(0);
  });

  test("list-item id on <li>, no phantom id on dropped <p>", () => {
    const { blocks } = parseDocument("- Item one\n- Item two");
    const liBlocks = blocks.filter((b) => b.type === "listItem");
    expect(liBlocks).toHaveLength(2);

    // In a tight list, remark-rehype drops the <p> wrapper.
    // The data-block-id should be on the <li>, not on a <p> inside.
    for (const block of liBlocks) {
      expect(block.html).toMatch(/<li[^>]*data-block-id/);
      // There should NOT be a <p data-block-id> inside the li
      // In tight lists, there is no <p> at all
      const hasPWithDataBlockId = /<p[^>]*data-block-id/.test(block.html);
      // If there's a <p> with data-block-id, that's a phantom id
      // (only happens in loose lists where <p> is preserved, but we skip those)
      expect(hasPWithDataBlockId).toBe(false);
    }
  });

  test("endOffset is populated correctly", () => {
    const source = "# Hello\n\nWorld";
    const { blocks } = parseDocument(source);
    for (const block of blocks) {
      expect(block.endOffset).toBeGreaterThan(0);
      expect(typeof block.endOffset).toBe("number");
    }
  });

  test("ids are sequential (b0, b1, b2, ...)", () => {
    const { blocks } = parseDocument("# H1\n\nPara 1\n\nPara 2");
    expect(blocks[0].id).toBe("b0");
    expect(blocks[1].id).toBe("b1");
    expect(blocks[2].id).toBe("b2");
  });

  test("anchor is present on every block", () => {
    const { blocks } = parseDocument("# Hello\n\nWorld");
    for (const block of blocks) {
      expect(block.anchor.blockType).toBe(block.type);
      expect(block.anchor.textHash.length).toBe(8);
      expect(typeof block.anchor.siblingOrdinal).toBe("number");
    }
  });

  test("lineRange is advisory (present but not used for relocation)", () => {
    const { blocks } = parseDocument("# Hello\n\nWorld\n\nThird");
    for (const block of blocks) {
      expect(block.lineRange).toHaveLength(2);
      expect(block.lineRange[0]).toBeGreaterThanOrEqual(1);
      expect(block.lineRange[1]).toBeGreaterThanOrEqual(block.lineRange[0]);
    }
  });

  test("mixed document has correct block count", () => {
    const source = `# Title

Some paragraph.

- List item 1
- List item 2

> A quote

\`\`\`
code
\`\`\`

| A | B |
|---|---|
| 1 | 2 |`;

    const { blocks } = parseDocument(source);
    // heading(1) + paragraph(1) + listItem(2) + blockquote(1) + code(1) + tableCell(4) = 10
    expect(blocks.length).toBe(10);
  });

  test("blockquote extracts text from direct content", () => {
    const { blocks } = parseDocument("> This is a quote");
    const bq = blocks.find((b) => b.type === "blockquote");
    expect(bq).toBeDefined();
    expect(bq!.text).toContain("This is a quote");
  });

  test("code block text is the code content", () => {
    const { blocks } = parseDocument("```\nconst x = 1;\n```");
    const code = blocks.find((b) => b.type === "code");
    expect(code).toBeDefined();
    expect(code!.text).toContain("const x = 1;");
  });
});

describe("loadDocument", () => {
  const tmpFile = join(tmpdir(), "test-md-load.md");
  // Create the test file eagerly so all tests can read it
  Bun.write(tmpFile, "# Hello\n\nWorld");

  test("reads file and returns fileHash + fullHtml", async () => {
    const result = await loadDocument(tmpFile);
    expect(result.source).toBe("# Hello\n\nWorld");
    expect(result.fileHash.length).toBe(64); // SHA-256 hex
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.fullHtml).toContain("<h1");
  });

  test("fileHash is stable for same content", async () => {
    const result1 = await loadDocument(tmpFile);
    const result2 = await loadDocument(tmpFile);
    expect(result1.fileHash).toBe(result2.fileHash);
  });

  test("returns links: [] when no opts provided", async () => {
    const result = await loadDocument(tmpFile);
    expect(result.links).toEqual([]);
  });
});

describe("link detection", () => {
  // Create a temporary directory structure for testing
  let testRoot: string;
  let sessionRoot: string;

  beforeEach(() => {
    testRoot = join(tmpdir(), "md-link-test-" + Date.now());
    sessionRoot = testRoot;

    // Create directory structure
    mkdirSync(join(testRoot, "nested"), { recursive: true });

    // Create test files
    writeFileSync(join(testRoot, "root.md"), "# Root\n\nContent");
    writeFileSync(join(testRoot, "target.md"), "# Target\n\nContent");
    writeFileSync(join(testRoot, "nested", "inner.md"), "# Inner\n\nContent");
    writeFileSync(join(testRoot, "not-md.txt"), "not markdown");
    writeFileSync(join(testRoot, "review.mdr"), "review output");
    writeFileSync(join(testRoot, "uppercase.MD"), "# Uppercase");
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  test("relative .md links are detected", async () => {
    const source = "[link](target.md)";
    const links = await detectMdLinks(source, {
      currentFileDir: sessionRoot,
      sessionRoot,
    });
    expect(links).toHaveLength(1);
    expect(links[0].originalUrl).toBe("target.md");
    expect(links[0].resolvedKey).toBe("target.md");
    expect(links[0].resolvedPath).toContain("target.md");
  });

  test("links with schemes are NOT navigational", async () => {
    const source = "[http](http://example.com/page.md) [mailto](mailto:user@example.com)";
    const links = await detectMdLinks(source, {
      currentFileDir: sessionRoot,
      sessionRoot,
    });
    expect(links).toHaveLength(0);
  });

  test("links without .md are NOT navigational", async () => {
    const source = "[txt](not-md.txt) [html](page.html)";
    const links = await detectMdLinks(source, {
      currentFileDir: sessionRoot,
      sessionRoot,
    });
    expect(links).toHaveLength(0);
  });

  test(".mdr links are NOT navigational", async () => {
    const source = "[review](review.mdr)";
    const links = await detectMdLinks(source, {
      currentFileDir: sessionRoot,
      sessionRoot,
    });
    expect(links).toHaveLength(0);
  });

  test(".MD is accepted case-insensitively", async () => {
    const source = "[upper](uppercase.MD)";
    const links = await detectMdLinks(source, {
      currentFileDir: sessionRoot,
      sessionRoot,
    });
    expect(links).toHaveLength(1);
    expect(links[0].originalUrl).toBe("uppercase.MD");
  });

  test("absolute paths are NOT navigational", async () => {
    const source = "[abs](/absolute/path.md)";
    const links = await detectMdLinks(source, {
      currentFileDir: sessionRoot,
      sessionRoot,
    });
    expect(links).toHaveLength(0);
  });

  test("query strings are NOT navigational", async () => {
    const source = "[query](target.md?x=1)";
    const links = await detectMdLinks(source, {
      currentFileDir: sessionRoot,
      sessionRoot,
    });
    expect(links).toHaveLength(0);
  });

  test("#hash fragments ARE allowed", async () => {
    const source = "[anchor](target.md#heading)";
    const links = await detectMdLinks(source, {
      currentFileDir: sessionRoot,
      sessionRoot,
    });
    expect(links).toHaveLength(1);
    expect(links[0].originalUrl).toBe("target.md#heading");
  });

  test("links resolve against current file's directory", async () => {
    // File in nested/ links to inner.md (sibling)
    const source = "[inner](inner.md)";
    const nestedDir = join(testRoot, "nested");
    const links = await detectMdLinks(source, {
      currentFileDir: nestedDir,
      sessionRoot,
    });
    expect(links).toHaveLength(1);
    expect(links[0].resolvedKey).toBe("nested/inner.md");
  });

  test("link to parent directory resolves correctly", async () => {
    // File in nested/ links to ../target.md
    const source = "[target](../target.md)";
    const nestedDir = join(testRoot, "nested");
    const links = await detectMdLinks(source, {
      currentFileDir: nestedDir,
      sessionRoot,
    });
    expect(links).toHaveLength(1);
    expect(links[0].resolvedKey).toBe("target.md");
  });

  test("non-existent .md files are NOT included", async () => {
    const source = "[missing](does-not-exist.md)";
    const links = await detectMdLinks(source, {
      currentFileDir: sessionRoot,
      sessionRoot,
    });
    expect(links).toHaveLength(0);
  });

  test("data-md-link is added via AST properties", async () => {
    const source = "[target](target.md)";
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkFrontmatter, ["yaml", "toml"])
      .use(remarkRehype, { allowDangerousHtml: true });

    const tree = processor.parse(source);
    const links = await markNavigationalLinks(tree, {
      currentFileDir: sessionRoot,
      sessionRoot,
    });

    expect(links).toHaveLength(1);

    // Convert to HTML and check the attribute is present
    const hast = processor.runSync(tree);
    const html = toHtml(hast, { allowDangerousHtml: true });
    expect(html).toContain('data-md-link="target.md"');
  });

  test("loadDocument with opts returns links", async () => {
    const sourceWithLink = "# Root\n\n[go to target](target.md)";
    const filePath = join(testRoot, "root.md");
    writeFileSync(filePath, sourceWithLink);

    const result = await loadDocument(filePath, {
      sessionRoot,
      currentFileDir: dirname(filePath),
    });

    expect(result.links).toHaveLength(1);
    expect(result.links[0].originalUrl).toBe("target.md");
    expect(result.links[0].resolvedKey).toBe("target.md");
    expect(result.fullHtml).toContain('data-md-link="target.md"');
  });

  test("loadDocument without opts returns empty links", async () => {
    const sourceWithLink = "# Root\n\n[go to target](target.md)";
    const filePath = join(testRoot, "root.md");
    writeFileSync(filePath, sourceWithLink);

    const result = await loadDocument(filePath);
    expect(result.links).toEqual([]);
    expect(result.fullHtml).not.toContain("data-md-link");
  });

  test("duplicate links are deduplicated", async () => {
    const source = "[link1](target.md) and [link2](target.md)";
    const links = await detectMdLinks(source, {
      currentFileDir: sessionRoot,
      sessionRoot,
    });
    expect(links).toHaveLength(1);
  });

  test("resolvedPath is realpath-normalized", async () => {
    const source = "[target](./target.md)";
    const links = await detectMdLinks(source, {
      currentFileDir: sessionRoot,
      sessionRoot,
    });
    expect(links).toHaveLength(1);
    const expectedPath = await realpath(join(sessionRoot, "target.md"));
    expect(links[0].resolvedPath).toBe(expectedPath);
  });
});
