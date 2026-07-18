import { storage } from "../utils/utils.js";

const el = (id) => document.getElementById(id);

function sendMessage(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

// ---- Render: decide which view to show based on stored state ----------------

async function render() {
  const { githubToken, repoConfig, githubUser, syncCount, lastSync, settings } =
    await storage.get(["githubToken", "repoConfig", "githubUser", "syncCount", "lastSync", "settings"]);

  el("view-connect").classList.toggle("hidden", Boolean(githubToken));
  el("view-repo").classList.toggle("hidden",    !(githubToken && !repoConfig));
  el("view-status").classList.toggle("hidden",  !(githubToken && repoConfig));

  if (githubToken && !repoConfig) {
    el("avatar").src          = githubUser?.avatarUrl || "";
    el("login-name").textContent = githubUser?.login || "";
    await loadRepoList();
  }

  if (githubToken && repoConfig) {
    el("avatar-2").src             = githubUser?.avatarUrl || "";
    el("login-name-2").textContent  = githubUser?.login || "";
    el("repo-name-display").textContent = repoConfig.fullName;
    el("branch-display").textContent    = settings?.branch || repoConfig.defaultBranch || "main";
    el("sync-count-display").textContent = String(syncCount || 0);
    el("last-sync-display").textContent  = lastSync
      ? `${lastSync.title} (${new Date(lastSync.date).toLocaleDateString()})`
      : "—";
  }
}

// ---- Repo list loader --------------------------------------------------------

async function loadRepoList() {
  const select = el("repo-select");
  select.innerHTML = `<option>Loading…</option>`;
  const res = await sendMessage({ type: "LIST_REPOS" });
  if (!res?.ok) {
    select.innerHTML = `<option>Could not load repos</option>`;
    return;
  }
  select.innerHTML = res.repos
    .map((r) => `<option value="${r.fullName}">${r.fullName}${r.private ? " 🔒" : ""}</option>`)
    .join("");
  select.dataset.repos = JSON.stringify(res.repos);
}

// ---- Step 1: OAuth with GitHub -----------------------------------------------

el("oauth-btn").addEventListener("click", async () => {
  const btn     = el("oauth-btn");
  const btnText = el("oauth-btn-text");
  const spinner = el("oauth-spinner");
  const errEl   = el("oauth-error");

  errEl.classList.add("hidden");
  btn.disabled = true;
  btnText.textContent = "Authorizing…";
  spinner.classList.remove("hidden");

  const res = await sendMessage({ type: "GITHUB_OAUTH" });

  btn.disabled = false;
  btnText.textContent = "Authorize with GitHub";
  spinner.classList.add("hidden");

  if (!res?.ok) {
    // User cancelled the popup → don't show an error; just re-enable button.
    const cancelled =
      !res?.reason ||
      res.reason.toLowerCase().includes("cancel") ||
      res.reason.toLowerCase().includes("closed");

    if (!cancelled) {
      errEl.textContent = `Authorization failed: ${res?.reason || "unknown error"}`;
      errEl.classList.remove("hidden");
    }
    return;
  }

  render();
});

// ---- Step 2: repo selection --------------------------------------------------

el("tab-existing").addEventListener("click", () => switchTab("existing"));
el("tab-new").addEventListener("click",      () => switchTab("new"));

function switchTab(which) {
  el("tab-existing").classList.toggle("active",  which === "existing");
  el("tab-new").classList.toggle("active",       which === "new");
  el("panel-existing").classList.toggle("hidden", which !== "existing");
  el("panel-new").classList.toggle("hidden",      which !== "new");
}

el("select-repo-btn").addEventListener("click", async () => {
  const select = el("repo-select");
  const repos  = JSON.parse(select.dataset.repos || "[]");
  const chosen = repos.find((r) => r.fullName === select.value);
  if (!chosen) return;
  await storage.set({ repoConfig: chosen });
  render();
});

el("create-repo-btn").addEventListener("click", async () => {
  const name = el("new-repo-name").value.trim() || "GFG-Hub";
  el("create-repo-btn").disabled    = true;
  el("create-repo-btn").textContent = "Creating…";
  const res = await sendMessage({ type: "CREATE_REPO", baseName: name });
  el("create-repo-btn").disabled    = false;
  el("create-repo-btn").textContent = "Create private repo";

  if (!res?.ok) {
    el("repo-error").textContent = `Could not create repo: ${res?.reason || "unknown error"}`;
    el("repo-error").classList.remove("hidden");
    return;
  }
  await storage.set({ repoConfig: res.repo });
  render();
});

// ---- Step 3: status view -----------------------------------------------------

el("open-repo-btn").addEventListener("click", async () => {
  const { repoConfig } = await storage.get(["repoConfig"]);
  if (repoConfig) chrome.tabs.create({ url: `https://github.com/${repoConfig.fullName}` });
});

el("open-options-btn").addEventListener("click", () => chrome.runtime.openOptionsPage());

el("logout-btn").addEventListener("click",   logout);
el("logout-btn-2").addEventListener("click", logout);

async function logout() {
  await storage.remove(["githubToken", "githubUser", "repoConfig"]);
  render();
}

render();
