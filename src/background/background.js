/**
 * background.js
 * MV3 service worker. Owns all GitHub network calls and orchestrates the
 * commit flow: receives a parsed problem from content.js -> builds README.md
 * + solution file -> checks for an existing folder (duplicate detection) ->
 * creates or updates files via the GitHub Contents API -> notifies the user.
 */

import { GitHubClient, GitHubError } from "../github/github.js";
import { launchGitHubOAuth } from "../github/oauth.js";
import {
  storage,
  notify,
  log,
  formatDate,
  extensionForLanguage,
  toKebabCase,
  sanitizeName,
} from "../utils/utils.js";

// ---- Keep the MV3 service worker alive ----------------------------------------
// MV3 service workers are killed after ~30 s of inactivity. We set a repeating
// alarm every 20 s so the worker wakes up before Chrome shuts it down.
chrome.alarms.create("keepAlive", { periodInMinutes: 0.33 }); // ~20 s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    log.info("Keep-alive ping.");
  }
});

const DEFAULT_SETTINGS = {
  autoCommit: true,
  autoReadme: true,
  branch: null, // null => use repo's default branch
  folderNaming: "title", // "title" | "title-difficulty"
};

// ---- README generation (LeetHub style) -------------------------------------
// Format: <h2><a href="URL">Title</a></h2><h3>Difficulty: Easy</h3><hr>\n\n## Problem\n...

function difficultyBadge(difficulty) {
  const d = (difficulty || 'Unknown').toLowerCase();
  const colors = { easy: '00b8a3', medium: 'ffa116', hard: 'ff375f', unknown: '818cf8' };
  const color = colors[d] || colors.unknown;
  const label = d.charAt(0).toUpperCase() + d.slice(1);
  return `![Difficulty: ${label}](https://img.shields.io/badge/Difficulty-${label}-${color}?style=flat-square)`;
}

function buildReadme(problem) {
  const title   = problem.title || 'Unknown Problem';
  const url     = problem.url   || '';
  const diff    = problem.difficulty || 'Unknown';
  const lang    = problem.language   || 'Unknown';
  const date    = formatDate();
  const tags    = (problem.tags || []).filter(Boolean);
  const company = (problem.companyTags || []).filter(Boolean);

  // Use raw HTML from the GFG problem statement div so images and formatting
  // are preserved exactly as they appear on the GFG problem page.
  const bodyHtml = problem.descriptionHtml
    || (problem.description ? `<p>${problem.description}</p>` : '<p><em>Description unavailable — see source link.</em></p>');

  const diffBadge = difficultyBadge(diff);

  // Header: h2 link + hr (no badge — difficulty visible in problem body)
  const header = `<h2><a href="${url}">${title}</a></h2>\n<hr>\n`;

  // Problem body exactly as GFG renders it (HTML preserved)
  const body = `## Problem\n\n${bodyHtml}`;

  const tagSection = tags.length
    ? `## Topic Tags\n\n${tags.map(t => `\`${t}\``).join(' ')}`
    : '';

  const companySection = company.length
    ? `## Company Tags\n\n${company.map(c => `\`${c}\``).join(' ')}`
    : '';

  const footer = `---\n\n*Solved on: **${date}** &nbsp;|&nbsp; Language: **${lang}** &nbsp;|&nbsp; Auto-synced by [GFG Hub](https://github.com/topics/gfg-hub)*`;

  return [
    header,
    body,
    tagSection,
    companySection,
    footer,
  ].filter(Boolean).join('\n\n');
}

// ---- Path construction ------------------------------------------------------
// Structure: Problem Title/
//              README.md
//              Solution.ext

function buildPaths(problem, _settings) {
  const folder = sanitizeName(problem.title); // exact title, e.g. "Sum Of Digits"
  const ext    = extensionForLanguage(problem.language);
  return {
    readmePath:   `${folder}/README.md`,
    solutionPath: `${folder}/Solution.${ext}`,
  };
}

// ---- Core sync flow ----------------------------------------------------------

async function handleAcceptedSubmission(problem, sendResponse) {
  try {
    const { githubToken, repoConfig, settings: savedSettings } = await storage.get([
      "githubToken",
      "repoConfig",
      "settings",
    ]);
    const settings = { ...DEFAULT_SETTINGS, ...(savedSettings || {}) };

    if (!githubToken) {
      notify("GFG Hub", "❌ Not connected to GitHub. Open the extension popup to add your token.", true);
      sendResponse?.({ ok: false, reason: "not_authenticated" });
      return;
    }
    if (!repoConfig) {
      notify("GFG Hub", "❌ No repository configured. Open the extension popup to connect one.", true);
      sendResponse?.({ ok: false, reason: "no_repo" });
      return;
    }
    if (!settings.autoCommit) {
      log.info("Auto-commit disabled in settings — skipping.");
      sendResponse?.({ ok: false, reason: "auto_commit_disabled" });
      return;
    }

    const client = new GitHubClient(githubToken);
    const branch = settings.branch || repoConfig.defaultBranch || "main";
    const { readmePath, solutionPath } = buildPaths(problem, settings);
    const readmeContent = settings.autoReadme ? buildReadme(problem) : null;

    // Duplicate detection: look up existing files first so we UPDATE instead
    // of blindly creating (which GitHub would reject with a 409/422 sha mismatch anyway).
    const [existingReadme, existingSolution] = await Promise.all([
      readmeContent
        ? client.getFile(repoConfig.owner, repoConfig.name, readmePath, branch)
        : Promise.resolve(null),
      client.getFile(repoConfig.owner, repoConfig.name, solutionPath, branch),
    ]);

    const isUpdate = Boolean(existingReadme || existingSolution);
    const commitMessage = isUpdate ? `Update files: ${problem.title}` : `Solved: ${problem.title}`;

    const writes = [];
    if (readmeContent) {
      writes.push(
        client.putFile({
          owner: repoConfig.owner,
          repo: repoConfig.name,
          path: readmePath,
          branch,
          content: readmeContent,
          message: commitMessage,
          sha: existingReadme?.sha,
        })
      );
    }
    writes.push(
      client.putFile({
        owner: repoConfig.owner,
        repo: repoConfig.name,
        path: solutionPath,
        branch,
        content: problem.code,
        message: commitMessage,
        sha: existingSolution?.sha,
      })
    );

    for (const write of writes) {
      await write;
    }

    await storage.set({
      lastSync: {
        title: problem.title,
        url: problem.url,
        date: new Date().toISOString(),
      },
    });
    const { syncCount } = await storage.get(["syncCount"]);
    await storage.set({ syncCount: (syncCount || 0) + 1 });

    sendResponse?.({ ok: true, message: `✅ ${problem.title} synced successfully.` });
  } catch (err) {
    const errorMsg = handleSyncError(err, problem?.title);
    sendResponse?.({ ok: false, reason: errorMsg });
  }
}

function handleSyncError(err, title) {
  log.error("Sync failed:", err);
  if (err instanceof GitHubError) {
    if (err.status === 401) {
      return "❌ GitHub authentication expired. Re-add your token in the popup.";
    }
    if (err.status === 403) {
      return "❌ GitHub rate limit reached or token lacks 'repo' scope.";
    }
    if (err.status === 404) {
      return "❌ Repository not found — it may have been deleted or renamed.";
    }
  }
  if (err.message?.includes("Failed to fetch")) {
    return "❌ Network error while syncing. Check your connection and try again.";
  }
  return `❌ Commit failed${title ? ` for ${title}` : ""}: ${err.message}`;
}

// ---- Message router -----------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "SUBMISSION_ACCEPTED") {
    handleAcceptedSubmission(message.problem, sendResponse);
    return true; // keep the message channel open for the async sendResponse
  }

  if (message.type === "VALIDATE_TOKEN") {
    (async () => {
      try {
        const client = new GitHubClient(message.token);
        const user = await client.getAuthenticatedUser();
        sendResponse({ ok: true, login: user.login, avatarUrl: user.avatar_url });
      } catch (err) {
        sendResponse({ ok: false, reason: err.message });
      }
    })();
    return true;
  }

  if (message.type === "LIST_REPOS") {
    (async () => {
      try {
        const { githubToken } = await storage.get(["githubToken"]);
        const client = new GitHubClient(githubToken);
        const repos = await client.listRepos();
        sendResponse({ ok: true, repos });
      } catch (err) {
        sendResponse({ ok: false, reason: err.message });
      }
    })();
    return true;
  }

  if (message.type === "GITHUB_OAUTH") {
    (async () => {
      try {
        const token = await launchGitHubOAuth();
        const client = new GitHubClient(token);
        const user   = await client.getAuthenticatedUser();
        await storage.set({
          githubToken: token,
          githubUser: { login: user.login, avatarUrl: user.avatar_url },
        });
        sendResponse({ ok: true, login: user.login, avatarUrl: user.avatar_url });
      } catch (err) {
        log.error("OAuth failed:", err);
        sendResponse({ ok: false, reason: err.message });
      }
    })();
    return true; // keep channel open for async sendResponse
  }

  if (message.type === "CREATE_REPO") {
    (async () => {
      try {
        const { githubToken } = await storage.get(["githubToken"]);
        const client = new GitHubClient(githubToken);
        const repo = await client.createRepo(message.baseName || "GFG-Hub");
        sendResponse({ ok: true, repo });
      } catch (err) {
        sendResponse({ ok: false, reason: err.message });
      }
    })();
    return true;
  }

  return false;
});

log.info("GFG Hub background service worker started.");
