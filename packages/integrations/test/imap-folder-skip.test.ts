import { describe, expect, it } from 'vitest';
import { isSkippedImapFolder } from '../src/imap';

const folder = (path: string, extra: { specialUse?: string; flags?: string[] } = {}) => {
  const parts = path.split('/');
  return {
    name: parts.at(-1)!,
    parent: parts.slice(0, -1),
    specialUse: extra.specialUse,
    flags: new Set(extra.flags ?? []),
  };
};

describe('isSkippedImapFolder', () => {
  it.each([
    'Spam',
    'Junk',
    'Junk E-mail',
    'junk email',
    'Bulk Mail',
    'TRASH',
    'Deleted',
    'Deleted Items',
    'Deleted Messages',
    'Bin',
    'Kosz',
    'Wiadomości-śmieci',
    'Śmieci',
    'Drafts',
    'Szkice',
    'Wersje robocze',
    'Trash/Old',
    'INBOX/Spam',
    'Deleted Items/2023/Q1',
  ])('skips %s by name', (path) => {
    expect(isSkippedImapFolder(folder(path))).toBe(true);
  });

  it.each(['\\Junk', '\\Trash', '\\Drafts', '\\All'])('skips special-use %s', (flag) => {
    expect(isSkippedImapFolder(folder('Whatever', { specialUse: flag }))).toBe(true);
    expect(isSkippedImapFolder(folder('Whatever', { flags: [flag] }))).toBe(true);
  });

  it.each(['INBOX', 'Sent', 'Projects', 'Archive', 'Spamalot', 'Binder', 'Projects/Drafting'])(
    'keeps %s',
    (path) => {
      expect(isSkippedImapFolder(folder(path))).toBe(false);
      expect(isSkippedImapFolder(folder(path, { specialUse: '\\Sent' }))).toBe(false);
    },
  );
});
