# Product

## Register

product

## Users

Individual developers reviewing their own markdown documents — docs, RFCs, proposals, specs — before sharing them. They run a CLI command, annotate blocks in their browser, then hand the reviewed file to an LLM agent to apply changes. They're technical, efficiency-minded, and in a focused work session.

## Product Purpose

Attach structured comments to markdown blocks (headings, paragraphs, list items, code blocks) via a browser UI, producing a `_reviewed.md` file an LLM agent can act on. The tool anchors annotations to survive edits, persists sessions across crashes, and splices comments into the original source without re-serializing.

## Brand Personality

Bold, opinionated, expert. This is a tool built by people who know what they're doing. No hedging, no generic UI patterns. Design choices are deliberate and confident.

## Anti-references

Generic SaaS dashboards — card grids, gradient text, cream backgrounds, feature walls. This is a focused developer tool, not a product landing page.

## Design Principles

1. **Content first.** The markdown document is the hero. The UI frames it, never competes with it.
2. **Precision over decoration.** The tool deals with exact text blocks, anchors, and byte offsets. The interface should reflect that rigor.
3. **Expert confidence.** Bold, opinionated choices that signal a tool built by practitioners, not a generic scaffold.
4. **Resilience by default.** Session resumption, orphan handling, persistence. The tool handles failure gracefully without the user asking.

## Typography Direction

IBM Plex Sans Condensed is the title and heading voice. IBM Plex Sans is the body, UI, annotation, and metadata voice. MesloLGM Nerd Font Mono Regular is reserved for inline code, code blocks, and `<pre>` content. Meslo is self-hosted so code keeps its intended terminal texture without depending on an external font CDN.

## Accessibility & Inclusion

Best effort. Basic keyboard navigation for the modal interface. No specific WCAG target. Reduced motion support where animations are present.
