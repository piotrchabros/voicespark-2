import type { Authorship, ContentKind } from '@voicespark/db';
import { senderDomainHash, senderHash } from '@voicespark/core/services/imports';
import { parseFromAddress } from '@voicespark/filters';
import { META, type MemoryMetadata } from '@voicespark/integrations/supermemory';

export interface MetadataInput {
  kind: ContentKind;
  authorship: Authorship;
  contentItemId: string;
  parentItemId?: string;
  sourceId: string;
  itemDate: Date;
  lang?: string;
  wordCount: number;
  filterPolicyVersion: number;
  part?: number;
  folders: string[];
  /** Raw From header; only its HMAC hashes reach the metadata (contracts/supermemory.md). */
  fromAddress?: string;
}

/** `vs_*` document metadata. Raw addresses never appear; folders are lowercased for `arrayContains` filters. */
export function buildMetadata(i: MetadataInput): MemoryMetadata {
  const m: MemoryMetadata = {
    [META.kind]: i.kind,
    [META.authorship]: i.authorship,
    [META.contentItemId]: i.contentItemId,
    [META.sourceIds]: [i.sourceId],
    [META.itemTs]: Math.floor(i.itemDate.getTime() / 1000),
    [META.wordCount]: i.wordCount,
    [META.filterPolicyVersion]: i.filterPolicyVersion,
  };
  if (i.parentItemId !== undefined) m[META.parentItemId] = i.parentItemId;
  if (i.lang) m[META.lang] = i.lang;
  if (i.part !== undefined) m[META.part] = i.part;
  if (i.kind === 'email' || i.kind === 'attachment') {
    m[META.folders] = [...new Set(i.folders.map((f) => f.trim().toLowerCase()).filter((f) => f.length > 0))];
    const address = parseFromAddress(i.fromAddress).address;
    if (address) {
      m[META.senderHash] = senderHash(address);
      const domain = address.slice(address.lastIndexOf('@') + 1);
      if (domain) m[META.senderDomainHash] = senderDomainHash(domain);
    }
  }
  return m;
}
