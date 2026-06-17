import { describe, test, expect } from "bun:test";
import { generateReview, sanitizeComment, writeReview } from "./generator";
import type { Relocated } from "../server/anchoring";
import type { Annotation, BlockNode } from "../shared/types";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnnotation(
  id: string,
  blockType: string,
  blockText: string,
  lineRange: [number, number],
  comment: string,
  status: "ok" | "stale" | "orphaned" = "ok"
): Annotation {
  return {
    id,
    anchor: { blockType, textHash: "abc123", siblingOrdinal: 0 },
    blockType,
    blockText,
    blockLineRange: lineRange,
    comment,
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeBlock(
  id: string,
  type: string,
  text: string,
  lineRange: [number, number],
  endOffset: number
): BlockNode {
  return {
    id,
    anchor: { blockType: type, textHash: "abc123", siblingOrdinal: 0 },
    type,
    text,
    lineRange,
    endOffset,
    html: `<${type}>${text}</${type}>`,
  };
}

function makeRelocated(annotation: Annotation, block: BlockNode | null): Relocated {
  return { annotation, block };
}

// ---------------------------------------------------------------------------
// sanitizeComment tests
// ---------------------------------------------------------------------------

describe("sanitizeComment", () => {
  test("leaves normal text unchanged", () => {
    expect(sanitizeComment("Hello world")).toBe("Hello world");
  });

  test("escapes --> to prevent early comment termination", () => {
    const result = sanitizeComment("This ends --> here");
    expect(result).not.toContain("-->");
    expect(result).toContain("here");
  });

  test("escapes standalone -- sequences", () => {
    const result = sanitizeComment("a -- b -- c");
    expect(result).not.toContain("--");
  });

  test("is idempotent", () => {
    const once = sanitizeComment("test --> and -- here");
    const twice = sanitizeComment(once);
    expect(once).toBe(twice);
  });

  test("handles ---- (four hyphens)", () => {
    const result = sanitizeComment("----");
    expect(result).not.toContain("--");
  });

  test("handles ----> (four hyphens + arrow)", () => {
    const result = sanitizeComment("---->");
    expect(result).not.toContain("-->");
    expect(result).not.toContain("--");
  });

  test("handles long hyphen runs", () => {
    const result = sanitizeComment("----------");
    expect(result).not.toContain("--");
  });
});

// ---------------------------------------------------------------------------
// Worked example (canonical golden test)
// ---------------------------------------------------------------------------

describe("worked example", () => {
  const source = `# Introduction

Some introductory text here...

A longer paragraph with several sentences
that spans multiple lines.

- Item one
- Item two
- Item three
`;

  // endOffset = absolute byte index at the end of the block (position.end.offset)
  // For "# Introduction\n", the text is 14 chars (offsets 0-13), endOffset = 14 (the \n)
  // For the paragraph ending at "lines.\n", endOffset = 116 (the \n after "lines.")
  // For "- Item two\n", endOffset = 139 (the \n after "two")

  const headingBlock = makeBlock("b0", "heading", "Introduction", [1, 1], 14);
  const paragraphBlock = makeBlock(
    "b1",
    "paragraph",
    "A longer paragraph with several sentences\nthat spans multiple lines.",
    [5, 6],
    116
  );
  const listItemBlock = makeBlock("b2", "listItem", "Item two", [9, 9], 139);

  const annotations: Relocated[] = [
    makeRelocated(
      makeAnnotation("a1", "heading", "Introduction", [1, 1], "Clarify the target audience in the first sentence."),
      headingBlock
    ),
    makeRelocated(
      makeAnnotation(
        "a2",
        "paragraph",
        "A longer paragraph...",
        [5, 6],
        "This section needs more concrete examples. Consider adding a table comparing approaches."
      ),
      paragraphBlock
    ),
    makeRelocated(
      makeAnnotation("a3", "listItem", "Item two", [9, 9], "Is this still accurate? The API changed in v2."),
      listItemBlock
    ),
  ];

  const expected = `<!-- ===================== AGENT PROTOCOL — do not copy into the source =====================
  This block and the "# Review of…" summary below are NOT review content. When the
  user asks you to apply this review, follow the steps here, strip this block, the
  summary, and every \`Review: [N]\` comment marker, and never write any of them into
  the source file.

  SOURCE FILE = this file's path with the \`.mdr\` extension replaced by \`.md\` (e.g. spec.mdr → spec.md).
  BATCH = if several \`.mdr\` files are given, process them all together; first
  list them and flag any with no matching source (or expected source not covered).

  TRIAGE — default to APPLY; ASK is the rare exception. Pick the lightest safe action:
    • APPLY (most annotations): mechanical edits, AND ambiguous ones where a single
      reading is clearly most reasonable. If a reading took a judgment call, apply
      your best one and note it in the final report. Do NOT ask just because a
      comment is terse or could be read two ways — pick the sensible reading, flag it.
    • ASK (only when a wrong guess is costly or there's no best answer): a direct
      question needing my decision; a genuine fork with no clearly-better option; an
      edit that's expensive/irreversible if guessed wrong (deletes content, changes a
      contract); or two annotations that conflict. When torn between APPLY-and-note
      vs ASK, prefer APPLY-and-note unless the wrong guess is costly.
    Collect ALL ask items across ALL files into ONE numbered questionnaire and STOP
    before editing. If there are none, edit everything and report.

  CONSISTENCY: keep recurring principles consistent across all files in the batch
  even if only one file flagged it; call out anything propagated beyond its file.
  PRESERVE: formatting, links, code fences, frontmatter, wording — except where a
  comment changes them.
  REPORT per file at the end: what changed, what was propagated cross-file, what's
  still unresolved.
  CLEANUP per file: ONLY when ALL annotations for a file have been applied (zero ASK items remaining):
    1. Run \`mdr --cleanup <source-path>\` — this removes the .mdr file, session data, and manifest entry in one step
    If even a single annotation is unresolved (ASK), do NOT clean up — keep the .mdr so the user can continue editing.
    Never clean up before source edits are written, and never delete the source file.
  ========================================================================================= -->

# Review of proposal.md

**Total annotations:** 3

## Annotations

### 1. Heading: "Introduction" (~line 1)

> Clarify the target audience in the first sentence.

### 2. Paragraph (~lines 5-6)

> This section needs more concrete examples. Consider adding a table comparing approaches.

### 3. List item (~line 9)

> Is this still accurate? The API changed in v2.

---

<!-- Full document with inline review comments. Line numbers above are advisory. -->

# Introduction <!-- Review: [1] Clarify the target audience in the first sentence. -->

Some introductory text here...

A longer paragraph with several sentences
that spans multiple lines.
<!-- Review: [2] This section needs more concrete examples. Consider adding a table comparing approaches. -->

- Item one
- Item two <!-- Review: [3] Is this still accurate? The API changed in v2. -->
- Item three
`;

  test("output matches worked example", () => {
    const result = generateReview(source, annotations, "proposal.md");
    expect(result).toBe(expected);
  });

  test("summary numbering matches inline numbering", () => {
    const result = generateReview(source, annotations, "proposal.md");
    // Summary should have [1], [2], [3]
    expect(result).toContain("### 1. Heading:");
    expect(result).toContain("### 2. Paragraph");
    expect(result).toContain("### 3. List item");
    // Inline markers should have [1], [2], [3]
    expect(result).toContain("<!-- Review: [1]");
    expect(result).toContain("<!-- Review: [2]");
    expect(result).toContain("<!-- Review: [3]");
  });

  test("total annotations count is correct", () => {
    const result = generateReview(source, annotations, "proposal.md");
    expect(result).toContain("**Total annotations:** 3");
  });
});

// ---------------------------------------------------------------------------
// Source fidelity
// ---------------------------------------------------------------------------

describe("source fidelity", () => {
  test("GFM table + mixed bullets round-trips byte-for-byte except markers", () => {
    const source = `# Table test

| Col A | Col B |
|-------|-------|
| 1     | 2     |
| 3     | 4     |

- Item A
* Item B
- Item C

\`\`\`js
const x = 1;
\`\`\`

A final paragraph.
`;

    // Compute correct endOffsets
    // "# Table test\n" = 13 chars, endOffset = 13
    // "A final paragraph.\n" ends at offset 123
    // Let's compute: 
    // "# Table test\n" = 13 (0-12, \n at 13)
    // "\n" = 1 (13)
    // "| Col A | Col B |\n" = 18 (14-31, \n at 32)
    // "|-------|-------|\n" = 18 (32-49, \n at 50)
    // "| 1     | 2     |\n" = 18 (50-67, \n at 68)
    // "| 3     | 4     |\n" = 18 (68-85, \n at 86)
    // "\n" = 1 (86)
    // "- Item A\n" = 9 (87-95, \n at 96)
    // "* Item B\n" = 9 (96-104, \n at 105)
    // "- Item C\n" = 9 (105-113, \n at 114)
    // "\n" = 1 (114)
    // "```js\n" = 6 (115-120, \n at 121)
    // "const x = 1;\n" = 14 (121-134, \n at 135)
    // "```\n" = 4 (135-138, \n at 139)
    // "\n" = 1 (139)
    // "A final paragraph.\n" = 18 (140-157, \n at 158)

    const headingBlock = makeBlock("b0", "heading", "Table test", [1, 1], 13);
    const paragraphBlock = makeBlock("b1", "paragraph", "A final paragraph.", [14, 14], 158);

    const annotations: Relocated[] = [
      makeRelocated(
        makeAnnotation("a1", "heading", "Table test", [1, 1], "Check table formatting"),
        headingBlock
      ),
      makeRelocated(
        makeAnnotation("a2", "paragraph", "A final paragraph.", [14, 14], "Needs more detail"),
        paragraphBlock
      ),
    ];

    const result = generateReview(source, annotations, "table-test.md");

    // The original source content between markers should be byte-for-byte identical
    // Extract the document part (after --- separator)
    const parts = result.split("\n---\n");
    const docPart = parts[1]!;

    // Remove the advisory comment line and leading/trailing blank lines
    const lines = docPart.split("\n");
    const advisoryIndex = lines.findIndex((l) => l.includes("Full document with inline review comments"));
    const docLines = lines.slice(advisoryIndex + 1).filter((l, i, arr) => {
      // Skip leading empty lines
      if (i === 0 && l === "") return false;
      return true;
    });
    const docContent = docLines.join("\n");

    // Remove inline markers (trailing on same line)
    const stripped = docContent.replace(/ <!-- Review: \[\d\] [^>]* -->/g, "");
    // Remove standalone marker lines (for paragraphs)
    const strippedLines = stripped.split("\n").filter((l) => !l.startsWith("<!-- Review:")).join("\n");

    // The stripped content should match the original source
    expect(strippedLines).toBe(source);
  });
});

// ---------------------------------------------------------------------------
// Code block placement
// ---------------------------------------------------------------------------

describe("code block", () => {
  test("marker lands after closing fence, never between fences", () => {
    const source = `# Heading

\`\`\`python
def hello():
    print("world")
\`\`\`

After code.
`;

    // Compute endOffsets:
    // "# Heading\n" = 9 (0-8, \n at 9), endOffset = 9
    // "\n" = 1 (9)
    // "```python\n" = 10 (10-19, \n at 20)
    // "def hello():\n" = 14 (20-33, \n at 34)
    // '    print("world")\n' = 20 (34-53, \n at 54)
    // "```\n" = 4 (54-57, \n at 58)
    // Code block endOffset = 58 (after closing fence)
    // "\n" = 1 (58)
    // "After code.\n" = 12 (59-70, \n at 71), endOffset = 71

    const codeBlock = makeBlock(
      "b0",
      "code",
      'def hello():\n    print("world")',
      [3, 5],
      58 // endOffset after closing ```
    );
    const paragraphBlock = makeBlock("b1", "paragraph", "After code.", [7, 7], 71);

    const annotations: Relocated[] = [
      makeRelocated(
        makeAnnotation("a1", "code", "def hello():...", [3, 5], "This function needs type hints"),
        codeBlock
      ),
      makeRelocated(
        makeAnnotation("a2", "paragraph", "After code.", [7, 7], "Good"),
        paragraphBlock
      ),
    ];

    const result = generateReview(source, annotations, "code-test.md");

    // Marker for code block should be after the closing fence
    const docPart = result.split("\n---\n")[1]!;
    const lines = docPart.split("\n");
    const advisoryIdx = lines.findIndex((l) => l.includes("Full document with inline review comments"));
    const docLines = lines.slice(advisoryIdx + 1);

    // Find the closing fence line
    const fenceLineIdx = docLines.findIndex((l) => l.trim() === "```");
    expect(fenceLineIdx).toBeGreaterThanOrEqual(0);

    // The marker for the code block should be on or after the closing fence line
    const markerIdx = docLines.findIndex((l) => l.includes("Review: [1]"));
    expect(markerIdx).toBeGreaterThanOrEqual(fenceLineIdx);

    // Ensure no marker is between the opening and closing fences
    const openingFenceIdx = docLines.findIndex((l) => l.trim() === "```python");
    const betweenFences = docLines.slice(openingFenceIdx + 1, fenceLineIdx);
    const hasMarkerBetweenFences = betweenFences.some((l) => l.includes("<!-- Review:"));
    expect(hasMarkerBetweenFences).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Encoding safety
// ---------------------------------------------------------------------------

describe("encoding", () => {
  test("comment containing --> yields exactly one valid HTML comment", () => {
    const source = `# Heading

Paragraph text.
`;

    // "# Heading\n" = 9 chars, endOffset = 9
    const headingBlock = makeBlock("b0", "heading", "Heading", [1, 1], 9);
    const annotations: Relocated[] = [
      makeRelocated(
        makeAnnotation("a1", "heading", "Heading", [1, 1], "This ends --> here and -- also"),
        headingBlock
      ),
    ];

    const result = generateReview(source, annotations, "encoding-test.md");
    const docPart = result.split("\n---\n")[1]!;

    // Count HTML comment open/close tags
    const openCount = (docPart.match(/<!--/g) || []).length;
    const closeCount = (docPart.match(/-->/g) || []).length;

    // Should have exactly 2 open and 2 close (protocol block is before ---,
    // not in docPart): Advisory comment + Review marker
    expect(openCount).toBe(2);
    expect(closeCount).toBe(2);

    // The review marker should contain the sanitized comment
    expect(docPart).toContain("Review: [1]");

    // The agent protocol block is a single HTML comment: it must not contain a
    // nested `-->` that would close it prematurely (load-bearing invariant #3).
    const protocolPart = result.split("\n\n# Review of ")[0]!;
    expect((protocolPart.match(/<!--/g) || []).length).toBe(1);
    expect((protocolPart.match(/-->/g) || []).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Orphans
// ---------------------------------------------------------------------------

describe("orphans", () => {
  test("orphaned annotation in Unresolved subsection, no inline marker", () => {
    const source = `# Heading

Paragraph text.
`;

    // "# Heading\n" = 9 chars, endOffset = 9
    const headingBlock = makeBlock("b0", "heading", "Heading", [1, 1], 9);

    const annotations: Relocated[] = [
      makeRelocated(
        makeAnnotation("a1", "heading", "Heading", [1, 1], "This is ok", "ok"),
        headingBlock
      ),
      makeRelocated(
        makeAnnotation("a2", "paragraph", "Deleted paragraph", [3, 3], "This block was deleted", "orphaned"),
        null // orphaned = no block
      ),
    ];

    const result = generateReview(source, annotations, "orphan-test.md");

    // Should have orphaned subsection
    expect(result).toContain("## Unresolved / orphaned annotations");
    expect(result).toContain("These annotations could not be re-located");
    expect(result).toContain("### O1.");
    expect(result).toContain("This block was deleted");

    // Orphan should NOT have inline marker in document
    const docPart = result.split("\n---\n")[1]!;
    expect(docPart).not.toContain("O1");
    // The orphaned annotation should not produce a [2] inline marker
    expect(docPart).not.toMatch(/<!-- Review: \[2\]/);

    // Only the non-orphaned annotation should have an inline marker
    expect(docPart).toContain("<!-- Review: [1]");
  });

  test("total annotations includes orphans", () => {
    const source = `# Heading
`;

    const annotations: Relocated[] = [
      makeRelocated(
        makeAnnotation("a1", "heading", "Heading", [1, 1], "Ok comment", "ok"),
        makeBlock("b0", "heading", "Heading", [1, 1], 9)
      ),
      makeRelocated(
        makeAnnotation("a2", "paragraph", "Gone", [2, 2], "Orphan comment", "orphaned"),
        null
      ),
      makeRelocated(
        makeAnnotation("a3", "paragraph", "Also gone", [3, 3], "Another orphan", "orphaned"),
        null
      ),
    ];

    const result = generateReview(source, annotations, "orphan-total.md");

    // Total should count all annotations
    expect(result).toContain("**Total annotations:** 3");

    // Should have 1 regular + 2 orphaned
    expect(result).toContain("### 1. Heading");
    expect(result).toContain("### O1.");
    expect(result).toContain("### O2.");
  });
});

// ---------------------------------------------------------------------------
// writeReview
// ---------------------------------------------------------------------------

describe("writeReview", () => {
  test("writes file and returns path", async () => {
    const tmpDir = join(tmpdir(), `mdr-test-${Date.now()}`);
    const sourceDir = join(tmpDir, "docs");
    await mkdir(sourceDir, { recursive: true });

    const source = `# Heading

Paragraph.
`;
    const sourcePath = join(sourceDir, "test.md");
    await writeFile(sourcePath, source, "utf-8");

    const headingBlock = makeBlock("b0", "heading", "Heading", [1, 1], 9);
    const annotations: Relocated[] = [
      makeRelocated(
        makeAnnotation("a1", "heading", "Heading", [1, 1], "A comment"),
        headingBlock
      ),
    ];

    const outputPath = await writeReview(sourcePath, source, annotations);
    expect(outputPath).toBe(join(sourceDir, "test.mdr"));

    const content = await readFile(outputPath, "utf-8");
    expect(content).toContain("# Review of test.md");
    expect(content).toContain("<!-- Review: [1] A comment -->");

    // Cleanup
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  test("empty annotations list", () => {
    const source = "# Heading\n\nParagraph.\n";
    const result = generateReview(source, [], "empty.md");
    expect(result).toContain("**Total annotations:** 0");
    expect(result).toContain("## Annotations");
    // No orphaned subsection when there are no orphans
    expect(result).not.toContain("Unresolved");
  });

  test("annotations sorted by source order (endOffset)", () => {
    const source = `# First

# Second

# Third
`;

    // "# First\n" = 8 chars, endOffset = 8
    // "\n" = 1 (8)
    // "# Second\n" = 9 chars, endOffset = 18
    // "\n" = 1 (18)
    // "# Third\n" = 8 chars, endOffset = 27

    const block1 = makeBlock("b0", "heading", "First", [1, 1], 8);
    const block2 = makeBlock("b1", "heading", "Second", [3, 3], 18);
    const block3 = makeBlock("b2", "heading", "Third", [5, 5], 27);

    // Pass in reverse order — should be sorted by endOffset
    const annotations: Relocated[] = [
      makeRelocated(
        makeAnnotation("a3", "heading", "Third", [5, 5], "Third comment"),
        block3
      ),
      makeRelocated(
        makeAnnotation("a1", "heading", "First", [1, 1], "First comment"),
        block1
      ),
      makeRelocated(
        makeAnnotation("a2", "heading", "Second", [3, 3], "Second comment"),
        block2
      ),
    ];

    const result = generateReview(source, annotations, "sort-test.md");

    // Should be numbered 1, 2, 3 in source order
    expect(result).toContain('### 1. Heading: "First"');
    expect(result).toContain('### 2. Heading: "Second"');
    expect(result).toContain('### 3. Heading: "Third"');
  });

  test("same endOffset keeps ascending number order", () => {
    // Two annotations on the same block (same endOffset)
    const source = `# Heading
`;

    const block = makeBlock("b0", "heading", "Heading", [1, 1], 9);

    const annotations: Relocated[] = [
      makeRelocated(
        makeAnnotation("a1", "heading", "Heading", [1, 1], "First annotation", "ok"),
        block
      ),
      makeRelocated(
        makeAnnotation("a2", "heading", "Heading", [1, 1], "Second annotation", "ok"),
        block
      ),
    ];

    const result = generateReview(source, annotations, "same-offset.md");

    // Both markers should be present, [1] before [2]
    expect(result).toContain("<!-- Review: [1] First annotation -->");
    expect(result).toContain("<!-- Review: [2] Second annotation -->");
  });
});
