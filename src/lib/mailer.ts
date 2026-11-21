import { env, payments } from '../env';

type Mail = { to: string; subject: string; html: string; text?: string };

/**
 * Sends transactional email through Resend. When no key is configured the
 * message is logged instead of silently dropped, so local runs still show the
 * verification link.
 */
export async function sendMail(mail: Mail): Promise<boolean> {
  if (!payments.emailEnabled) {
    console.info(`[mail:disabled] to=${mail.to} subject="${mail.subject}"`);
    return false;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [mail.to],
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      }),
    });

    if (!res.ok) {
      console.error('Resend error', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (error) {
    console.error('Resend request failed', error);
    return false;
  }
}

export function verificationEmail(name: string, link: string) {
  return {
    subject: 'Verify your Autopilot Forex account',
    html: `<p>Hi ${escapeHtml(name)},</p>
<p>Confirm your email to finish setting up your Autopilot Forex account.</p>
<p><a href="${link}">Verify my email</a></p>
<p>This link expires in 60 minutes. If you did not create this account, ignore this email.</p>`,
    text: `Hi ${name}, verify your Autopilot Forex account: ${link}`,
  };
}

export function resetEmail(name: string, link: string) {
  return {
    subject: 'Reset your Autopilot Forex password',
    html: `<p>Hi ${escapeHtml(name)},</p>
<p>Use the link below to choose a new password. It expires in 30 minutes.</p>
<p><a href="${link}">Reset password</a></p>
<p>If you did not request this, no action is needed.</p>`,
    text: `Hi ${name}, reset your password: ${link}`,
  };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
