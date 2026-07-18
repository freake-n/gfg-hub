import { storage } from "../utils/utils.js";

const el = (id) => document.getElementById(id);

const DEFAULT_SETTINGS = {
  autoCommit: true,
  autoReadme: true,
  branch: "",
  visibility: "private",
  theme: "system",
};

async function load() {
  const { settings, githubUser, repoConfig } = await storage.get([
    "settings",
    "githubUser",
    "repoConfig",
  ]);
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };

  el("auto-commit").checked = s.autoCommit;
  el("auto-readme").checked = s.autoReadme;
  el("branch").value = s.branch || "";
  el("visibility").value = s.visibility;
  el("theme").value = s.theme;

  el("account-summary").textContent = githubUser
    ? `Connected as ${githubUser.login}${repoConfig ? ` — ${repoConfig.fullName}` : " (no repo selected)"}`
    : "Not connected. Open the popup to connect GitHub.";
}

el("save-btn").addEventListener("click", async () => {
  const settings = {
    autoCommit: el("auto-commit").checked,
    autoReadme: el("auto-readme").checked,
    branch: el("branch").value.trim() || null,
    visibility: el("visibility").value,
    theme: el("theme").value,
  };
  await storage.set({ settings });
  const confirmEl = el("save-confirm");
  confirmEl.classList.remove("hidden");
  setTimeout(() => confirmEl.classList.add("hidden"), 1800);
});

el("logout-btn").addEventListener("click", async () => {
  await storage.remove(["githubToken", "githubUser", "repoConfig"]);
  load();
});

load();
