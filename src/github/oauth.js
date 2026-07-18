/**
 * oauth.js
 * GitHub OAuth flow for GFG Hub using chrome.identity.launchWebAuthFlow.
 *
 * This follows the same zero-backend pattern used by LeetHub:
 *   1. Open GitHub's OAuth authorization page via launchWebAuthFlow.
 *   2. GitHub redirects to https://<extension-id>.chromiumapp.org/?code=xxx
 *   3. Chrome captures that redirect and gives us the URL.
 *   4. We extract the `code` and POST it to GitHub's token endpoint.
 *   5. GitHub responds with the access token — done, no server needed.
 *
 * ─── SETUP (one-time) ────────────────────────────────────────────────────────
 * 1. Go to https://github.com/settings/developers → "New OAuth App"
 * 2. Fill in:
 *      Application name  : GFG Hub
 *      Homepage URL      : https://github.com/  (or your repo URL)
 *      Callback URL      : https://amakgkmpfdiojdlnmbjmdkjpojfbiipd.chromiumapp.org
 *                          (find extension ID at chrome://extensions)
 * 3. Click "Register application", then "Generate a new client secret".
 * 4. Paste the Client ID and Client Secret below.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET } from "../../env.js";

/** Scopes we need: read/write repos, read user profile. */
const SCOPES = "repo user:email";

/**
 * Kick off the GitHub OAuth dance and resolve with the access token string.
 * Throws an Error if the user cancels or anything goes wrong.
 *
 * @returns {Promise<string>} GitHub personal access token (OAuth)
 */
export async function launchGitHubOAuth() {
  const redirectUri = chrome.identity.getRedirectURL();
  const state       = crypto.randomUUID(); // CSRF protection

  const authUrl = new URL("https://github.com/login/oauth/authorize");
  authUrl.searchParams.set("client_id",    GITHUB_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope",        SCOPES);
  authUrl.searchParams.set("state",        state);

  // Open GitHub's OAuth page in a Chrome identity popup.
  // Chrome will intercept the redirect to *.chromiumapp.org and return the URL.
  let redirectUrl;
  try {
    redirectUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        { url: authUrl.toString(), interactive: true },
        (url) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(url);
          }
        }
      );
    });
  } catch (err) {
    // User cancelled or the popup was blocked.
    throw new Error(`GitHub auth cancelled: ${err.message}`);
  }

  // Parse the code + state from the redirect URL.
  const params       = new URL(redirectUrl).searchParams;
  const returnedState = params.get("state");
  const code         = params.get("code");

  if (returnedState !== state) {
    throw new Error("OAuth state mismatch — possible CSRF attack.");
  }
  if (!code) {
    throw new Error("GitHub did not return an authorization code.");
  }

  // Exchange the code for a real access token.
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept":       "application/json",
    },
    body: JSON.stringify({
      client_id:     GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri:  redirectUri,
      state,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`Token exchange HTTP error: ${tokenResponse.status}`);
  }

  const tokenData = await tokenResponse.json();

  if (tokenData.error) {
    throw new Error(`GitHub token error: ${tokenData.error_description || tokenData.error}`);
  }
  if (!tokenData.access_token) {
    throw new Error("GitHub did not return an access token.");
  }

  return tokenData.access_token;
}
