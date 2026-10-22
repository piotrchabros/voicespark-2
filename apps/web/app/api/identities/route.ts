import * as identities from '@voicespark/core/services/identities';
import { requireUser } from '../../../lib/guards';
import { handle } from '../../../lib/http';

export const dynamic = 'force-dynamic';

export const GET = handle(async () => identities.listIdentities(await requireUser()));
