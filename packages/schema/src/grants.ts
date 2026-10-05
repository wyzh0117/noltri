/**
 * 本地客户端授权 over the wire (V1 §12：`NOLTRI_DEV_TOKEN` 不再作为用户入口，替换为后台管理的本地客户端授权).
 *
 * Only two shapes here carry credential material: `issueGrantResponseSchema`, whose `secret` is handed
 * out exactly once and never stored in plaintext, and nothing else. A list of connections is therefore
 * safe to render, log and copy.
 */
import { z } from 'zod';

export const grantScopeSchema = z.enum(['capture', 'read', 'mutate']);
export type GrantScope = z.infer<typeof grantScopeSchema>;

/** One connection in 连接中心: what was allowed, to whom, and whether it still is. */
export const publicGrantSchema = z.object({
  id: z.string(),
  label: z.string(),
  client: z.string(),
  scopes: z.array(grantScopeSchema),
  /** `null` = 全部项目; a list means only those node ids may be read or changed. */
  nodeIds: z.array(z.string()).nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type PublicGrant = z.infer<typeof publicGrantSchema>;

export const grantListResponseSchema = z.object({ grants: z.array(publicGrantSchema) });
export type GrantListResponse = z.infer<typeof grantListResponseSchema>;

// --- POST /api/admin/grants ------------------------------------------------
export const issueGrantRequestSchema = z.object({
  label: z.string().trim().min(1).max(80),
  /** The actor written into version records; defaults to `mcp` when the client does not name itself. */
  client: z.string().trim().min(1).max(40).optional(),
  scopes: z.array(grantScopeSchema).min(1).max(3),
  /** Omit for 全部项目. An empty array is a mistake, not a request to allow nothing. */
  nodeIds: z.array(z.string().min(1)).min(1).max(100).optional(),
});
export type IssueGrantRequest = z.infer<typeof issueGrantRequestSchema>;

/** The one response in the whole API that carries a usable credential. */
export const issueGrantResponseSchema = z.object({
  grant: publicGrantSchema,
  secret: z.string().min(16),
});
export type IssueGrantResponse = z.infer<typeof issueGrantResponseSchema>;

export const revokeGrantResponseSchema = z.object({ grant: publicGrantSchema });
export type RevokeGrantResponse = z.infer<typeof revokeGrantResponseSchema>;
