import { describe, expect, it } from 'vitest';
// Static import on purpose: renderAccountDeletedEmail is RED until U2 lands.
import { renderAccountDeletedEmail, renderEmail } from '../src/smtp/mailer';

const APP = 'https://app.voicespark.test/';

describe('renderAccountDeletedEmail', () => {
  const mail = renderAccountDeletedEmail(APP);

  it('states what was removed and links only to sign-in', () => {
    expect(mail.subject).toBe('VoiceSpark: your account has been deleted');
    for (const word of ['content', 'profiles', 'drafts', 'memory']) expect(mail.text).toContain(word);
    const urls = mail.text.match(/https?:\/\/\S+/g) ?? [];
    expect(urls).toEqual(['https://app.voicespark.test/sign-in']);
  });

  it('takes no payload, so no payload value can be echoed', () => {
    expect(renderAccountDeletedEmail.length).toBe(1);
  });
});

describe('renderEmail deletion_completed', () => {
  it('is in-app only for content_item scope', () => {
    expect(renderEmail('deletion_completed', { scope: 'content_item' }, APP)).toBeNull();
  });

  it('renders the source variant linking to /sources', () => {
    const mail = renderEmail('deletion_completed', { scope: 'source' }, APP);
    expect(mail).not.toBeNull();
    expect(mail!.text).toContain('The source deletion you requested has been completed.');
    expect(mail!.text).toContain('https://app.voicespark.test/sources');
  });

  it('never echoes payload strings', () => {
    const mail = renderEmail('deletion_completed', { scope: 'source', deletionRequestId: 'SECRET-ID-123' }, APP);
    expect(mail!.text).not.toContain('SECRET-ID-123');
  });
});

describe('renderEmail import_completed', () => {
  it('reads itemsImported', () => {
    const mail = renderEmail('import_completed', { itemsImported: 12 }, APP);
    expect(mail!.text).toContain('12 items');
    expect(renderEmail('import_completed', { itemsImported: 1 }, APP)!.text).toContain('1 item processed');
  });

  it('ignores the legacy itemCount key', () => {
    const mail = renderEmail('import_completed', { itemCount: 99 }, APP);
    expect(mail!.text).not.toContain('99');
  });
});
