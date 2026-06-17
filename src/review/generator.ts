import { writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import type { Relocated } from "../server/anchoring";

// ---------------------------------------------------------------------------
// Agent protocol block
// ---------------------------------------------------------------------------

const AGENT_PROTOCOL_BLOCK = `<!-- ===================== AGENT PROTOCOL — do not copy into the source =====================
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
  ========================================================================================= -->`;

// ---------------------------------------------------------------------------
// Comment sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a comment body so it can be safely embedded in an HTML comment.
 *
 * Replaces every `--` run with `- -` (space-separated) so that `-->` can
 * never appear inside the comment body. Loops until no `--` remains,
 * handling cases like `----` → `- - - -` and `---->` → `- - - ->`.
 * Idempotent: running twice produces the same result.
 */
export function sanitizeComment(text: string): string {
  let result = text;
  while (result.includes("--")) {
    result = result.replace(/--/g, "- -");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Block type display names
// ---------------------------------------------------------------------------

function blockTypeLabel(type: string): string {
  switch (type) {
    case "heading":
      return "Heading";
    case "paragraph":
      return "Paragraph";
    case "listItem":
      return "List item";
    case "code":
      return "Code block";
    case "blockquote":
      return "Blockquote";
    case "tableCell":
      return "Table cell";
    default:
      return type;
  }
}

// ---------------------------------------------------------------------------
// Line range formatting
// ---------------------------------------------------------------------------

function formatLineRange(lineRange: [number, number]): string {
  const [start, end] = lineRange;
  if (start === end) {
    return `~line ${start}`;
  }
  return `~lines ${start}-${end}`;
}

// ---------------------------------------------------------------------------
// Summary section generation
// ---------------------------------------------------------------------------

interface NumberedAnnotation {
  number: number;
  annotation: Relocated["annotation"];
  block: Relocated["block"];
}

interface OrphanedAnnotation {
  number: number;
  annotation: Relocated["annotation"];
}

function buildSummarySections(
  fileBasename: string,
  numbered: NumberedAnnotation[],
  orphans: OrphanedAnnotation[]
): string {
  const totalAnnotations = numbered.length + orphans.length;
  const lines: string[] = [];

  lines.push(`# Review of ${fileBasename}`);
  lines.push("");
  lines.push(`**Total annotations:** ${totalAnnotations}`);
  lines.push("");

  // Regular annotations section
  if (numbered.length > 0) {
    lines.push("## Annotations");
    lines.push("");

    for (const { number, annotation } of numbered) {
      const typeLabel = blockTypeLabel(annotation.blockType);
      const lineRange = formatLineRange(annotation.blockLineRange);

      // Heading entries include the heading text as context
      if (annotation.blockType === "heading") {
        const shortContext = annotation.blockText.length > 60
          ? annotation.blockText.slice(0, 57) + "..."
          : annotation.blockText;
        lines.push(`### ${number}. ${typeLabel}: "${shortContext}" (${lineRange})`);
      } else {
        lines.push(`### ${number}. ${typeLabel} (${lineRange})`);
      }

      lines.push("");
      lines.push(`> ${annotation.comment}`);
      lines.push("");
    }
  } else {
    lines.push("## Annotations");
    lines.push("");
  }

  // Orphaned annotations section
  if (orphans.length > 0) {
    lines.push("## Unresolved / orphaned annotations");
    lines.push("");
    lines.push("These annotations could not be re-located in the current document:");
    lines.push("");

    for (const { number, annotation } of orphans) {
      const typeLabel = blockTypeLabel(annotation.blockType);
      const lineRange = formatLineRange(annotation.blockLineRange);
      lines.push(`### O${number}. (was ${typeLabel}, ${lineRange})`);
      lines.push("");
      lines.push(`> ${annotation.comment}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Inline marker insertion
// ---------------------------------------------------------------------------

/**
 * Determine the insertion string for a marker at a given block type.
 *
 * - heading/listItem: inline trailing marker (space + comment)
 * - paragraph/code/other: own line after the block (newline + comment)
 *
 * The insertion is placed AT the block's endOffset (which points to the
 * character immediately after the block's content, typically a newline).
 */
function buildMarkerInsertion(number: number, sanitized: string, blockType: string): string {
  const marker = `<!-- Review: [${number}] ${sanitized} -->`;

  if (blockType === "heading" || blockType === "listItem") {
    // Trailing inline on the same line
    return ` ${marker}`;
  }

  // Own line after the block (insert \n before the marker, before the existing \n)
  return `\n${marker}`;
}

function spliceMarkers(source: string, numbered: NumberedAnnotation[]): string {
  if (numbered.length === 0) {
    return source;
  }

  // Build insertion points: (offset, insertion string)
  const insertions: { offset: number; number: number; insertion: string }[] = [];

  for (const { number, annotation, block } of numbered) {
    if (!block) continue; // orphaned, skip inline marker
    const sanitized = sanitizeComment(annotation.comment);
    const insertion = buildMarkerInsertion(number, sanitized, annotation.blockType);
    insertions.push({ offset: block.endOffset, number, insertion });
  }

  // Sort: by offset descending, then by number descending (so at same offset,
  // higher-numbered markers are inserted first, resulting in ascending order
  // left-to-right in the output)
  insertions.sort((a, b) => {
    if (a.offset !== b.offset) return b.offset - a.offset;
    return b.number - a.number;
  });

  // Insert from end to start so offsets remain valid
  let result = source;
  for (const { offset, insertion } of insertions) {
    result = result.slice(0, offset) + insertion + result.slice(offset);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal: prepare numbered and orphaned lists
// ---------------------------------------------------------------------------

function prepareAnnotations(relocated: Relocated[]): {
  numbered: NumberedAnnotation[];
  orphans: OrphanedAnnotation[];
} {
  // Separate into non-orphaned (numbered) and orphaned
  const nonOrphaned: Relocated[] = relocated.filter(
    (r) => r.block !== null && r.annotation.status !== "orphaned"
  );
  const orphaned: Relocated[] = relocated.filter(
    (r) => r.block === null || r.annotation.status === "orphaned"
  );

  // Sort non-orphaned by endOffset (source order), then by createdAt for stability
  nonOrphaned.sort((a, b) => {
    const offsetDiff = (a.block?.endOffset ?? 0) - (b.block?.endOffset ?? 0);
    if (offsetDiff !== 0) return offsetDiff;
    return a.annotation.createdAt - b.annotation.createdAt;
  });

  // Assign numbers
  const numbered: NumberedAnnotation[] = nonOrphaned.map((r, i) => ({
    number: i + 1,
    annotation: r.annotation,
    block: r.block,
  }));

  const orphans: OrphanedAnnotation[] = orphaned.map((r, i) => ({
    number: i + 1,
    annotation: r.annotation,
  }));

  return { numbered, orphans };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate the full `.mdr` content by splicing review comments into
 * the original source string.
 *
 * @param source - Original markdown source
 * @param relocated - Output of `relocate()` with resolved blocks
 * @param fileBasename - Display name for the summary header
 * @returns The complete `.mdr` string
 */
export function generateReview(
  source: string,
  relocated: Relocated[],
  fileBasename: string
): string {
  const { numbered, orphans } = prepareAnnotations(relocated);

  // Build summary
  const summary = buildSummarySections(fileBasename, numbered, orphans);

  // Build spliced document
  const splicedDoc = spliceMarkers(source, numbered);

  // Combine
  return `${AGENT_PROTOCOL_BLOCK}\n\n${summary}\n---\n\n<!-- Full document with inline review comments. Line numbers above are advisory. -->\n\n${splicedDoc}`;
}

/**
 * Convenience wrapper: compute output path, generate review, write to disk.
 * Uses atomic write (temp file + rename) to avoid corrupt output on crash.
 *
 * @param sourcePath - Path to the original source file
 * @param source - Original markdown source string
 * @param relocated - Output of `relocate()` with resolved blocks
 * @returns The path to the written `.mdr` file
 */
export async function writeReview(
  sourcePath: string,
  source: string,
  relocated: Relocated[]
): Promise<string> {
  const sourceBase = basename(sourcePath);
  // spec.md → spec.mdr (the single source of truth for the suffix)
  const outputPath = sourcePath.replace(/\.md$/i, ".mdr");

  // Reuse generateReview to avoid code duplication
  const content = generateReview(source, relocated, sourceBase);

  // Ensure output directory exists
  const sourceDir = dirname(sourcePath);
  await mkdir(sourceDir, { recursive: true });

  // Atomic write: temp file + rename (avoid corrupt partial output on crash)
  const tmpPath = `${outputPath}.tmp`;
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, outputPath);

  return outputPath;
}
