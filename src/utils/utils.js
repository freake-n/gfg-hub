/**
 * utils.js
 * Small, dependency-free helpers shared across background / content / popup / options.
 * Exported as ES module functions — imported directly where needed.
 */

/** Simple leveled logger so console noise can be toggled without touching call sites. */
export const log = {
  info: (...args) => console.log("[GFG Hub]", ...args),
  warn: (...args) => console.warn("[GFG Hub]", ...args),
  error: (...args) => console.error("[GFG Hub]", ...args),
};

/** Debounce: collapse rapid repeated calls (e.g. MutationObserver storms) into one. */
export function debounce(fn, waitMs = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

/**
 * Encode a UTF-8 string to base64 safely (btoa alone mangles non-Latin1 chars,
 * which matters for problem statements/code containing special characters).
 */
export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

/** Decode base64 (as returned by the GitHub Contents API) back to a UTF-8 string. */
export function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Turn an arbitrary problem/tag name into a safe, readable folder/file name. */
export function sanitizeName(name) {
  return name
    .trim()
    .replace(/[\\/:*?"<>|]/g, "") // characters illegal in file paths (also invalid on GitHub trees)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Convert a problem title to kebab-case for use in folder/file names.
 * Matches LeetHub's toKebabCase from gfg.js.
 * e.g. "Sum Of Digits" → "sum-of-digits"
 */
export function toKebabCase(str) {
  return str
    .trim()
    .replace(/[^a-zA-Z0-9\s]/g, '')    // remove special chars (keep alphanumeric + spaces)
    .replace(/([a-z])([A-Z])/g, '$1-$2') // camelCase → kebab
    .replace(/[\s_]+/g, '-')             // spaces/underscores → dash
    .replace(/-+/g, '-')                 // collapse multiple dashes
    .replace(/^-+|-+$/g, '')             // trim leading/trailing dashes
    .toLowerCase();
}

/** Map a GFG-reported language string to a normalized language + file extension. */
const LANGUAGE_EXTENSIONS = {
  c: "c",
  "c++": "cpp",
  cpp: "cpp",
  "c++14": "cpp",
  "c++17": "cpp",
  java: "java",
  python: "py",
  python3: "py",
  javascript: "js",
  typescript: "ts",
  go: "go",
  golang: "go",
  rust: "rs",
  kotlin: "kt",
  "c#": "cs",
  csharp: "cs",
  php: "php",
  swift: "swift",
};

export function extensionForLanguage(langRaw) {
  if (!langRaw) return "txt";
  const key = langRaw.trim().toLowerCase();
  return LANGUAGE_EXTENSIONS[key] || "txt";
}

/** Format a Date as YYYY-MM-DD (used in README "Solved on" line). */
export function formatDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Pick the primary GFG topic tag to use as the top-level repo folder (e.g. "Arrays", "Graph", "DP"). */
const CATEGORY_ALIASES = {
  "dynamic programming": "DP",
  "graphs": "Graph",
  "linked list": "Linked List",
  "bit manipulation": "Bit Manipulation",
};

export function primaryCategory(tags = []) {
  if (!tags.length) return "Uncategorized";
  const first = tags[0].trim();
  const alias = CATEGORY_ALIASES[first.toLowerCase()];
  return sanitizeName(alias || first);
}

/** Wrap chrome.storage.local in promises since MV3 service workers prefer async/await. */
export const storage = {
  get: (keys) =>
    new Promise((resolve) => chrome.storage.local.get(keys, resolve)),
  set: (obj) =>
    new Promise((resolve) => chrome.storage.local.set(obj, resolve)),
  remove: (keys) =>
    new Promise((resolve) => chrome.storage.local.remove(keys, resolve)),
};

/** Fire a Chrome desktop notification (falls back to console if permission missing). */
export function notify(title, message, isError = false) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("src/assets/icons/icon128.png"),
      title,
      message,
      priority: isError ? 2 : 0,
    });
  } catch (e) {
    log.warn("Notification failed, falling back to console:", title, message);
  }
}
