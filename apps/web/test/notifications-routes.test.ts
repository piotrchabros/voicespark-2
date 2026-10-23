import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  markRead: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@voicespark/core/services/notifications', () => ({
  list: mocks.list,
  markRead: mocks.markRead,
}));
vi.mock('@voicespark/core/queues', () => ({ getRedisConnection: () => ({}) }));
vi.mock('../lib/guards', () => ({
  requireUser: async () => ({ userId: 'u1', role: 'user' }),
  auditForeignAccess: mocks.audit,
}));

import { GET } from '../app/api/notifications/route';
import { POST } from '../app/api/notifications/[id]/read/route';

const ID = '8b0c6a3e-1d2f-4c55-9a77-0f2f6f1c9e11';
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('notifications routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists with ISO timestamps and the pagination envelope', async () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    mocks.list.mockResolvedValue({
      items: [
        {
          id: ID,
          type: 'import_completed',
          payload: { itemsImported: 3 },
          readAt: null,
          createdAt,
        },
      ],
      nextCursor: 'c',
    });
    const res = await GET(new Request('http://x/api/notifications?limit=5'), undefined);
    expect(mocks.list).toHaveBeenCalledWith('u1', { limit: 5 });
    expect(await res.json()).toEqual({
      items: [
        {
          id: ID,
          type: 'import_completed',
          payload: { itemsImported: 3 },
          readAt: null,
          createdAt: createdAt.toISOString(),
        },
      ],
      nextCursor: 'c',
    });
  });

  it('returns analysis_prompt_default_changed with an ids-only payload', async () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const payload = {
      definitionId: 'd1',
      ownPromptId: 'p1',
      fromDefinitionVersionId: 'v1',
      toDefinitionVersionId: 'v2',
    };
    mocks.list.mockResolvedValue({
      items: [
        { id: ID, type: 'analysis_prompt_default_changed', payload, readAt: null, createdAt },
      ],
      nextCursor: null,
    });
    const res = await GET(new Request('http://x/api/notifications'), undefined);
    const body = await res.json();
    expect(body.items[0].type).toBe('analysis_prompt_default_changed');
    expect(body.items[0].payload).toEqual(payload);
    expect(Object.keys(body.items[0].payload).sort()).toEqual(Object.keys(payload).sort());
  });

  it('marks read with 204', async () => {
    mocks.markRead.mockResolvedValue(true);
    const res = await POST(new Request('http://x'), params(ID));
    expect(res.status).toBe(204);
  });

  it('returns 404 and audits when markRead is false', async () => {
    mocks.markRead.mockResolvedValue(false);
    const res = await POST(new Request('http://x'), params(ID));
    expect(res.status).toBe(404);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), 'notification', ID);
  });

  it('returns 404 for a non-uuid id without hitting the service', async () => {
    const res = await POST(new Request('http://x'), params('nope'));
    expect(res.status).toBe(404);
    expect(mocks.markRead).not.toHaveBeenCalled();
  });
});
