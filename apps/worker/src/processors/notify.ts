import { loadEnv } from '@voicespark/core/env';
import { getForDelivery, markEmailSent } from '@voicespark/core/services/notifications';
import { createMailer, isEmailedNotificationType, renderEmail, type Mailer } from '@voicespark/integrations/smtp';
import type { HandlerMap } from '../handlers';

let mailer: Mailer | undefined;
function getMailer(): Mailer {
  mailer ??= createMailer(loadEnv());
  return mailer;
}

export const handlers: HandlerMap = {
  'notify.send': async (job) => {
    const found = await getForDelivery(job.data.notificationId);
    // notify() may enqueue inside an uncommitted transaction: retry until the row is visible.
    if (!found) throw new Error('notification_not_found');
    const { notification, email } = found;
    if (notification.emailSentAt || !isEmailedNotificationType(notification.type)) return { emailed: false };

    const rendered = renderEmail(notification.type, notification.payload, loadEnv().APP_URL);
    if (!rendered) return { emailed: false };
    await getMailer().send({ to: email, ...rendered });
    await markEmailSent(notification.id);
    return { emailed: true };
  },
};
