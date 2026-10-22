import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { account, user } from './auth';
import { linkedViaEnum, signInProviderEnum } from './enums';

/**
 * sign_in_identity: one row per linked sign-in account (FR-003, FR-004).
 *
 * `account_id` is the Better Auth `account.id`; deleting the account removes the identity.
 */
export const signInIdentity = pgTable(
  'sign_in_identity',
  {
    accountId: uuid('account_id')
      .primaryKey()
      .references(() => account.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    provider: signInProviderEnum('provider').notNull(),
    providerEmail: text('provider_email'),
    emailVerified: boolean('email_verified').notNull(),
    isRelayEmail: boolean('is_relay_email').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    linkedVia: linkedViaEnum('linked_via').notNull(),
  },
  (t) => [
    index('sign_in_identity_user_id_idx').on(t.userId),
    uniqueIndex('sign_in_identity_provider_account_uq').on(t.provider, t.accountId),
  ],
);

export type SignInIdentity = typeof signInIdentity.$inferSelect;
