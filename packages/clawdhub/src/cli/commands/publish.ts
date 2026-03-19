import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import semver from "semver";
import { apiRequestForm } from "../../http.js";
import { ApiRoutes, ApiV1PublishResponseSchema } from "../../schema/index.js";
import { listTextFiles } from "../../skills.js";
import { listAgentFiles } from "../../agents.js";
import { requireAuthToken } from "../authToken.js";
import { getRegistry } from "../registry.js";
import { sanitizeSlug, titleCase } from "../slug.js";
import type { GlobalOpts } from "../types.js";
import { createSpinner, fail, formatError } from "../ui.js";

export type PublishType = "skill" | "agent";

export async function cmdPublish(
  opts: GlobalOpts,
  identifier: string,
  options: {
    slug?: string;
    name?: string;
    version?: string;
    changelog?: string;
    tags?: string;
    forkOf?: string;
    type?: PublishType;
  },
) {
  const token = await requireAuthToken();
  const registry = await getRegistry(opts, { cache: true });
  const publishType: PublishType = options.type ?? "skill";

  let folder: string;
  let slug: string;
  let displayName: string;

  if (publishType === "agent") {
    // For agents, identifier is the agent-id from openclaw.json
    const agentConfig = await resolveAgentFromConfig(identifier);
    folder = agentConfig.workspace;
    slug = options.slug ?? agentConfig.id;
    displayName = options.name ?? agentConfig.name ?? titleCase(slug);
  } else {
    // For skills, identifier is a folder path
    folder = resolve(opts.workdir, identifier);
    const folderStat = await stat(folder).catch(() => null);
    if (!folderStat || !folderStat.isDirectory()) fail("Path must be a folder");
    slug = options.slug ?? sanitizeSlug(basename(folder));
    displayName = options.name ?? titleCase(basename(folder));
  }

  const version = options.version;
  const changelog = options.changelog ?? "";
  const tagsValue = options.tags ?? "latest";
  const tags = tagsValue
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  const forkOfRaw = options.forkOf?.trim();
  const forkOf = forkOfRaw ? parseForkOf(forkOfRaw) : undefined;

  if (!slug) fail("--slug required");
  if (!displayName) fail("--name required");
  if (!version || !semver.valid(version)) fail("--version must be valid semver");

  const spinner = createSpinner(`Preparing ${slug}@${version}`);
  try {
    // Use appropriate file listing based on type
    // Agent files are filtered to exclude privacy-sensitive content
    const filesOnDisk =
      publishType === "agent"
        ? await listAgentFiles(folder)
        : await listTextFiles(folder);

    if (filesOnDisk.length === 0) fail("No files found");

    // Check required files based on type
    if (publishType === "skill") {
      if (
        !filesOnDisk.some((file) => {
          const lower = file.relPath.toLowerCase();
          return lower === "skill.md" || lower === "skills.md";
        })
      ) {
        fail("SKILL.md required for skill");
      }
    } else {
      // For agents, the workspace IS the workspace directory (not a subdirectory)
      // Check for at least one identity file (SOUL.md, AGENTS.md, IDENTITY.md)
      const hasIdentity = filesOnDisk.some((file) => {
        const lower = file.relPath.toLowerCase();
        return lower === "soul.md" || lower === "agents.md" || lower === "identity.md";
      });
      if (!hasIdentity) {
        fail("Agent workspace must contain at least one identity file (SOUL.md, AGENTS.md, or IDENTITY.md)");
      }
    }

    const apiPath = publishType === "agent" ? ApiRoutes.agents : ApiRoutes.skills;

    const form = new FormData();
    form.set(
      "payload",
      JSON.stringify({
        slug,
        displayName,
        version,
        changelog,
        acceptLicenseTerms: true,
        tags,
        ...(forkOf ? { forkOf } : {}),
      }),
    );

    let index = 0;
    for (const file of filesOnDisk) {
      index += 1;
      spinner.text = `Uploading ${file.relPath} (${index}/${filesOnDisk.length})`;
      const blob = new Blob([Buffer.from(file.bytes)], { type: file.contentType ?? "text/plain" });
      form.append("files", blob, file.relPath);
    }

    spinner.text = `Publishing ${slug}@${version} (${publishType})`;
    const result = await apiRequestForm(
      registry,
      { method: "POST", path: apiPath, token, form },
      ApiV1PublishResponseSchema,
    );

    spinner.succeed(`OK. Published ${slug}@${version} (${result.versionId})`);
  } catch (error) {
    spinner.fail(formatError(error));
    throw error;
  }
}

type OpenClawAgentConfig = {
  id: string;
  name?: string;
  workspace: string;
};

async function resolveAgentFromConfig(agentId: string): Promise<OpenClawAgentConfig> {
  const openclawConfigPath = join(process.env.HOME ?? "~", ".openclaw", "openclaw.json");

  let configData: { agents?: { list?: Array<{ id: string; workspace?: string; name?: string }> } };
  try {
    const raw = await readFile(openclawConfigPath, "utf8");
    configData = JSON.parse(raw);
  } catch {
    fail(`Could not read OpenClaw config at ${openclawConfigPath}`);
    throw new Error("unreachable");
  }

  const agents = configData.agents?.list ?? [];
  const agent = agents.find((a) => a.id === agentId);

  if (!agent) {
    fail(`Agent '${agentId}' not found in OpenClaw config. Available agents: ${agents.map((a) => a.id).join(", ") || "none"}`);
    throw new Error("unreachable");
  }

  if (!agent.workspace) {
    fail(`Agent '${agentId}' has no workspace configured`);
    throw new Error("unreachable");
  }

  // Verify workspace exists
  const workspaceStat = await stat(agent.workspace).catch(() => null);
  if (!workspaceStat || !workspaceStat.isDirectory()) {
    fail(`Agent workspace not found: ${agent.workspace}`);
    throw new Error("unreachable");
  }

  return {
    id: agent.id,
    name: agent.name,
    workspace: agent.workspace,
  };
}

function parseForkOf(value: string) {
  const trimmed = value.trim();
  const [slugRaw, versionRaw] = trimmed.split("@");
  const slug = (slugRaw ?? "").trim().toLowerCase();
  if (!slug) fail("--fork-of must be <slug> or <slug@version>");
  const version = (versionRaw ?? "").trim();
  if (version && !semver.valid(version)) fail("--fork-of version must be valid semver");
  return { slug, version: version || undefined };
}
