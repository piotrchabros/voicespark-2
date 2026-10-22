import nodemailer, { type Transporter } from 'nodemailer';

/** The only types that also go out by email (research R21; FR-013, FR-047). */
export const EMAILED_NOTIFICATION_TYPES = ['source_needs_reconnection', 'deletion_completed', 'import_completed'] as const;
export type EmailedNotificationType = (typeof EMAILED_NOTIFICATION_TYPES)[number];

export function isEmailedNotificationType(type: string): type is EmailedNotificationType {
  return (EMAILED_NOTIFICATION_TYPES as readonly string[]).includes(type);
}

export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

/** jsonTransport (nothing leaves the process) under NODE_ENV=test or when SMTP_URL is unset. */
export function createMailer(env: { SMTP_URL?: string; MAIL_FROM: string; NODE_ENV: string }): Mailer {
  // Transport is built lazily so importing this module never needs env.
  let transport: Transporter | undefined;
  const getTransport = (): Transporter =>
    (transport ??=
      env.NODE_ENV === 'test' || !env.SMTP_URL
        ? nodemailer.createTransport({ jsonTransport: true })
        : nodemailer.createTransport(env.SMTP_URL));

  return {
    async send(msg) {
      await getTransport().sendMail({ from: env.MAIL_FROM, to: msg.to, subject: msg.subject, text: msg.text });
    },
  };
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Plain-text templates. They only use counts from the payload and never echo payload strings, so no
 * content or excluded value can reach an email body. Returns null for types that are in-app only.
 */
export function renderEmail(
  type: string,
  payload: Record<string, unknown>,
  appUrl: string,
): { subject: string; text: string } | null {
  const base = appUrl.replace(/\/+$/, '');
  const footer = `\n\nThis is an automated message from VoiceSpark.`;
  switch (type) {
    case 'source_needs_reconnection':
      return {
        subject: 'VoiceSpark: a source needs reconnection',
        text:
          `One of your connected sources lost access, so its import is paused.\n\n` +
          `Reconnect it here: ${base}/sources${footer}`,
      };
    case 'import_completed': {
      const items = count(payload.itemsImported);
      return {
        subject: 'VoiceSpark: your import is complete',
        text:
          `Your first import has finished` +
          (items === null ? '.' : ` (${items} item${items === 1 ? '' : 's'} processed).`) +
          `\n\nView your sources: ${base}/sources${footer}`,
      };
    }
    case 'deletion_completed':
      // Single content-item deletions are in-app only (D-U7c); source deletions email. Only the scope enum is read.
      if (payload.scope === 'content_item') return null;
      if (payload.scope === 'source') {
        return {
          subject: 'VoiceSpark: your deletion is complete',
          text: `The source deletion you requested has been completed.\n\nView your sources: ${base}/sources${footer}`,
        };
      }
      return {
        subject: 'VoiceSpark: your deletion is complete',
        text: `The deletion you requested has been completed.\n\nView your account: ${base}/settings${footer}`,
      };
    default:
      return null;
  }
}

/**
 * Sent once account deletion has finished (no notification row: the user row is gone, D-U7c). Fixed text with no
 * payload values; links only to sign-in.
 */
export function renderAccountDeletedEmail(appUrl: string): { subject: string; text: string } {
  const base = appUrl.replace(/\/+$/, '');
  return {
    subject: 'VoiceSpark: your account has been deleted',
    text:
      `Your VoiceSpark account has been deleted as you requested. All of your content, tone profiles, drafts and ` +
      `memory-store data have been removed, and your connected sources were disconnected.\n\n` +
      `You can create a new account at any time: ${base}/sign-in` +
      `\n\nThis is an automated message from VoiceSpark.`,
  };
}
