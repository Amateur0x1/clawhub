import { api } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { parseBearerToken } from "../lib/httpRateLimit";
import { json, text } from "./shared";

// ============================================================================
// List Agents
// ============================================================================

export async function listAgentsV1Handler(
  ctx: ActionCtx,
  request: Request,
): Promise<Response> {
  const token = parseBearerToken(request);

  const result = await ctx.runQuery(api.agents.listPublicPage, {
    limit: 25,
    cursor: null,
  });

  return json({ items: result.items, nextCursor: result.nextCursor });
}

// ============================================================================
// Get Agent by Slug
// ============================================================================

export async function agentsGetRouterV1Handler(
  ctx: ActionCtx,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const agentsIndex = pathParts.indexOf("agents");
  const slug = pathParts[agentsIndex + 1];
  const remainder = pathParts.slice(agentsIndex + 2).join("/");

  if (!slug) {
    return text("Agent slug required", 400);
  }

  if (remainder === "download") {
    const version = url.searchParams.get("version") ?? undefined;
    return getAgentDownloadHandler(ctx, slug, version);
  }

  if (remainder.startsWith("versions/")) {
    const version = remainder.replace("versions/", "").split("/")[0];
    if (version) {
      return getAgentVersionHandler(ctx, slug, version);
    }
  }

  return getAgentHandler(ctx, slug);
}

async function getAgentHandler(ctx: ActionCtx, slug: string): Promise<Response> {
  const result = await ctx.runQuery(api.agents.getBySlug, { slug });

  if (!result) {
    return text("Agent not found", 404);
  }

  return json(result);
}

async function getAgentVersionHandler(
  ctx: ActionCtx,
  slug: string,
  version: string,
): Promise<Response> {
  const result = await ctx.runQuery(api.agents.getVersionBySlug, { slug, version });

  if (!result) {
    return text("Version not found", 404);
  }

  return json(result);
}

async function getAgentDownloadHandler(
  ctx: ActionCtx,
  slug: string,
  version?: string,
): Promise<Response> {
  const result = await ctx.runQuery(api.agents.getDownloadInfo, { slug, version: version ?? null });

  if (!result) {
    return text("Agent or version not found", 404);
  }

  return json(result);
}

// ============================================================================
// Publish Agent
// ============================================================================

export async function publishAgentV1Handler(
  ctx: ActionCtx,
  request: Request,
): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  let slug: string;
  let displayName: string;
  let version: string;
  let changelog: string;
  let tags: string[];
  let files: Array<{ name: string; data: Uint8Array; contentType: string }>;

  if (contentType.includes("multipart/form-data")) {
    return text("Multipart publish not yet implemented", 501);
  } else {
    const payload = await request.json() as {
      slug?: string;
      displayName?: string;
      version?: string;
      changelog?: string;
      tags?: string[];
    };

    if (!payload.slug || !payload.displayName || !payload.version) {
      return text("Missing required fields: slug, displayName, version", 400);
    }
    slug = payload.slug;
    displayName = payload.displayName;
    version = payload.version;
    changelog = payload.changelog ?? "";
    tags = payload.tags ?? [];
    files = [];
  }

  try {
    const result = await ctx.runMutation(api.agents.publish, {
      slug,
      displayName,
      version,
      changelog,
      tags,
      files,
    });

    return json(result, 201);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message.includes("Slug already taken")) {
      return text("Slug already taken", 409);
    }
    if (message.includes("Invalid version")) {
      return text("Invalid version format. Use semver (e.g., 1.0.0)", 400);
    }
    return text(message, 500);
  }
}
