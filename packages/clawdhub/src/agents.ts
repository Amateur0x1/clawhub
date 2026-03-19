import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { unzipSync } from "fflate";
import ignore from "ignore";
import mime from "mime";
import { type Lockfile, LockfileSchema, parseArk } from "./schema/index.js";

const DOT_DIR = ".agenthub";
const DOT_IGNORE = ".agenthubignore";

// Default ignores for agent distribution (privacy-sensitive files)
const DEFAULT_AGENT_IGNORES = [
  ".git/",
  "node_modules/",
  `${DOT_DIR}/`,
  // Privacy files (NEVER publish)
  "USER.md",
  "MEMORY.md",
  "memory/",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "TOOLS.md",
  // System directories
  ".openclaw/",
  // Workspace memory subdirectory
  "workspace/memory/",
];

export type AgentOrigin = {
  version: 1;
  registry: string;
  slug: string;
  installedVersion: string;
  installedAt: number;
};

export async function extractAgentZipToDir(zipBytes: Uint8Array, targetDir: string) {
  const entries = unzipSync(zipBytes);
  await mkdir(targetDir, { recursive: true });
  for (const [rawPath, data] of Object.entries(entries)) {
    const safePath = sanitizeRelPath(rawPath);
    if (!safePath) continue;
    const outPath = join(targetDir, safePath);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, data);
  }
}

export async function listAgentFiles(root: string) {
  const files: Array<{ relPath: string; bytes: Uint8Array; contentType?: string }> = [];
  const absRoot = resolve(root);
  const ig = ignore();

  // Add default agent ignores (privacy-sensitive files)
  ig.add(DEFAULT_AGENT_IGNORES);

  // Add user's custom .agenthubignore if exists
  await addIgnoreFile(ig, join(absRoot, DOT_IGNORE));

  // Also respect .gitignore for commonly ignored patterns
  await addIgnoreFile(ig, join(absRoot, ".gitignore"));

  await walk(absRoot, async (absPath) => {
    const relPath = normalizePath(relative(absRoot, absPath));
    if (!relPath) return;
    if (ig.ignores(relPath)) return;
    const ext = relPath.split(".").at(-1)?.toLowerCase() ?? "";
    // For agents, we include all text files (not just code/text extensions)
    // but skip binary files
    if (!ext) return;
    const buffer = await readFile(absPath);
    const contentType = mime.getType(relPath) ?? "text/plain";
    files.push({ relPath, bytes: new Uint8Array(buffer), contentType });
  });
  return files;
}

export type AgentFileHash = { path: string; sha256: string; size: number };

export function sha256Hex(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildAgentFingerprint(files: Array<{ path: string; sha256: string }>) {
  const normalized = files
    .filter((file) => Boolean(file.path) && Boolean(file.sha256))
    .map((file) => ({ path: file.path, sha256: file.sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const payload = normalized.map((file) => `${file.path}:${file.sha256}`).join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

export function hashAgentFiles(files: Array<{ relPath: string; bytes: Uint8Array }>) {
  const hashed = files.map((file) => ({
    path: file.relPath,
    sha256: sha256Hex(file.bytes),
    size: file.bytes.byteLength,
  }));
  return { files: hashed, fingerprint: buildAgentFingerprint(hashed) };
}

export async function readAgentLockfile(workdir: string): Promise<Lockfile["agents"]> {
  try {
    const raw = await readFile(join(workdir, DOT_DIR, "lock.json"), "utf8");
    const parsed = JSON.parse(raw);
    const lock = parseArk(LockfileSchema, parsed, "Lockfile");
    return lock.agents ?? {};
  } catch {
    return {};
  }
}

export async function writeAgentLockfile(workdir: string, agents: Lockfile["agents"]) {
  const lockPath = join(workdir, DOT_DIR, "lock.json");
  await mkdir(dirname(lockPath), { recursive: true });
  // Read existing lockfile to preserve skills data
  let existingLock = {};
  try {
    const existingRaw = await readFile(lockPath, "utf8");
    existingLock = JSON.parse(existingRaw);
  } catch {
    // ignore
  }
  await writeFile(lockPath, `${JSON.stringify({ ...existingLock, agents }, null, 2)}\n`, "utf8");
}

export async function readAgentOrigin(agentFolder: string): Promise<AgentOrigin | null> {
  const paths = [
    join(agentFolder, DOT_DIR, "origin.json"),
    join(agentFolder, ".clawhub", "origin.json"), // Legacy compat
  ];
  for (const path of paths) {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1) return null;
      if (!parsed.registry || !parsed.slug || !parsed.installedVersion) return null;
      if (typeof parsed.installedAt !== "number" || !Number.isFinite(parsed.installedAt)) {
        return null;
      }
      return {
        version: 1,
        registry: String(parsed.registry),
        slug: String(parsed.slug),
        installedVersion: String(parsed.installedVersion),
        installedAt: parsed.installedAt,
      };
    } catch {
      // try next
    }
  }
  return null;
}

export async function writeAgentOrigin(agentFolder: string, origin: AgentOrigin) {
  const path = join(agentFolder, DOT_DIR, "origin.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(origin, null, 2)}\n`, "utf8");
}

function normalizePath(path: string) {
  return path.split("/").join("/").replace(/^\.\/+/, "");
}

function sanitizeRelPath(path: string) {
  const normalized = path.replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (!normalized || normalized.endsWith("/")) return null;
  if (normalized.includes("..") || normalized.includes("\\")) return null;
  return normalized;
}

async function walk(dir: string, onFile: (path: string) => Promise<void>) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, onFile);
      continue;
    }
    if (!entry.isFile()) continue;
    await onFile(full);
  }
}

async function addIgnoreFile(ig: ignore.Ignore, path: string) {
  try {
    const raw = await readFile(path, "utf8");
    ig.add(raw.split(/\r?\n/));
  } catch {
    // optional
  }
}
