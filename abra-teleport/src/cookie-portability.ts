export type CookiePortability = {
  status: 'excluded' | 'possible' | 'no-known-restriction';
  reasons: string[];
};

type CookieMetadata = { name?: string; secure?: boolean; httpOnly?: boolean };

// Use the adapter's actual exclusion rules; these labels do not prove server acceptance.
export function cookiePortability(cookie: CookieMetadata, blockedReasons: string[], protectedSite = false): CookiePortability {
  const reasons = blockedReasons.map(reason => reason === 'known device-bound session domain'
    ? 'This domain may use device-bound sessions.'
    : reason === 'device-bound cookie name and security attributes'
      ? 'The name and security flags suggest this cookie may be device-bound.'
      : reason);
  if (protectedSite) reasons.unshift('Copying this site’s sign-in data may disrupt your session.');
  if (reasons.length) return { status: 'excluded', reasons };
  if (/(^|[-_.])(?:dbsc|device|bound)([-_.]|$)/i.test(cookie.name || '')) {
    return { status: 'possible', reasons: ['The cookie name suggests device binding, but this is not confirmed. Abra will include it if selected.'] };
  }
  return { status: 'no-known-restriction', reasons: ['No device-binding hint was found. The site may still reject it in the sandbox.'] };
}
