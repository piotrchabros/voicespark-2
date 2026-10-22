import { describe, expect, it } from 'vitest';
import type { InspectionInput } from '@voicespark/filters';
import { createLogger } from '../src/logger';

describe('SafeLogger types', () => {
  it('rejects InspectionInput at compile time', () => {
    const log = createLogger({ level: 'silent' });
    const input = {} as InspectionInput;
    // @ts-expect-error InspectionInput is not SafeLogFields (research R8)
    log.info(input);
    log.info({ jobId: 'j1', count: 3 }, 'ok');
    expect(true).toBe(true);
  });
});
