/**
 * content.js — GFG Hub
 * Injected into GeeksforGeeks problem pages.
 *
 * Architecture borrowed from LeetHub-2.0 (github.com/arunbhardwaj/LeetHub-2.0):
 *   - Hook into the Submit button click (reliable) rather than a MutationObserver storm.
 *   - Poll for "Problem Solved Successfully" text in the output panel (1 s interval, max 30 s).
 *   - Extract code via ace.edit("ace-editor").getValue() injected into page scope,
 *     because the Ace editor's DOM lines are concatenated without whitespace by textContent.
 *   - Language from the .divider.text element (GFG's Semantic-UI dropdown label).
 *   - Title from the [class^="problems_header_content__title"] > h3 element (starts-with selector
 *     is immune to suffix hash changes that break exact class matches).
 *
 * NOTE: This file is intentionally self-contained (no `import` statements).
 * Chrome content scripts run in an isolated world as classic scripts, so
 * top-level `import`/`export` is unreliable here.
 */

(() => {
  // ─── Language map (GFG label → file extension) ──────────────────────────────
  const LANGUAGES = Object.freeze({
    C:          '.c',
    'C++':      '.cpp',
    'C++14':    '.cpp',
    'C++17':    '.cpp',
    Java:       '.java',
    Python:     '.py',
    Python3:    '.py',
    Javascript: '.js',
    JavaScript: '.js',
    TypeScript: '.ts',
    Go:         '.go',
    Golang:     '.go',
    Rust:       '.rs',
    Kotlin:     '.kt',
    'C#':       '.cs',
    PHP:        '.php',
    Swift:      '.swift',
  });

  // ─── Tiny logger & UI ────────────────────────────────────────────────────────
  const log = {
    info:  (...a) => console.log('[GFG Hub]', ...a),
    warn:  (...a) => console.warn('[GFG Hub]', ...a),
    error: (...a) => console.error('[GFG Hub]', ...a),
  };

  /** Shows a quick, auto-disappearing toast notification on the screen. */
  function showToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.textContent = message;
    Object.assign(toast.style, {
      position: 'fixed',
      top: '80px', // slightly below the fixed navbar
      right: '20px',
      padding: '12px 24px',
      backgroundColor: isError ? '#ef4444' : '#10b981', // red or green
      color: '#fff',
      borderRadius: '8px',
      boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '14px',
      fontWeight: '500',
      zIndex: '999999',
      opacity: '0',
      transform: 'translateY(-10px)', // slide down instead of up
      transition: 'opacity 0.3s ease, transform 0.3s ease',
    });

    document.body.appendChild(toast);
    
    // Animate in
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    });

    // Remove after 3.5s
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────
  function textOf(el) {
    return el ? el.textContent.trim().replace(/\s+/g, ' ') : '';
  }

  function sanitizeName(name) {
    return name
      .trim()
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Query a list of selectors and return the first element found.
   * @param {string[]} selectors
   * @param {Document|Element} root
   */
  function queryFirst(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (_) { /* ignore invalid selector */ }
    }
    return null;
  }

  // ─── Extraction ───────────────────────────────────────────────────────────────

  /**
   * Extract the problem title from the page.
   * Uses starts-with attribute selector so GFG's hashed suffixes don't matter.
   */
  function findTitle() {
    // Ordered from most specific to most generic
    const selectors = [
      '[class^="problems_header_content__title"] > h3',
      '[class*="problems_header_content__title"] h3',
      '[class^="problem_heading"]',
      '[class*="problem-statement"] h1',
    ];
    const el = queryFirst(selectors);
    return el ? sanitizeName(textOf(el)) : null;
  }

  /**
   * Extract difficulty. GFG stores it as the first child of a
   * [class^="problems_header_description"] container.
   */
  function findDifficulty() {
    const selectors = [
      '[class^="problems_header_description"]',
      '[class*="problems_header_description"]',
      '[class*="difficulty"]',
    ];
    const container = queryFirst(selectors);
    if (!container) return 'Unknown';
    const raw = textOf(container.children[0] || container);
    if (!raw) return 'Unknown';
    // GFG uses "Basic" / "School" where LeetCode would say "Easy"
    if (/basic|school/i.test(raw)) return 'Easy';
    return raw;
  }

  /**
   * Extract topic tags from the tag container.
   */
  function findTags() {
    const selectors = [
      '[class^="problems_tag_container"]',
      '[class*="problems_tag_container"]',
      '#tag_container',
    ];
    const container = queryFirst(selectors);
    if (!container) return [];
    return Array.from(container.querySelectorAll('a, span, button'))
      .map(c => textOf(c))
      .filter(t => t.length > 0 && t.length < 40)
      .filter((v, i, a) => a.indexOf(v) === i); // unique
  }

  /**
   * Extract the problem statement as raw HTML so images/formatting survive.
   * Returns the innerHTML of the problem content container.
   */
  function findStatementHtml() {
    const selectors = [
      '[class^="problems_problem_content"]',
      '[class*="problems_problem_content"]',
      '[class*="problem_content"]',
      '.problemStatement',
    ];
    const el = queryFirst(selectors);
    return el ? el.innerHTML.trim() : '';
  }

  /**
   * Extract the problem statement as plain text (fallback).
   */
  function findStatement() {
    const selectors = [
      '[class^="problems_problem_content"]',
      '[class*="problems_problem_content"]',
      '[class*="problem_content"]',
      '.problemStatement',
    ];
    const el = queryFirst(selectors);
    return el ? textOf(el) : '';
  }

  /**
   * Find the language displayed in GFG's Semantic-UI dropdown.
   * GFG renders it as: <div class="divider text">C++ (g++ 5.4)</div>
   * We strip the parenthesized version string.
   */
  function findLanguage() {
    const dividerEl = document.querySelector('.divider.text');
    if (dividerEl) {
      const raw = (dividerEl.innerText || dividerEl.textContent || '').trim();
      const lang = raw.split('(')[0].trim();
      if (lang && LANGUAGES[lang]) return lang;
    }
    // Fallback: look for a <select> that might hold the language
    const sel = document.querySelector('select#language, select[class*="language" i]');
    if (sel) {
      const val = (sel.value || (sel.selectedOptions[0] && sel.selectedOptions[0].textContent) || '').trim();
      return val || 'Unknown';
    }
    return 'Unknown';
  }

  /**
   * LeetHub-style code extraction:
   * Inject a <script> tag into the page's own scope so we can call
   * ace.edit("ace-editor").getValue() — the Ace editor JS API.
   * This is the only reliable way to read the full source; reading DOM
   * `.ace_line` nodes loses whitespace and breaks indented code.
   */
  function extractCode() {
    // 1. Ace editor via window.ace — content scripts share the page's JS globals,
    //    so we can call ace.edit() directly without injecting a <script> tag.
    //    This avoids GFG's Content-Security-Policy blocking inline script injection.
    try {
      if (typeof window.ace !== 'undefined') {
        const ed = window.ace.edit('ace-editor');
        const code = ed.getValue();
        if (code && code.trim().length > 0) return code;
      }
    } catch (_) { /* Ace not loaded or ace-editor div absent */ }

    // 2. Monaco editor lines
    const monacoLines = document.querySelectorAll('.monaco-editor .view-lines .view-line');
    if (monacoLines.length > 0) {
      return Array.from(monacoLines).map(l => l.textContent).join('\n');
    }

    // 3. Ace editor DOM lines (fallback — whitespace may be imperfect)
    const aceLines = document.querySelectorAll('.ace_editor .ace_line');
    if (aceLines.length > 0) {
      return Array.from(aceLines).map(l => l.textContent).join('\n');
    }

    // 4. Hidden textarea (last resort)
    const textarea = document.querySelector('textarea.ace_text-input, textarea.inputarea, textarea');
    if (textarea && textarea.value) return textarea.value;

    return null;
  }

  // ─── Verdict detection ────────────────────────────────────────────────────────

  /**
   * Check if the output panel currently shows a successful verdict.
   * Looks for "Problem Solved Successfully" (GFG new UI) or legacy "Correct Answer" / "Accepted".
   */
  function isSuccessVerdict() {
    const SUCCESS_RE = /problem solved successfully|correct answer|all test cases passed/i;
    const FAIL_RE    = /wrong answer|compilation error|runtime error|time limit exceeded|memory limit exceeded/i;

    // Scan the entire document body text — most reliable across GFG redesigns.
    // We look for the success string while ensuring a failure string isn't also
    // present in the same visible area (so we don't false-positive on old results).
    const bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
    if (SUCCESS_RE.test(bodyText) && !FAIL_RE.test(bodyText)) return true;

    // If both success AND failure strings exist (e.g., previous wrong + new accepted),
    // check if the output panel heading specifically says success.
    const headings = document.querySelectorAll('h3, h4, [class*="heading"], [class*="title"]');
    for (const h of headings) {
      if (SUCCESS_RE.test(h.textContent || '')) return true;
    }

    return false;
  }

  // ─── Main sync logic ──────────────────────────────────────────────────────────

  let syncInFlight   = false;
  let lastSyncedKey  = null;

  /**
   * Called after Submit is clicked. Polls every 1 s for up to 30 s
   * waiting for a success verdict, then extracts and pushes the solution.
   * Mirrors LeetHub's setInterval approach exactly.
   */
  function monitorForSuccess() {
    let attempts = 0;
    const MAX_ATTEMPTS = 30;

    const poller = setInterval(() => {
      attempts++;

      if (!isSuccessVerdict()) {
        if (attempts >= MAX_ATTEMPTS) {
          log.warn('Timed out waiting for verdict (30 s). Giving up.');
          clearInterval(poller);
        }
        return; // not yet
      }

      // ✅ Verdict found — stop polling
      clearInterval(poller);

      if (syncInFlight) {
        log.info('Sync already in flight, skipping duplicate trigger.');
        return;
      }

      // Build and validate problem payload
      const title = findTitle();
      if (!title) {
        log.warn('Accepted verdict seen but could not extract problem title — skipping.');
        showToast('❌ Could not read problem details from the page. Update selectors?', true);
        return;
      }

      const code = extractCode();
      if (!code || code.trim().length === 0) {
        log.warn(`Extracted title "${title}" but no code found in editor — skipping.`);
        showToast('❌ Could not read your solution from the editor.', true);
        return;
      }

      // De-duplicate: don't push the exact same (url, language, code-length) twice
      const language  = findLanguage();
      const syncKey   = `${window.location.href.split('?')[0]}::${language}::${code.length}`;
      if (syncKey === lastSyncedKey) {
        log.info('Duplicate sync key, skipping.');
        return;
      }

      const problem = {
        title,
        url:             window.location.href.split('?')[0],
        difficulty:      findDifficulty(),
        tags:            findTags(),
        companyTags:     [],
        description:     findStatement(),      // plain text fallback
        descriptionHtml: findStatementHtml(),  // raw HTML with images/formatting
        examples:        '',
        constraints:     '',
        complexity:      '',
        language,
        code,
      };

      syncInFlight  = true;
      lastSyncedKey = syncKey;

      log.info('Accepted submission detected — syncing:', title, `(${language})`);
      showToast(`⏳ Syncing ${title} to GitHub...`);
      
      chrome.runtime.sendMessage({ type: 'SUBMISSION_ACCEPTED', problem }, (response) => {
        syncInFlight = false;
        if (response?.ok) {
          showToast(response.message || `✅ ${title} synced successfully.`);
        } else {
          showToast(response?.reason || '❌ Sync failed.', true);
        }
      });

    }, 1000);
  }

  // ─── Submit button hook ───────────────────────────────────────────────────────

  /**
   * Watch for the Submit button to appear (GFG is a SPA; the button may not
   * exist yet when the content script first runs). Once found, attach a click
   * listener that kicks off monitorForSuccess(). Mirrors LeetHub's
   * MutationObserver pattern for finding the submit button.
   */
  const submitBtnObserver = new MutationObserver((_mutations, obs) => {
    // GFG's submit button text is literally "Submit"
    const btn = document.evaluate(
      ".//button[normalize-space()='Submit']",
      document.body, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
    ).singleNodeValue;

    if (!btn) return;

    // Found the button — unhook the observer and attach our click listener
    obs.disconnect();
    log.info('GFG Submit button found. Attaching sync listener.');

    btn.addEventListener('click', () => {
      log.info('Submit clicked — starting verdict monitor.');
      monitorForSuccess();
    });
  });

  submitBtnObserver.observe(document.body, { childList: true, subtree: true });

  // ─── SPA navigation support ───────────────────────────────────────────────────
  // GFG navigates between problems without a full page reload. Re-attach the
  // observer whenever the URL changes so we pick up the new submit button.
  let lastHref = window.location.href;
  const navObserver = new MutationObserver(() => {
    if (window.location.href !== lastHref) {
      lastHref      = window.location.href;
      lastSyncedKey = null; // reset de-dup key for new problem
      submitBtnObserver.observe(document.body, { childList: true, subtree: true });
      log.info('URL changed — re-attached submit button observer.');
    }
  });
  navObserver.observe(document.body, { childList: true, subtree: true });

  log.info('GFG Hub content script active on', window.location.href);
})();
