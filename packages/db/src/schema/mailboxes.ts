import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { imapTlsModeEnum, mailboxCredentialKindEnum, mailOauthProviderEnum } from './enums';
import { connectedSource } from './sources';

/**
 * mailbox_credential: encrypted mailbox access for one source (FR-008).
 *
 * Content-class secret material: never returned by any API. `key_id` is the keyring id used to encrypt.
 */
export const mailboxCredential = pgTable('mailbox_credential', {
  sourceId: uuid('source_id')
    .primaryKey()
    .references(() => connectedSource.id, { onDelete: 'cascade' }),
  kind: mailboxCredentialKindEnum('kind').notNull(),
  accessTokenEnc: text('access_token_enc'),
  refreshTokenEnc: text('refresh_token_enc'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  // Minimal read scopes only.
  grantedScopes: text('granted_scopes').array().notNull().default([]),
  imapHost: text('imap_host'),
  imapPort: integer('imap_port'),
  imapTlsMode: imapTlsModeEnum('imap_tls_mode'),
  imapUsername: text('imap_username'),
  imapPasswordEnc: text('imap_password_enc'),
  keyId: text('key_id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** oauth_connect_state: short-lived PKCE state for a mailbox OAuth flow; `id` equals the OAuth state. */
export const oauthConnectState = pgTable(
  'oauth_connect_state',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    provider: mailOauthProviderEnum('provider').notNull(),
    codeVerifierEnc: text('code_verifier_enc').notNull(),
    dateRangeFrom: date('date_range_from', { mode: 'string' }),
    dateRangeTo: date('date_range_to', { mode: 'string' }),
    reconnectSourceId: uuid('reconnect_source_id').references(() => connectedSource.id, {
      onDelete: 'cascade',
    }),
    // created + 10 min
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('oauth_connect_state_expires_at_idx').on(t.expiresAt)],
);

/** sync_cursor: per-folder import checkpoint and incremental cursor. */
export const syncCursor = pgTable(
  'sync_cursor',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => connectedSource.id, { onDelete: 'cascade' }),
    // Gmail `_all`; Graph folder id; IMAP folder path.
    folderKey: text('folder_key').notNull(),
    // {pageToken} / {nextLink} / {uidNext}
    initialCheckpoint: jsonb('initial_checkpoint').$type<Record<string, unknown>>(),
    // {historyId} / {deltaLink} / {uidValidity, lastUid}
    cursor: jsonb('cursor').$type<Record<string, unknown>>(),
    initialComplete: boolean('initial_complete').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sync_cursor_source_folder_uq').on(t.sourceId, t.folderKey)],
);

export type MailboxCredential = typeof mailboxCredential.$inferSelect;
export type OauthConnectState = typeof oauthConnectState.$inferSelect;
export type SyncCursor = typeof syncCursor.$inferSelect;
