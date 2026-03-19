import { query, mutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";

// ============================================================================
// List Agents
// ============================================================================

export const listPublicPage = query({
  args: {
    limit: "number",
    cursor: "string | null",
  },
  handler: async (ctx, args) => {
    const agents = ctx.db.query("agents").withIndex("by_active_updated");
    const items: Array<{
      slug: string;
      displayName: string;
      summary: string | null;
      stats: unknown;
      createdAt: number;
      updatedAt: number;
      latestVersion: { version: string; createdAt: number; changelog: string } | null;
    }> = [];

    let count = 0;
    let lastId: Id<"agents"> | null = null;

    for await (const agent of agents) {
      if (agent.softDeletedAt !== undefined) continue;
      if (args.cursor && agent._id.toString() === args.cursor) continue;
      if (count >= args.limit) {
        lastId = agent._id;
        break;
      }

      const latestVersion = agent.latestVersionId
        ? await ctx.db.get(agent.latestVersionId)
        : null;

      items.push({
        slug: agent.slug,
        displayName: agent.displayName,
        summary: agent.summary ?? null,
        stats: agent.stats,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
        latestVersion: latestVersion
          ? {
              version: latestVersion.version,
              createdAt: latestVersion.createdAt,
              changelog: latestVersion.changelog,
            }
          : null,
      });
      count++;
    }

    return { items, nextCursor: lastId ? lastId.toString() : null };
  },
});

// ============================================================================
// Get Agent by Slug
// ============================================================================

export const getBySlug = query({
  args: { slug: "string" },
  handler: async (ctx, args) => {
    const agents = ctx.db.query("agents").withIndex("by_slug", (q) =>
      q.eq("slug", args.slug),
    );
    const agent = await agents.filter((q) =>
      q.eq(q.field("softDeletedAt"), undefined),
    ).first();

    if (!agent) return null;

    const latestVersion = agent.latestVersionId
      ? await ctx.db.get(agent.latestVersionId)
      : null;
    const ownerUser = await ctx.db.get(agent.ownerUserId);

    return {
      agent: {
        _id: agent._id,
        slug: agent.slug,
        displayName: agent.displayName,
        summary: agent.summary ?? null,
        description: agent.description ?? null,
        tags: agent.tags,
        stats: agent.stats,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      },
      latestVersion: latestVersion
        ? {
            version: latestVersion.version,
            createdAt: latestVersion.createdAt,
            changelog: latestVersion.changelog,
          }
        : null,
      owner: ownerUser
        ? {
            _id: ownerUser._id,
            handle: ownerUser.handle ?? undefined,
            displayName: ownerUser.displayName ?? undefined,
            image: ownerUser.image ?? undefined,
          }
        : null,
    };
  },
});

// ============================================================================
// Get Version by Slug and Version
// ============================================================================

export const getVersionBySlug = query({
  args: { slug: "string", version: "string" },
  handler: async (ctx, args) => {
    const agents = ctx.db.query("agents").withIndex("by_slug", (q) =>
      q.eq("slug", args.slug),
    );
    const agent = await agents.filter((q) =>
      q.eq(q.field("softDeletedAt"), undefined),
    ).first();

    if (!agent) return null;

    const versions = ctx.db
      .query("agentVersions")
      .withIndex("by_agent_version", (q) =>
        q.eq("agentId", agent._id).eq("version", args.version),
      );
    const versionRecord = await versions.first();

    if (!versionRecord) return null;

    return {
      version: {
        version: versionRecord.version,
        createdAt: versionRecord.createdAt,
        changelog: versionRecord.changelog,
        files: versionRecord.files,
      },
      agent: {
        slug: agent.slug,
        displayName: agent.displayName,
      },
    };
  },
});

// ============================================================================
// Get Download Info
// ============================================================================

export const getDownloadInfo = query({
  args: { slug: "string", version: "string | null" },
  handler: async (ctx, args) => {
    const agents = ctx.db.query("agents").withIndex("by_slug", (q) =>
      q.eq("slug", args.slug),
    );
    const agent = await agents.filter((q) =>
      q.eq(q.field("softDeletedAt"), undefined),
    ).first();

    if (!agent) return null;

    let versionRecord;
    if (args.version) {
      const versions = ctx.db
        .query("agentVersions")
        .withIndex("by_agent_version", (q) =>
          q.eq("agentId", agent._id).eq("version", args.version),
        );
      versionRecord = await versions.first();
    } else {
      versionRecord = agent.latestVersionId
        ? await ctx.db.get(agent.latestVersionId)
        : null;
    }

    if (!versionRecord) return null;

    return {
      version: versionRecord.version,
      files: versionRecord.files,
      agentSlug: agent.slug,
    };
  },
});

// ============================================================================
// Publish Agent
// ============================================================================

export const publish = mutation({
  args: {
    slug: "string",
    displayName: "string",
    version: "string",
    changelog: "string",
    tags: "array",
    files: "array",
  },
  handler: async (ctx, args) => {
    const existingAgents = ctx.db
      .query("agents")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug));
    const existing = await existingAgents.first();

    if (existing) {
      throw new Error("Slug already taken");
    }

    const semverRegex = /^(\d+)\.(\d+)\.(\d+)(-[a-zA-Z0-9.]+)?$/;
    if (!semverRegex.test(args.version)) {
      throw new Error("Invalid version format. Use semver (e.g., 1.0.0)");
    }

    const now = Date.now();

    // Create version first
    const versionId = await ctx.db.insert("agentVersions", {
      agentId: existing?._id ?? "" as Id<"agents">,
      version: args.version,
      fingerprint: null,
      changelog: args.changelog,
      files: [],
      createdBy: "" as Id<"users">,
      createdAt: now,
    });

    // Create agent
    const agentId = await ctx.db.insert("agents", {
      slug: args.slug,
      displayName: args.displayName,
      summary: null,
      description: null,
      ownerUserId: "" as Id<"users">,
      latestVersionId: versionId,
      latestVersionSummary: { version: args.version, createdAt: now, changelog: args.changelog },
      tags: { latest: versionId },
      stats: {
        downloads: 0,
        stars: 0,
        versions: 1,
        comments: 0,
      },
      createdAt: now,
      updatedAt: now,
    });

    // Update version with agentId
    await ctx.db.patch(versionId, { agentId });

    return { ok: true, versionId: versionId.toString() };
  },
});
