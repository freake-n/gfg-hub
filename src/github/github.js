/**
 * github.js
 * Thin wrapper around the GitHub REST API (v3, /repos + /user endpoints).
 *
 * AUTH MODEL: this extension uses a user-supplied Personal Access Token (PAT)
 * rather than a full OAuth App login. That's a deliberate choice — OAuth's
 * "Sign in with GitHub" flow requires a server to exchange the auth code for
 * a token (the client secret can't live safely inside an extension), and
 * this project is built to run with zero backend / zero hosting cost.
 * A PAT with just the "repo" scope gives identical end-to-end functionality.
 * See README.md "Optional: real OAuth" for how to upgrade this later.
 */

import { utf8ToBase64, base64ToUtf8, log } from "../utils/utils.js";

const API_BASE = "https://api.github.com";

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

export class GitHubClient {
  constructor(token) {
    this.token = token;
  }

  async _request(path, options = {}) {
    if (!this.token) {
      throw new GitHubError("No GitHub token configured", 401);
    }
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });

    if (res.status === 401) {
      throw new GitHubError("GitHub token expired or invalid", 401);
    }
    if (res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining === "0") {
        throw new GitHubError("GitHub API rate limit exceeded", 403);
      }
      throw new GitHubError("GitHub API access forbidden (check token scopes)", 403);
    }
    if (res.status === 404) {
      throw new GitHubError("Not found (repo may be deleted/renamed)", 404);
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json()).message || "";
      } catch (_) {
        /* ignore parse failure */
      }
      throw new GitHubError(`GitHub API error ${res.status}: ${detail}`, res.status);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  /** Validate the token and return the authenticated user's login. */
  async getAuthenticatedUser() {
    return this._request("/user");
  }

  /** List repos owned by / accessible to the user (most recently pushed first). */
  async listRepos() {
    const repos = await this._request(
      "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator"
    );
    return repos.map((r) => ({
      fullName: r.full_name,
      name: r.name,
      owner: r.owner.login,
      private: r.private,
      defaultBranch: r.default_branch,
    }));
  }

  /** Create a new private repo, auto-suffixing the name if it already exists. */
  async createRepo(baseName = "GFG-Hub") {
    const user = await this.getAuthenticatedUser();
    let name = baseName;
    let suffix = 2;
    // Probe for name collisions and increment suffix until free.
    while (await this._repoExists(user.login, name)) {
      name = `${baseName}-${suffix}`;
      suffix += 1;
    }
    const created = await this._request("/user/repos", {
      method: "POST",
      body: JSON.stringify({
        name,
        private: true,
        auto_init: true, // ensures README.md + a default branch exist immediately
        description: "My GeeksforGeeks solutions, auto-synced by GFG Hub.",
      }),
    });
    return {
      fullName: created.full_name,
      name: created.name,
      owner: created.owner.login,
      private: created.private,
      defaultBranch: created.default_branch,
    };
  }

  async _repoExists(owner, name) {
    try {
      await this._request(`/repos/${owner}/${name}`);
      return true;
    } catch (e) {
      if (e.status === 404) return false;
      throw e;
    }
  }

  /** Fetch a file's sha + decoded content, or null if it doesn't exist yet. */
  async getFile(owner, repo, path, branch) {
    try {
      const data = await this._request(
        `/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`
      );
      return { sha: data.sha, content: base64ToUtf8(data.content) };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Create or update a single file.
   * Automatically retries once on 409 (SHA conflict) by re-fetching the
   * current SHA from GitHub and retrying after a short delay — the same
   * pattern used by LeetHub-2.0's uploadGitWith409Retry.
   */
  async putFile({ owner, repo, path, branch, content, message, sha }) {
    const url = `/repos/${owner}/${repo}/contents/${encodeURI(path)}`;
    const body = {
      message,
      content: utf8ToBase64(content),
      branch,
      ...(sha ? { sha } : {}),
    };

    try {
      return await this._request(url, { method: "PUT", body: JSON.stringify(body) });
    } catch (err) {
      if (err.status !== 409) throw err;

      // 409 Conflict: our SHA is stale. Re-fetch the live SHA and retry once.
      log.warn(`409 conflict on ${path} — re-fetching SHA and retrying…`);
      const current = await this.getFile(owner, repo, path, branch);
      const freshSha = current?.sha;

      // Wait 500 ms so GitHub's API has time to settle (LeetHub uses this too)
      await new Promise(r => setTimeout(r, 500));

      return this._request(url, {
        method: "PUT",
        body: JSON.stringify({ ...body, sha: freshSha }),
      });
    }
  }
}

export default GitHubClient;
