import type { FilteredText } from '@voicespark/filters';

export type MetadataValue = string | number | boolean | string[];
export type MemoryMetadata = Record<string, MetadataValue>;

/** `content` is branded: only @voicespark/filters can produce it (constitution Principle I). */
export interface MemoryDoc {
  id: string;
  content: FilteredText;
  documentDate: string;
  metadata: MemoryMetadata;
}

export type FilterNode =
  | {
      field: string;
      operator:
        | 'eq'
        | 'neq'
        | 'gt'
        | 'gte'
        | 'lt'
        | 'lte'
        | 'contains'
        | 'notContains'
        | 'arrayContains'
        | 'arrayNotContains';
      value: MetadataValue;
    }
  | { and: FilterNode[] }
  | { or: FilterNode[] };

export const memoryFilter = {
  eq(field: string, value: MetadataValue): FilterNode {
    return { field, operator: 'eq', value };
  },
  arrayContains(field: string, value: string): FilterNode {
    return { field, operator: 'arrayContains', value };
  },
  and(...nodes: FilterNode[]): FilterNode {
    return { and: nodes };
  },
  or(...nodes: FilterNode[]): FilterNode {
    return { or: nodes };
  },
};

export interface MemoryStore {
  addDocuments(ns: string, docs: MemoryDoc[]): Promise<{ id: string; status: string }[]>;
  getDocument(ns: string, id: string): Promise<{ id: string; content: string; metadata: MemoryMetadata } | null>;
  listDocuments(
    ns: string,
    q: { filter?: FilterNode; page: number; limit: number },
  ): Promise<{ documents: { id: string; metadata: MemoryMetadata }[]; hasMore: boolean }>;
  search(ns: string, q: { query: string; limit: number; filter?: FilterNode }): Promise<{ id: string; content: string; score: number }[]>;
  deleteDocuments(ns: string, ids: string[]): Promise<{ count: number; errors: { id: string; error: string }[] }>;
  /** Replaces the metadata of an existing document (source deletion narrows `vs_source_ids`). */
  updateDocumentMetadata(ns: string, id: string, metadata: MemoryMetadata): Promise<void>;
  deleteNamespace(ns: string): Promise<void>;
  listMemories(ns: string): Promise<{ id: string }[]>;
}

export function namespaceFor(userId: string): string {
  return `vs_user_${userId}`;
}

export const META = {
  kind: 'vs_kind',
  authorship: 'vs_authorship',
  contentItemId: 'vs_content_item_id',
  parentItemId: 'vs_parent_item_id',
  sourceIds: 'vs_source_ids',
  itemTs: 'vs_item_ts',
  lang: 'vs_lang',
  wordCount: 'vs_word_count',
  filterPolicyVersion: 'vs_filter_policy_version',
  part: 'vs_part',
  folders: 'vs_folders',
  senderHash: 'vs_sender_hash',
  senderDomainHash: 'vs_sender_domain_hash',
} as const;
