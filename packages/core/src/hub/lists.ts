// Role mailboxes that do not identify a person (46 local parts).
export const ROLE_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'info', 'office', 'biuro', 'kontakt', 'contact', 'sales', 'sprzedaz', 'support', 'pomoc', 'help',
  'admin', 'administrator', 'hello', 'hi', 'team', 'hr', 'rekrutacja', 'jobs', 'careers', 'kariera',
  'billing', 'invoices', 'faktury', 'accounting', 'ksiegowosc', 'finance', 'marketing', 'press', 'media', 'legal',
  'privacy', 'security', 'abuse', 'webmaster', 'orders', 'zamowienia', 'service', 'serwis', 'reception', 'recepcja',
  'sekretariat', 'enquiries', 'general', 'booking', 'rezerwacje', 'oferty',
]);

// Consumer mail providers and tenant domains: never treated as a company domain.
// `p.*` matches the label `p` on any TLD; `*.suffix` matches any subdomain of `suffix`.
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'msn.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'web.de', 'mail.com', 'zoho.com', 'fastmail.com',
  'hey.com', 'tutanota.com', 'mail.ru', 'wp.pl', 'o2.pl', 'onet.pl', 'onet.eu', 'op.pl',
  'interia.pl', 'interia.eu', 'poczta.fm', 'tlen.pl', 'vp.pl', 'gazeta.pl', 'go2.pl', 'autograf.pl',
  'buziaczek.pl',
  'hotmail.*', 'live.*', 'yahoo.*', 'gmx.*', 'yandex.*',
  '*.onmicrosoft.com',
]);
