---
name: markdown-reviewer
description: CLI markdown annotation tool with a browser-based review UI
colors:
  violet-twilight: "oklch(0.70 0.16 292)"
  dark-amethyst: "oklch(0.223 0.090 318.94)"
  violet-tint: "oklch(0.72 0.14 295)"
  surface: "oklch(0.20 0.012 268)"
  surface-raised: "oklch(0.26 0.015 268)"
  surface-chrome: "oklch(0.155 0.018 286)"
  chrome-shadow: "oklch(0.10 0.018 286 / 0.14)"
  chrome-shadow-strong: "oklch(0.10 0.018 286 / 0.18)"
  text-primary: "oklch(0.85 0.008 300)"
  text-muted: "oklch(0.62 0.01 300)"
  border: "oklch(0.34 0.02 270)"
typography:
  display:
    fontFamily: "IBM Plex Sans Condensed, IBM Plex Serif, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontWeight: 700
  headline:
    fontFamily: "IBM Plex Sans Condensed, IBM Plex Serif, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontWeight: 400
  body:
    fontFamily: "IBM Plex Serif, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, serif"
    fontWeight: 400
  label:
    fontFamily: "IBM Plex Serif, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, serif"
    fontWeight: 500
  mono:
    fontFamily: "MesloLGM Nerd Font Mono, ui-monospace, SFMono-Regular, monospace"
    fontWeight: 400
---

<!-- SEED: re-run /impeccable document once there's code to capture the actual tokens and components. -->

# Design System: markdown-reviewer

## 1. Overview

**Creative North Star: "The Annotated Terminal"**

A developer tool that borrows the authority of a terminal and the clarity of a typeset document. The interface is dark, high-contrast, and unapologetically focused on the markdown content. Violet and amethyst accents mark annotations and primary actions: sparse, deliberate, never decorative. IBM Plex Sans Condensed carries document headings with a compact technical voice, IBM Plex Serif handles body text and UI chrome with editorial warmth, and MesloLGM Nerd Font Mono Regular keeps inline code and code blocks terminal-native.

This explicitly rejects generic SaaS dashboard aesthetics: no card grids, no gradient text, no cream backgrounds, no feature walls. This is a single-purpose tool for people who read and write markdown for a living.

**Key Characteristics:**
- Soft terminal-dark surface by default: darker than `#282c34`, lighter than near-black, to reduce eye strain without washing out the page
- Darker violet-blue chrome for toolbar and sidebar: navigation recedes behind the document, separated by soft shadow instead of hard divider lines
- IBM Plex Sans Condensed headings + IBM Plex Serif body/UI: a condensed-sans/serif pairing with technical contrast between document voice and application chrome
- MesloLGM Nerd Font Mono Regular for inline code, code blocks, and `<pre>` content only
- Restrained color: violet twilight and dark amethyst, used sparingly for annotations and actions
- Responsive motion: transitions and state feedback, no choreography
- Content-first layout: the markdown document fills the viewport; chrome is minimal

## 2. Colors

**Strategy: Restrained.** Dark neutrals carry the surface; violet and amethyst mark annotations and primary actions at ≤10% of any given screen.

### Primary
- **Violet Twilight** `oklch(0.70 0.16 292)`: Annotation highlights, primary buttons, active states, links. The interactive brand color, bright enough for cheap LCDs in bright rooms. Use dark text on this fill.
- **Dark Amethyst** `oklch(0.223 0.090 318.94)`: Annotation overlay backgrounds, borders, tinted surfaces. Too dark for filled buttons; used as a surface modifier.
- **Violet Tint** `oklch(0.72 0.14 295)`: Filled badges, status pills, tag highlights. Derived lighter tint for readable filled elements.

### Neutral
- **Surface** `oklch(0.20 0.012 268)`: Main background. A midpoint between the original near-black UI and the sampled terminal setting, reducing glare without making the page feel washed out.
- **Surface raised** `oklch(0.26 0.015 268)`: Modals, panels, and raised controls. Slightly lighter than surface.
- **Surface chrome** `oklch(0.155 0.018 286)`: Toolbar and sidebar background. Darker than the document body so app chrome recedes.
- **Chrome shadow** `oklch(0.10 0.018 286 / 0.14)`: Toolbar separation. Avoid hard divider lines between layout regions.
- **Chrome shadow strong** `oklch(0.10 0.018 286 / 0.18)`: Sidebar separation when open. Still soft, never a visible panel rule.
- **Text primary** `oklch(0.85 0.008 300)`: Body copy, headings. Soft near-white with subtle purple warmth, dimmed to reduce LCD glare while staying readable against the dark surface.
- **Text muted** `oklch(0.62 0.01 300)`: Metadata, labels, advisory text. ≥4.5:1 against surface.
- **Border** `oklch(0.34 0.02 270)`: Dividers, block boundaries. Lifted enough for visibility on the softened terminal-dark surface.

### Named Rules
**The Annotation Mark Rule.** The primary accent appears only on annotated blocks, primary actions, and active states. Annotated blocks use a borderless `oklch(0.3 0.08 300)` background wash so the mark is visible without boxing the content.

**The Dark Default Rule.** The UI ships terminal-dark, not near-black. The user is reviewing documents in a focused work session, often alongside a terminal or IDE. Light mode is not a priority.

## 3. Typography

**Display Font:** IBM Plex Sans Condensed: document headings (h1-h3), modal titles, and strong section labels.
**Body / UI Font:** IBM Serif: document prose, labels, buttons, metadata, and annotation comments.
**Code Font:** MesloLGM Nerd Font Mono Regular: inline code, code blocks, and `<pre>` content.

**Character:** Three-role system with clear separation of purpose. IBM Plex Sans Condensed gives headings a compact technical voice, IBM Plex Serif makes body and UI text editorial and legible, and MesloLGM Nerd Font Mono Regular preserves the familiar terminal texture where code appears. No other typefaces are used in the app.

### Hierarchy
- **Display** (IBM Plex Sans Condensed, Bold 700, fixed rem scale): Document h1 only. Larger than body on desktop, sharing the same physical text rail.
- **Headline** (IBM Plex Sans Condensed, Regular 400, fixed rem scale): Document h2-h3 and major section breaks.
- **Title** (IBM Plex Sans Condensed, Bold 700): Modal titles and major UI section headers.
- **Body** (IBM Plex Serif, 400): Document prose, annotation comments, controls, and modal body copy. Desktop document prose uses a viewport-based rail, about 63vw, so headings and body share the same physical width regardless of font size.
- **Label** (IBM Plex Serif, 500 / 600): Block type badges, line numbers, toolbar labels, and compact metadata.
- **Code** (MesloLGM Nerd Font Mono Regular, 400): Code blocks and inline code.

### Named Rules
**The Three-Role Font Rule.** IBM Plex Sans Condensed is for titles and headings. IBM Plex Serif is for body, UI, metadata, and annotations. MesloLGM Nerd Font Mono Regular is for inline code, code blocks, and `<pre>` content. Do not introduce another family.

**The Calm Mono Rule.** Body text stays at readable fixed rem sizes with generous line-height. Desktop markdown prose and h1-h3 headings share a physical text rail of about 63vw, capped by the visible document area so it does not run under the sidebar. The outer document rail is the text rail plus horizontal padding; tables may use that full wider rail, while code blocks shrink to content up to the same maximum.

## 4. Elevation

Flat by default. Depth is conveyed through tonal layering (surface vs. surface-raised) rather than shadows. Shadows appear only as a response to state — a modal backdrop or a focused element — never as decoration.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest. Elevation is tonal, not shadow-based. If a shadow exists, it responds to user interaction.

## 5. Components

No components exist yet. To be documented in scan mode once code is written.

Key components anticipated:
- **Toolbar** — fixed top bar with file name, annotation count, Done button
- **Annotation modal** — click-to-open dialog for adding/editing comments
- **Block highlight** — subtle overlay on annotated blocks
- **Sidebar** — annotation list with stale/orphaned status indicators

## 6. Do's and Don'ts

### Do:
- **Do** keep the markdown document as the dominant visual element. Chrome should frame, not compete.
- **Do** use the accent color only for annotations and primary actions. Its scarcity makes it meaningful.
- **Do** use IBM Plex Sans Condensed for document headings and major titles.
- **Do** use IBM Plex Serif for body text, UI chrome, and annotations.
- **Do** use MesloLGM Nerd Font Mono Regular for inline code, code blocks, and `<pre>` content.
- **Do** use tonal layering instead of shadows for depth. Surface vs. surface-raised is enough.
- **Do** keep transitions fast (150–250ms). Users are in flow; don't make them wait.

### Don't:
- **Don't** use generic SaaS dashboard patterns: card grids, gradient text, cream backgrounds, feature walls. Don't default to the warm-red/orange terminal palette either — this brand lives in amethyst and violet.
- **Don't** introduce a third font family.
- **Don't** stretch body prose to the full viewport; give prose its own measure and let tables and code use the wider rail.
- **Don't** decorate with motion. Transitions convey state changes; nothing else.
- **Don't** use `border-left` or `border-right` as colored accent stripes on blocks. Use background tints or the accent overlay instead.
- **Don't** ship with unreadable muted text. All text must hit ≥4.5:1 contrast against its background.
