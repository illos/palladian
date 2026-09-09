/** Logical client contracts, NOT generated Convex IDs or authorization capabilities.
 * P2 must adapt these at backend boundaries using generated Id<Table> types. */
declare const brand: unique symbol;
export type PlatformId<Kind extends string> = string & {
  readonly [brand]: Kind;
};
export type UserId = PlatformId<"user">;
export type WorkspaceId = PlatformId<"workspace">;
export type InstanceId = PlatformId<"instance">;
export type ResourceId = PlatformId<"resource">;
export type FileId = PlatformId<"file">;
export type DefinitionId = "notes" | "recipes";
export type ResourceType<D extends DefinitionId> = D extends "notes"
  ? "note"
  : "recipe";
export type Presentation = "integrated" | "standalone";
export interface AppInstance<D extends DefinitionId = DefinitionId> {
  readonly id: InstanceId;
  readonly workspaceId: WorkspaceId;
  readonly definitionId: D;
  readonly title: string;
  readonly lifecycle: "active" | "archived";
  readonly preferencesVersion: number;
}
export type ResourceTarget = {
  [D in DefinitionId]: {
    readonly definitionId: D;
    readonly instanceId: InstanceId;
    readonly resourceType: ResourceType<D>;
    readonly resourceId: ResourceId;
  };
}[DefinitionId];
export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION"
  | "RATE_LIMITED"
  | "TEMPORARY";
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: { readonly code: ErrorCode; readonly message: string };
    };
export interface Page<T> {
  readonly items: readonly T[];
  readonly cursor: string | null;
}
export interface SearchHit {
  readonly target: ResourceTarget;
  readonly title: string;
  readonly snippet: string;
  readonly sourceRevision: number;
}
export interface ResourceSummary {
  readonly target: ResourceTarget;
  readonly title: string;
  readonly revision: number;
}
export type AuthReadiness =
  "not-configured" | "resolving" | "authenticated" | "session-invalid";
export type Connectivity = "online" | "reconnecting" | "offline";
export type SaveStatus = "unchanged" | "pending" | "acknowledged" | "failed";
export type ThemePreference = "light" | "dark" | "system";
export const LIMITS = Object.freeze({
  listPage: 25,
  maxListPage: 100,
  searchPage: 20,
  maxSearchPage: 50,
  fileBytes: 100 * 1024 * 1024,
  downloadGrantSeconds: 300,
});
/** Scope checks are server responsibilities even when a target is well typed. */
export interface ResourceService {
  resolve(target: ResourceTarget): Promise<Result<ResourceSummary>>;
  search(input: {
    workspaceId: WorkspaceId;
    instanceId?: InstanceId;
    text: string;
    cursor: string | null;
    limit: number;
  }): Promise<Result<Page<SearchHit>>>;
}
