import type {
  AuditAction,
  Dimension,
  DraftContentType,
  DefinitionAvailability,
  PromptEffort,
  UserRole,
  UserStatus,
  VersionStatus,
} from '../../schema';

// Metadata-only views for admin code (constitution III). Timestamps are ISO strings.

export interface AdminUserListItem {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  providers: string[];
  sourceCount: number;
  createdAt: string;
  lastSignInAt: string | null;
}

export interface AdminUserDetail {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  lastSignInAt: string | null;
  suspendedAt: string | null;
  identities: { provider: string; providerEmail: string | null; verified: boolean }[];
  sources: {
    id: string;
    type: string;
    accountLabel: string;
    status: string;
    itemCount: number;
    lastSyncAt: string | null;
    currentImport: { status: string; itemsProcessed: number; totalEstimate: number | null } | null;
  }[];
  profiles: {
    definitionName: string;
    status: string;
    versionCount: number;
    lastGeneratedAt: string | null;
  }[];
}

export interface VersionRef {
  id: string;
  versionNumber: number;
}

export interface AdminDefinitionListItem {
  id: string;
  key: string;
  availability: DefinitionAvailability;
  activeVersion: { id: string; versionNumber: number; name: string } | null;
  draftVersionId: string | null;
  userChoiceCount: number;
}

export interface DefinitionVersionView {
  id: string;
  versionNumber: number;
  status: VersionStatus;
  name: string;
  description: string;
  dimensions: Dimension[];
  createdAt: string;
  createdBy: string;
  publishedAt: string | null;
  publishedBy: string | null;
}

export interface AdminPromptListItem {
  id: string;
  key: string;
  isSystem: boolean;
  description: string;
  activeVersion: { id: string; versionNumber: number; model: string } | null;
  draftVersionId: string | null;
}

export interface PromptVersionView {
  id: string;
  versionNumber: number;
  status: VersionStatus;
  systemTemplate: string;
  userTemplate: string;
  model: string;
  effort: PromptEffort;
  maxTokens: number;
  changeNote: string | null;
  createdAt: string;
  createdBy: string;
  publishedAt: string | null;
  publishedBy: string | null;
}

export interface HistoryEntry {
  action: 'publish' | 'rollback';
  fromVersion: VersionRef | null;
  toVersion: VersionRef;
  actor: { id: string; name: string | null };
  occurredAt: string;
}

export interface AuditEntryView {
  id: string;
  occurredAt: string;
  actorType: string;
  actor: { id: string; name: string | null } | null;
  action: AuditAction | string;
  targetType: string | null;
  targetId: string | null;
  /** Keys only; metadata values never reach admin code (D-A10). */
  metadataKeys: string[];
}

export interface RatingCounts {
  rated: number;
  soundsLikeMe: number;
  share: number | null;
}

export interface RatingsMetrics {
  profiles: RatingCounts;
  drafts: RatingCounts & { byContentType: Record<DraftContentType, RatingCounts> };
}
