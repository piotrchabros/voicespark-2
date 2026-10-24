// Lint fixture for the admin isolation suite (FR-029, SC-011): an admin file that imports hub
// services. `admin-isolation.test.ts` lints this source as if it lived at each admin path and
// expects `no-restricted-imports` on every import below. Never imported by application code.
import '@voicespark/core/services/hub/records';
import '@voicespark/core/services/hub/notes';
import '@voicespark/core/services/hub/files';
import '@voicespark/core/services/hub/links';
import '@voicespark/core/hub/blob-store';
import '@voicespark/db/repos/user/hub-records';
