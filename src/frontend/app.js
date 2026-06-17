/**
 * markdown-reviewer — frontend interaction layer
 *
 * Talks to the server API:
 *   GET    /api/markdown        → { source, blocks }
 *   GET    /api/annotations     → { annotations }
 *   POST   /api/annotations     → { annotation }
 *   DELETE /api/annotations/:id → { ok }
 *   POST   /api/done            → { ok, path } | { ok: false, error }
 */

(function () {
  "use strict";

  // -----------------------------------------------------------------------
  // DOM refs
  // -----------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const elLoading = $("#loading");
  const elToolbarFile = $("#toolbar-file");
  const elToolbarCount = $("#toolbar-count");
  const elBtnSidebar = $("#btn-sidebar");
  const elBtnDone = $("#btn-done");
  const elDoc = $("#doc");
  const elEmptyHint = $("#empty-hint");
  const elSidebar = $("#sidebar");
  const elSidebarList = $("#sidebar-list");
  const elStatusBar = $("#status-bar");
  const elStatusText = $("#status-text");
  const elModal = $("#modal");
  const elModalOverlay = $("#modal-overlay");
  const elModalBackdrop = $("#modal-backdrop");
  const elModalTitle = $("#modal-title");
  const elModalClose = $("#modal-close");
  const elModalContext = $("#modal-context");
  const elModalTextarea = $("#modal-textarea");
  const elModalDelete = $("#modal-delete");
  const elModalCancel = $("#modal-cancel");
  const elModalSave = $("#modal-save");
  const elModalShortcut = $("#modal-shortcut");
  const elTerminal = $("#terminal");
  const elTerminalTitle = $("#terminal-title");
  const elTerminalMsg = $("#terminal-msg");
  const elTerminalError = $("#terminal-error");
  const elTerminalCopyPrompt = $("#terminal-copy-prompt");
  const elTerminalDismiss = $("#terminal-dismiss");

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------
  let blocks = [];
  let annotations = [];
  let activeBlockEl = null;   // the clicked block element
  let editingId = null;       // annotation id when editing
  let previousFocus = null;   // for focus restoration
  let modalConfirmDelete = false;  // modal in delete-confirmation mode
  let sidebarConfirmId = null;      // sidebar two-step delete: pending annotation id
  let revealPulseToken = 0;   // cancels pending locate pulses on rapid clicks
  let shutdownNoticeShown = false; // true once the local server is known to be gone
  let heartbeatTimer = null;
  const narrowViewportQuery = window.matchMedia("(max-width: 768px)");
  const desktopShortcutQuery = window.matchMedia("(min-width: 769px) and (hover: hover) and (pointer: fine)");

  // Multi-file state
  var files = [];           // [{ key, fileName, annotationCount, isEntry }]
  var activeFileKey = null; // currently displayed file key
  var entryKey = null;      // the entry file key (from page data)
  var fileState = {};       // key -> { key, fileName, fullHtml, blocks, annotations, annotationCount }
  var discoveringTimeout = null; // debounce for auto-discover polling
  var prevFileZoneCount = 0;  // tracks file list size to detect additions

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------
  function escapeHtml(text) {
    const d = document.createElement("div");
    d.textContent = text;
    return d.innerHTML;
  }

  function anchorKey(anchor) {
    return anchor.blockType + ":" + anchor.textHash + ":" + anchor.siblingOrdinal;
  }

  function setStatus(msg, type) {
    const dot = type ? '<span class="status-dot ' + type + '"></span>' : "";
    elStatusText.innerHTML = dot + msg;
  }

  function updateCount() {
    const count = annotations.length;
    elToolbarCount.textContent = count + (count === 1 ? " annotation" : " annotations");
    elEmptyHint.classList.toggle("visible", count === 0 && blocks.length > 0);
  }



  function showTerminal() {
    document.body.classList.add("terminal-open");
    elTerminal.classList.add("visible");
  }

  function hideTerminal() {
    elTerminal.classList.remove("visible");
    document.body.classList.remove("terminal-open");
  }

  function showShutdownNotice() {
    if (shutdownNoticeShown) return;
    shutdownNoticeShown = true;

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    var notice = document.createElement("div");
    notice.id = "shutdown-notice";
    notice.setAttribute("role", "status");
    notice.innerHTML =
      '<div class="shutdown-notice-title">Session server closed</div>' +
      '<div class="shutdown-notice-text">markdown-reviewer shut down gracefully after 30 minutes without a browser heartbeat. Restart <code>mdr</code> to continue reviewing this file.</div>';
    document.body.appendChild(notice);
    setStatus("server closed after inactivity", "warn");
  }

  function isNarrowViewport() {
    return narrowViewportQuery.matches;
  }

  function setSidebarOpen(open) {
    elSidebar.classList.toggle("open", open);
    elDocWrap.classList.toggle("sidebar-open", open);
    document.body.classList.toggle("mobile-sidebar-open", open && isNarrowViewport());
    elBtnSidebar.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) syncSidebarScroll();
  }

  function onMediaQueryChange(query, callback) {
    if (query.addEventListener) {
      query.addEventListener("change", callback);
    } else if (query.addListener) {
      query.addListener(callback);
    }
  }

  function reviewPrompt(reviewedFiles, relatedFiles) {
    var lines = [];
    lines.push('Apply the markdown review(s):');
    reviewedFiles.forEach(function (f, i) {
      lines.push((i + 1) + '. ' + f.reviewedPath + ' (' + f.annotationCount + ' annotation' + (f.annotationCount === 1 ? '' : 's') + ')');
    });
    lines.push('');
    lines.push('Each .mdr file begins with an "AGENT PROTOCOL" comment block — follow it as authoritative.');
    lines.push('Use that block, not this prompt, for source-file mapping, triage, edit, cleanup, and reporting');
    lines.push('rules.');

    if (relatedFiles && relatedFiles.length > 0) {
      lines.push('');
      lines.push('Related files in this cluster (no annotations of their own — do NOT edit them blindly, but');
      lines.push('check whether your edits above create inconsistencies or stale references in them, and flag any):');
      relatedFiles.forEach(function (f) {
        lines.push('- ' + f.sourcePath);
      });
    }

    return lines.join('\n');
  }

  function showReviewTerminal(reviewedFiles, relatedFiles) {
    var totalAnnotations = reviewedFiles.reduce(function (sum, f) { return sum + f.annotationCount; }, 0);
    var fileCount = reviewedFiles.length;

    elTerminalTitle.textContent = 'Review Ready';
    elTerminalMsg.textContent = fileCount + ' file' + (fileCount !== 1 ? 's' : '') + ' with ' + totalAnnotations + ' total annotation' + (totalAnnotations === 1 ? '' : 's') + '.';

    // Render file list
    var fileListHtml = '';
    reviewedFiles.forEach(function (f) {
      fileListHtml += '<div class="terminal-file-item">';
      fileListHtml += '<span class="terminal-file-path" title="' + escapeHtml(f.reviewedPath) + '">' + escapeHtml(f.reviewedPath) + '</span>';
      fileListHtml += '<span class="terminal-file-count">' + f.annotationCount + '</span>';
      fileListHtml += '</div>';
    });
    document.getElementById('terminal-file-list').innerHTML = fileListHtml;

    // Build and store prompt for copy button
    var prompt = reviewPrompt(reviewedFiles, relatedFiles);
    elTerminalCopyPrompt.onclick = function () {
      copyText(prompt, elTerminalCopyPrompt, 'Copy prompt', 'Prompt copied');
    };

    // "Send to pi" button — only shown when launched from pi (--pi flag)
    var existingSendBtn = document.getElementById('terminal-send-pi');
    if (existingSendBtn) existingSendBtn.remove();

    if (window.__MDR_PI_PORT) {
      var elTerminalActions = document.getElementById('terminal-actions');
      var sendBtn = document.createElement('button');
      sendBtn.id = 'terminal-send-pi';
      sendBtn.className = 'toolbar-btn toolbar-btn--primary';
      sendBtn.textContent = 'Send to pi';
      sendBtn.onclick = function () {
        sendToPi(prompt, sendBtn);
      };
      elTerminalActions.insertBefore(sendBtn, elTerminalDismiss);
    }

    elTerminal.classList.remove('terminal--error');
    elTerminalError.classList.remove('visible');
    showTerminal();
  }

  async function sendToPi(promptText, button) {
    button.disabled = true;
    button.textContent = 'Sending…';
    try {
      var res = await fetch('http://localhost:' + window.__MDR_PI_PORT + '/api/mdr/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: promptText }),
      });
      if (res.ok) {
        button.textContent = 'Sent ✓';
        setStatus('sent to pi', 'ok');
      } else {
        var errData = await res.json().catch(function () { return {}; });
        button.textContent = 'Send failed';
        setStatus('send to pi failed: ' + (errData.error || res.statusText), 'error');
      }
    } catch (err) {
      button.textContent = 'Send failed';
      setStatus('send to pi failed: ' + err.message, 'error');
    } finally {
      // Keep button disabled after send (success or failure) to prevent double-sends
    }
  }

  function copyText(text, button, defaultLabel, copiedLabel) {
    if (!text) return;

    function copied() {
      button.textContent = copiedLabel;
      setStatus(copiedLabel.toLowerCase(), "ok");
      setTimeout(function () {
        button.textContent = defaultLabel;
      }, 1200);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(copied).catch(function () {
        setStatus("copy failed", "error");
      });
    } else {
      var input = document.createElement("textarea");
      input.value = text;
      input.setAttribute("readonly", "readonly");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      try {
        document.execCommand("copy");
        copied();
      } catch (err) {
        setStatus("copy failed", "error");
      }
      document.body.removeChild(input);
    }
  }

  // -----------------------------------------------------------------------
  // API
  // -----------------------------------------------------------------------
  async function api(path, opts) {
    const res = await fetch(path, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  // -----------------------------------------------------------------------
  // Block overlays
  // -----------------------------------------------------------------------
  function paintOverlays() {
    // Clear all
    $$("#doc [data-block-id]").forEach(function (el) {
      el.classList.remove("annotated", "stale");
    });

    // Build anchor → annotation map (exact match for ok annotations)
    const annByAnchor = {};
    annotations.forEach(function (a) {
      if (a.status === "ok") {
        annByAnchor[anchorKey(a.anchor)] = a;
      }
    });

    // Build blockType:ordinal → annotation map for stale annotations
    // (textHash changed, so full anchor won't match; match on position instead)
    const annByPos = {};
    annotations.forEach(function (a) {
      if (a.status === "stale") {
        var posKey = a.anchor.blockType + ":" + a.anchor.siblingOrdinal;
        annByPos[posKey] = a;
      }
    });

    // Paint
    $$("#doc [data-block-id]").forEach(function (el) {
      var key = el.dataset.anchor;
      if (!key) return;

      var a = annByAnchor[key];
      if (!a) {
        // For stale annotations, match on blockType:siblingOrdinal
        var parts = key.split(":");
        var posKey = parts[0] + ":" + parts[2];
        a = annByPos[posKey];
      }

      if (a) {
        el.classList.add("annotated");
        if (a.status === "stale") {
          el.classList.add("stale");
        }
      }
    });

    updateCount();
  }

  function findBlockForAnnotation(ann) {
    var blockEl = elDoc.querySelector('[data-anchor="' + anchorKey(ann.anchor) + '"]');
    if (blockEl) return blockEl;

    if (ann.status !== "stale") return null;

    var found = null;
    $$("#doc [data-block-id]").forEach(function (el) {
      if (found) return;
      var anchorStr = el.dataset.anchor;
      if (!anchorStr) return;

      var elParts = anchorStr.split(":");
      if (
        elParts[0] === ann.anchor.blockType &&
        parseInt(elParts[2], 10) === ann.anchor.siblingOrdinal
      ) {
        found = el;
      }
    });

    return found;
  }

  function pulseBlock(blockEl) {
    blockEl.classList.remove("annotation-pulse");
    // Force style recalc so repeated sidebar clicks replay the pulse.
    void blockEl.offsetWidth;
    blockEl.classList.add("annotation-pulse");

    window.setTimeout(function () {
      blockEl.classList.remove("annotation-pulse");
    }, 1300);
  }

  function pulseBlockAfterScroll(blockEl) {
    var token = ++revealPulseToken;
    var lastX = window.scrollX;
    var lastY = window.scrollY;
    var stableFrames = 0;
    var startedAt = performance.now();

    function tick() {
      if (token !== revealPulseToken) return;

      var currentX = window.scrollX;
      var currentY = window.scrollY;
      var hasMoved = Math.abs(currentX - lastX) > 0.5 || Math.abs(currentY - lastY) > 0.5;

      stableFrames = hasMoved ? 0 : stableFrames + 1;
      lastX = currentX;
      lastY = currentY;

      if (stableFrames >= 5 || performance.now() - startedAt > 1400) {
        pulseBlock(blockEl);
        return;
      }

      window.requestAnimationFrame(tick);
    }

    window.requestAnimationFrame(tick);
  }

  function revealAnnotation(annId) {
    var ann = annotations.find(function (a) { return a.id === annId; });
    if (!ann) return;

    var blockEl = findBlockForAnnotation(ann);
    if (!blockEl) {
      setStatus("annotation is orphaned", "warn");
      return;
    }

    var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    blockEl.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "center",
      inline: "nearest",
    });
    if (reduceMotion) {
      pulseBlock(blockEl);
    } else {
      pulseBlockAfterScroll(blockEl);
    }
    setStatus("annotation located", ann.status === "stale" ? "warn" : "ok");
  }

  // -----------------------------------------------------------------------
  // Sidebar
  // -----------------------------------------------------------------------
  function renderSidebar() {
    sidebarConfirmId = null;  // reset on re-render
    var okAnns = annotations.filter(function (a) { return a.status !== "orphaned"; });
    var orphanAnns = annotations.filter(function (a) { return a.status === "orphaned"; });

    // Update header count
    var elCount = document.getElementById("sidebar-header-count");
    if (elCount) {
      elCount.textContent = annotations.length > 0 ? annotations.length + " total" : "";
    }

    if (annotations.length === 0) {
      elSidebarList.innerHTML =
        '<div class="sidebar-empty">' +
        '  <div class="sidebar-empty-icon">⊕</div>' +
        '  <div class="sidebar-empty-text">No annotations yet.<br>Click a block to add one.</div>' +
        "</div>";
      return;
    }

    var html = "";

    if (okAnns.length > 0) {
      html += '<div class="sidebar-section">';
      okAnns.forEach(function (a, i) {
        html += sidebarItem(a, i + 1, orphanAnns.length === 0);
      });
      html += "</div>";
    }

    if (orphanAnns.length > 0) {
      html += '<div class="sidebar-section">';
      html += '<div class="sidebar-section-title">Orphaned</div>';
      orphanAnns.forEach(function (a, i) {
        html += sidebarItem(a, i + 1, true);
      });
      html += "</div>";
    }

    elSidebarList.innerHTML = html;
  }

  function sidebarItem(a, index, showStatusOk) {
    var escapedComment = escapeHtml(a.comment);
    var statusHtml = "";

    if (a.status === "stale") {
      statusHtml = '<span class="sidebar-item-status stale">stale</span>';
    } else if (a.status === "orphaned") {
      statusHtml = '<span class="sidebar-item-status orphaned">orphaned</span>';
    }

    // Line range metadata
    var linesHtml = "";
    if (a.blockLineRange && a.blockLineRange.length === 2 && a.blockLineRange[0] > 0) {
      var lineLabel = a.blockLineRange[0] === a.blockLineRange[1]
        ? "line " + a.blockLineRange[0]
        : "lines " + a.blockLineRange[0] + "–" + a.blockLineRange[1];
      linesHtml = '<span class="sidebar-item-lines">' + escapeHtml(lineLabel) + "</span>";
    }

    var metaHtml = "";
    if (linesHtml || statusHtml) {
      metaHtml = '<div class="sidebar-item-meta">' + linesHtml + statusHtml + "</div>";
    }

    var html = '<div class="sidebar-item" tabindex="0" data-ann-id="' + escapeHtml(a.id) + '">';
    html += '<span class="sidebar-item-number">' + index + "</span>";
    html += '<div class="sidebar-item-body">';
    html += '<div class="sidebar-item-comment">' + escapedComment + "</div>";
    html += metaHtml;
    html += '<div class="sidebar-item-actions">';
    html += '<button class="sidebar-item-btn" data-action="edit">Edit</button>';
    html += '<button class="sidebar-item-btn sidebar-item-btn--danger" data-action="delete">Delete</button>';
    html += "</div></div></div>";
    return html;
  }

  // Sidebar event delegation
  elSidebarList.addEventListener("click", function (e) {
    var item = e.target.closest(".sidebar-item");
    if (!item) return;

    var itemAnnId = item.dataset.annId;

    // Clicking any item clears pending confirm on a different item
    if (sidebarConfirmId && sidebarConfirmId !== itemAnnId) {
      var oldBtn = elSidebarList.querySelector('[data-action="delete"][data-confirm-pending="true"]');
      if (oldBtn) {
        oldBtn.textContent = "Delete";
        oldBtn.classList.remove("confirming");
        oldBtn.removeAttribute("data-confirm-pending");
      }
      sidebarConfirmId = null;
    }

    var btn = e.target.closest("[data-action]");
    if (btn) {
      e.stopPropagation();
      var action = btn.dataset.action;

      if (action === "edit") {
        sidebarConfirmId = null;
        var confirmingBtns = elSidebarList.querySelectorAll('[data-confirm-pending="true"]');
        confirmingBtns.forEach(function (b) {
          b.textContent = "Delete";
          b.classList.remove("confirming");
          b.removeAttribute("data-confirm-pending");
        });
        var ann = annotations.find(function (a) { return a.id === itemAnnId; });
        if (ann) {
          if (isNarrowViewport()) setSidebarOpen(false);
          openModalForAnnotation(ann);
        }
      } else if (action === "delete") {
        if (sidebarConfirmId === itemAnnId) {
          sidebarConfirmId = null;
          deleteAnnotation(itemAnnId);
        } else {
          sidebarConfirmId = itemAnnId;
          btn.textContent = "Sure?";
          btn.classList.add("confirming");
          btn.setAttribute("data-confirm-pending", "true");
        }
      }
    }

    revealAnnotation(itemAnnId);
    if (!btn && isNarrowViewport()) {
      setSidebarOpen(false);
    }
  });

  elSidebarList.addEventListener("keydown", function (e) {
    if (e.target.closest("button")) return;
    if (e.key !== "Enter" && e.key !== " ") return;

    var item = e.target.closest(".sidebar-item");
    if (!item) return;

    e.preventDefault();
    revealAnnotation(item.dataset.annId);
  });

  // Sidebar toggle + scroll sync
  var elDocWrap = $("#doc-wrap");

  function syncSidebarScroll() {
    if (!elSidebar.classList.contains("open")) return;
    var docEl = elDoc;
    var docScrollTop = docEl.scrollTop || window.scrollY;
    var docScrollHeight = docEl.scrollHeight || document.documentElement.scrollHeight;
    var docClientHeight = docEl.clientHeight || window.innerHeight;
    var ratio = docScrollHeight > docClientHeight
      ? docScrollTop / (docScrollHeight - docClientHeight)
      : 0;
    var inner = document.getElementById("sidebar-inner");
    if (!inner) return;
    var innerScrollHeight = inner.scrollHeight;
    var innerClientHeight = inner.clientHeight;
    if (innerScrollHeight <= innerClientHeight) return;
    inner.scrollTop = ratio * (innerScrollHeight - innerClientHeight);
  }

  elBtnSidebar.addEventListener("click", function () {
    setSidebarOpen(!elSidebar.classList.contains("open"));
  });

  // Close sidebar on Escape (when modal is not open)
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && elSidebar.classList.contains("open") && !elModalOverlay.classList.contains("open")) {
      setSidebarOpen(false);
    }
  });

  // Keep sidebar scroll synced with document scroll
  window.addEventListener("scroll", syncSidebarScroll, { passive: true });

  // Open sidebar from count pill or status bar
  function openSidebar() {
    setSidebarOpen(true);
  }

  elToolbarCount.addEventListener("click", openSidebar);
  elStatusBar.addEventListener("click", openSidebar);

  onMediaQueryChange(narrowViewportQuery, function (e) {
    setSidebarOpen(!e.matches);
  });

  function updateShortcutHint() {
    var showShortcut = desktopShortcutQuery.matches;
    elModalShortcut.hidden = !showShortcut;
    if (!showShortcut) {
      elModalShortcut.innerHTML = "";
      return;
    }

    var isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0
      || (navigator.userAgentData && navigator.userAgentData.platform.toUpperCase().indexOf("MAC") >= 0);
    elModalShortcut.innerHTML = isMac
      ? '<kbd>⌘</kbd> <kbd>Enter</kbd>'
      : '<kbd>Ctrl</kbd> <kbd>Enter</kbd>';
  }

  onMediaQueryChange(desktopShortcutQuery, updateShortcutHint);

  // -----------------------------------------------------------------------
  // Modal
  // -----------------------------------------------------------------------
  function focusCommentField() {
    if (!elModalOverlay.classList.contains("open") || modalConfirmDelete) return;
    try {
      elModalTextarea.focus({ preventScroll: true });
    } catch (err) {
      elModalTextarea.focus();
    }

    var end = elModalTextarea.value.length;
    try {
      elModalTextarea.setSelectionRange(end, end);
    } catch (err) {
      // Some browsers reject selection ranges while the field is still settling.
    }

    setTimeout(function () {
      if (!elModalOverlay.classList.contains("open") || modalConfirmDelete) return;
      try {
        elModalTextarea.focus({ preventScroll: true });
      } catch (err) {
        elModalTextarea.focus();
      }
    }, 80);
  }

  function openModal(blockEl) {
    activeBlockEl = blockEl;
    editingId = null;

    // Check if this block already has an annotation
    var blockAnchorKey = blockEl.dataset.anchor;
    var existing = annotations.find(function (a) {
      return anchorKey(a.anchor) === blockAnchorKey;
    });

    if (existing) {
      editingId = existing.id;
      elModalTitle.textContent = "Edit Comment";
      elModalContext.textContent = existing.blockText || blockEl.textContent.trim().slice(0, 200);
      elModalTextarea.value = existing.comment;
      elModalDelete.style.display = "";
    } else {
      elModalTitle.textContent = "Add Comment";
      elModalContext.textContent = blockEl.textContent.trim().slice(0, 200);
      elModalTextarea.value = "";
      elModalDelete.style.display = "none";
    }

    elModalOverlay.classList.add("open");
    previousFocus = document.activeElement;
    focusCommentField();
  }

  function openModalForAnnotation(ann) {
    editingId = ann.id;
    activeBlockEl = null;

    var blockEl = findBlockForAnnotation(ann);
    if (blockEl) {
      activeBlockEl = blockEl;
    }

    elModalTitle.textContent = "Edit Comment";
    elModalContext.textContent = ann.blockText || ann.comment;
    elModalTextarea.value = ann.comment;
    elModalDelete.style.display = "";

    elModalOverlay.classList.add("open");
    previousFocus = document.activeElement;
    focusCommentField();
  }

  function closeModal() {
    elModalOverlay.classList.remove("open");
    modalConfirmDelete = false;
    activeBlockEl = null;
    editingId = null;
    if (previousFocus) previousFocus.focus();
  }

  // Switch modal into delete-confirmation mode
  function enterModalConfirmDelete() {
    modalConfirmDelete = true;
    elModalTitle.textContent = "Delete Comment";
    elModalContext.textContent = "This will permanently remove this comment. This cannot be undone.";
    elModalContext.classList.add("modal-context--warning");
    elModalTextarea.style.display = "none";
    elModalDelete.style.display = "none";
    elModalShortcut.style.display = "none";
    elModalCancel.textContent = "Cancel";
    elModalSave.textContent = "Delete comment";
    elModalSave.classList.add("modal-btn--danger");
    elModalSave.focus();
  }

  // Restore modal from delete-confirmation mode
  function exitModalConfirmDelete() {
    modalConfirmDelete = false;
    elModalTitle.textContent = "Edit Comment";
    var ann = annotations.find(function (a) { return a.id === editingId; });
    elModalContext.textContent = ann ? (ann.blockText || ann.comment) : "";
    elModalContext.classList.remove("modal-context--warning");
    elModalTextarea.style.display = "";
    elModalTextarea.value = ann ? ann.comment : "";
    elModalDelete.style.display = "";
    elModalShortcut.style.display = "";
    elModalCancel.textContent = "Cancel";
    elModalSave.textContent = "Save";
    elModalSave.classList.remove("modal-btn--danger");
  }

  // Focus trap for modal
  function trapFocus(e) {
    if (!elModalOverlay.classList.contains("open")) return;

    var focusable = elModal.querySelectorAll(
      'button, textarea, input, [tabindex]:not([tabindex="-1"])'
    );
    var first = focusable[0];
    var last = focusable[focusable.length - 1];

    if (e.key === "Tab") {
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }

  // Modal event listeners
  elModalClose.addEventListener("click", closeModal);
  elModalBackdrop.addEventListener("click", closeModal);

  elModalCancel.addEventListener("click", function () {
    if (modalConfirmDelete) {
      exitModalConfirmDelete();
    } else {
      closeModal();
    }
  });

  elModalSave.addEventListener("click", function () {
    if (modalConfirmDelete) {
      // Confirm delete
      if (editingId) {
        deleteAnnotation(editingId);
        closeModal();
      }
    } else {
      var comment = elModalTextarea.value.trim();
      if (!comment) return;
      saveAnnotation(comment);
    }
  });

  elModalDelete.addEventListener("click", function () {
    if (editingId && !modalConfirmDelete) {
      enterModalConfirmDelete();
    }
  });

  // Keyboard
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && elModalOverlay.classList.contains("open")) {
      if (modalConfirmDelete) {
        exitModalConfirmDelete();
      } else {
        closeModal();
      }
    }
    trapFocus(e);

    // Enter to save/confirm (when in textarea or confirm mode, Enter with Ctrl/Cmd)
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && elModalOverlay.classList.contains("open")) {
      e.preventDefault();
      elModalSave.click();
    }
  });

  // -----------------------------------------------------------------------
  // Multi-file: file-scoped API helpers
  // -----------------------------------------------------------------------
  async function fileAnnotationsApi(key, opts) {
    return api('/api/files/' + encodeURIComponent(key) + '/annotations', opts);
  }

  async function fileAnnotationApi(key, id, opts) {
    return api('/api/files/' + encodeURIComponent(key) + '/annotations/' + encodeURIComponent(id), opts);
  }

  // -----------------------------------------------------------------------
  // Multi-file: loadFile
  // -----------------------------------------------------------------------
  async function loadFile(key) {
    if (fileState[key]) { switchToFile(key); return; }
    setStatus('loading ' + key + '...', 'warn');
    try {
      // Single round trip: the file-load response now carries relocated
      // annotations, so navigation paints after one request instead of two.
      var mdRes = await api('/api/files/' + encodeURIComponent(key));
      var anns = mdRes.annotations || [];
      fileState[key] = {
        key: key,
        fileName: mdRes.fileName,
        fullHtml: mdRes.fullHtml,
        blocks: mdRes.blocks,
        annotations: anns,
        annotationCount: anns.length
      };
      switchToFile(key);
      setStatus('loaded ' + mdRes.fileName, 'ok');
      // File-zone refresh is not needed before paint — let it run after.
      refreshSessionFiles();
    } catch (err) {
      setStatus('error: ' + err.message, 'error');
    }
  }

  // -----------------------------------------------------------------------
  // Multi-file: switchToFile
  // -----------------------------------------------------------------------
  function switchToFile(key) {
    activeFileKey = key;
    var fileData = fileState[key];
    if (!fileData) return;
    elDoc.innerHTML = fileData.fullHtml;
    window.scrollTo(0, 0);
    blocks = fileData.blocks;
    annotations = fileData.annotations;
    var fileEntry = files.find(function (f) { return f.key === key; });
    elToolbarFile.textContent = fileEntry ? fileEntry.fileName : fileData.fileName;
    paintOverlays();
    renderSidebar();
    renderFileZone();
    updateCount();
  }

  // -----------------------------------------------------------------------
  // Multi-file: refreshSessionFiles
  // -----------------------------------------------------------------------
  async function refreshSessionFiles() {
    var res;
    try {
      res = await api('/api/session-files');
      files = res.files;
    } catch (err) {
      res = await api('/api/files');
      files = res.files.map(function (f) {
        return Object.assign({}, f, { isEntry: f.key === res.activeKey });
      });
    }
    renderFileZone(files.length > prevFileZoneCount);

    // If auto-discover is still running, poll for updates
    if (res && res.discovering === true) {
      setStatus('discovering files...', 'warn');
      if (!discoveringTimeout) {
        discoveringTimeout = setTimeout(function () {
          discoveringTimeout = null;
          refreshSessionFiles();
        }, 2000);
      }
    } else if (discoveringTimeout) {
      // Discovery just finished — clear the timeout and clear status
      clearTimeout(discoveringTimeout);
      discoveringTimeout = null;
    }
  }

  // -----------------------------------------------------------------------
  // Multi-file: sortFilesForZone (entry first, then code-unit key order)
  //
  // R3: Sort order is entry-first, then lexicographic (code-unit) by file key
  // (relative path from session root). This means:
  //   - the entry file always leads, regardless of its key
  //   - `..` parents sort just after entry (code-unit `.` < any lowercase letter)
  //   - `a/z.md` sorts before `ab.md` (code-unit `/` (0x2F) < `b` (0x62))
  //   - among non-entry files `docs/api.md` sorts *before* `readme.md` (`d` < `r`)
  // Spec success-signal #13 (`readme.md, docs/api.md, docs/api/read.md,
  // docs/workflow.md`) holds because `readme.md` is the *entry* there — the
  // entry-first rule, not lexicographic order, is what puts it first.
  // Simple, deterministic, not locale-aware.
  // -----------------------------------------------------------------------
  function sortFilesForZone(list) {
    return list.slice().sort(function (a, b) {
      if (a.isEntry !== b.isEntry) return a.isEntry ? -1 : 1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
  }

  function fileZonePathHtml(key, fallbackName) {
    var path = key || fallbackName || '';
    var parts = path.split('/');
    var basename = parts.pop() || fallbackName || path;
    var html = '<span class="file-zone-item-path">';

    if (parts.length > 0) {
      html += '<span class="file-zone-item-crumbs">';
      parts.forEach(function (part) {
        html += '<span class="file-zone-item-dir">' + escapeHtml(part) + '</span>';
        html += '<span class="file-zone-item-separator">/</span>';
      });
      html += '</span>';
    }

    html += '<span class="file-zone-item-basename">' + escapeHtml(basename) + '</span>';
    html += '</span>';
    return html;
  }

  // -----------------------------------------------------------------------
  // Multi-file: renderFileZone (crafted)
  // -----------------------------------------------------------------------
  function renderFileZone(animate) {
    var elZone = document.getElementById('file-zone');
    var elList = document.getElementById('file-list');
    if (files.length <= 1) { elZone.style.display = 'none'; prevFileZoneCount = 0; return; }
    elZone.style.display = '';

    var sorted = sortFilesForZone(files);
    var shouldAnimate = animate || prevFileZoneCount === 0;
    var html = '';
    sorted.forEach(function (f, i) {
      var activeClass = f.key === activeFileKey ? ' active' : '';
      var count = f.annotationCount || 0;
      var key = f.key || '';
      var animClass = shouldAnimate ? ' file-zone-item--enter' : '';
      var delayStyle = shouldAnimate ? ' style="animation-delay:' + (i * 20) + 'ms"' : '';

      html += '<button class="file-zone-item' + activeClass + animClass + '"'
        + ' data-file-key="' + escapeHtml(key) + '"'
        + ' data-annotation-count="' + count + '"'
        + ' title="' + escapeHtml(key) + '"'
        + delayStyle
        + '>';
      html += fileZonePathHtml(key, f.fileName);
      if (count > 0) {
        html += '<span class="file-zone-item-count">' + count + '</span>';
      }
      html += '</button>';
    });
    elList.innerHTML = html;
    prevFileZoneCount = sorted.length;
  }

  // -----------------------------------------------------------------------
  // Multi-file: file zone click handler
  // -----------------------------------------------------------------------
  document.getElementById('file-list').addEventListener('click', function (e) {
    var item = e.target.closest('.file-zone-item');
    if (!item) return;
    loadFile(item.getAttribute('data-file-key'));
  });

  // -----------------------------------------------------------------------
  // Block click
  // -----------------------------------------------------------------------
  elDoc.addEventListener("click", function (e) {
    // Check for navigational link first
    var link = e.target.closest('[data-md-link]');
    if (link) {
      e.preventDefault();
      loadFile(link.getAttribute('data-md-link'));
      return;
    }
    // Otherwise, block click for annotation
    var block = e.target.closest("[data-block-id]");
    if (!block) return;
    openModal(block);
  });

  // -----------------------------------------------------------------------
  // Annotation CRUD
  // -----------------------------------------------------------------------
  async function saveAnnotation(comment) {
    var anchor, blockText, blockLineRange;

    if (activeBlockEl) {
      var anchorStr = activeBlockEl.dataset.anchor;
      var parts = anchorStr.split(":");
      anchor = {
        blockType: parts[0],
        textHash: parts[1],
        siblingOrdinal: parseInt(parts[2], 10),
      };
      blockText = activeBlockEl.textContent.trim().slice(0, 500);
      blockLineRange = parseLineRange(activeBlockEl);
    } else if (editingId) {
      // Stale/orphan annotation being edited without a matched block
      var existingAnn = annotations.find(function (a) { return a.id === editingId; });
      if (existingAnn) {
        anchor = existingAnn.anchor;
        blockText = existingAnn.blockText;
        blockLineRange = existingAnn.blockLineRange;
      } else {
        return; // shouldn't happen, but safety
      }
    } else {
      return;
    }

    var body = {
      anchor: anchor,
      blockType: anchor.blockType,
      blockText: blockText,
      blockLineRange: blockLineRange,
      comment: comment,
    };

    if (editingId) {
      body.id = editingId;
    }

    try {
      var key = activeFileKey || entryKey;
      var res = await fileAnnotationsApi(key, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      // Refresh annotations for this file
      var annRes = await fileAnnotationsApi(key);
      annotations = annRes.annotations;
      fileState[key].annotations = annotations;
      fileState[key].annotationCount = annotations.length;

      // Update files[] count
      var fileItem = files.find(function (f) { return f.key === key; });
      if (fileItem) fileItem.annotationCount = annotations.length;

      paintOverlays();
      renderSidebar();
      renderFileZone();
      setStatus(editingId ? "annotation updated" : "annotation added", "ok");
      closeModal();
    } catch (err) {
      setStatus("error: " + err.message, "error");
    }
  }

  async function deleteAnnotation(id) {
    var key = activeFileKey || entryKey;
    try {
      await fileAnnotationApi(key, id, { method: "DELETE" });

      annotations = annotations.filter(function (a) { return a.id !== id; });
      fileState[key].annotations = annotations;
      fileState[key].annotationCount = annotations.length;

      var fileItem = files.find(function (f) { return f.key === key; });
      if (fileItem) fileItem.annotationCount = annotations.length;

      paintOverlays();
      renderSidebar();
      renderFileZone();
      setStatus("annotation removed", "ok");
    } catch (err) {
      setStatus("error: " + err.message, "error");
    }
  }

  function parseLineRange(el) {
    // Read line range from data-line-range attribute (set by server)
    var rangeStr = el.dataset.lineRange;
    if (rangeStr) {
      try {
        var parsed = JSON.parse(rangeStr);
        if (Array.isArray(parsed) && parsed.length === 2) return parsed;
      } catch (e) { /* ignore */ }
    }
    return [0, 0];
  }

  // -----------------------------------------------------------------------
  // Done
  // -----------------------------------------------------------------------
  elBtnDone.addEventListener("click", async function () {
    elBtnDone.disabled = true;
    setStatus("loading review...", "warn");
    try {
      var reviewed = (await api("/api/reviewed-files")).files;
      var sessionFiles;
      try {
        sessionFiles = (await api("/api/session-files")).files;
      } catch (e) {
        sessionFiles = (await api("/api/files")).files.map(function (f) {
          return Object.assign({}, f, { isEntry: false });
        });
      }
      if (reviewed.length > 0) {
        var reviewedKeys = {};
        reviewed.forEach(function (f) { reviewedKeys[f.key] = true; });
        var related = sessionFiles.filter(function (f) { return !reviewedKeys[f.key]; });
        // Convert related to have sourcePath
        related = related.map(function (f) {
          return { key: f.key, sourcePath: f.sourcePath || f.key };
        });
        showReviewTerminal(reviewed, related);
        setStatus("review ready", "ok");
      } else {
        setStatus("no annotations to review", "warn");
      }
    } catch (err) {
      elTerminalTitle.textContent = "Review Failed";
      elTerminalMsg.textContent = "Could not load review data.";
      elTerminalError.textContent = "Error: " + err.message;
      elTerminalError.classList.add("visible");
      elTerminal.classList.add("terminal--error");
      showTerminal();
      setStatus("error loading review", "error");
    } finally {
      elBtnDone.disabled = false;
    }
  });

  elTerminalDismiss.addEventListener("click", function () {
    hideTerminal();
  });

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------
  async function init() {
    try {
      // Load markdown and annotations in parallel
      var mdRes = await api("/api/markdown");
      var annRes = await api("/api/annotations");

      blocks = mdRes.blocks;
      annotations = annRes.annotations;

      // Entry file key from page data
      entryKey = document.body.dataset.fileKey || "document.md";
      activeFileKey = entryKey;

      // Seed file state for entry file
      var fileName = document.body.dataset.fileName || "document.md";
      fileState[entryKey] = {
        key: entryKey,
        fileName: fileName,
        fullHtml: elDoc.innerHTML,
        blocks: mdRes.blocks,
        annotations: annRes.annotations,
        annotationCount: annRes.annotations.length
      };

      elToolbarFile.textContent = fileName;

      // Fetch session file list
      await refreshSessionFiles();

      // Paint overlays
      paintOverlays();
      renderSidebar();
      setSidebarOpen(!isNarrowViewport());
      updateShortcutHint();

      // Hide loading
      elLoading.classList.add("hidden");

      // Show empty hint if no annotations
      updateCount();

      setStatus("ready");

      // Heartbeat ping — keep server alive while browser is open
      heartbeatTimer = setInterval(function () {
        api("/api/ping").catch(function () {
          showShutdownNotice();
        });
      }, 5000);
    } catch (err) {
      elLoading.textContent = "Failed to load: " + err.message;
      setStatus("error: " + err.message, "error");
    }
  }

  init();
})();
