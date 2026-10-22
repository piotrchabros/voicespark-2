/** Parses an RFC 5322-ish From header into display name and lowercased address. */
export function parseFromAddress(from?: string): { name?: string; address?: string } {
  if (!from) return {};
  const trimmed = from.trim();
  if (!trimmed) return {};
  const angle = /^(.*?)<([^<>]*)>\s*$/.exec(trimmed);
  const rawAddress = (angle ? angle[2]! : trimmed).trim();
  const address = rawAddress.includes('@') ? rawAddress.toLowerCase() : undefined;
  const name = angle ? angle[1]!.trim().replace(/^"(.*)"$/, '$1').trim() : '';
  const result: { name?: string; address?: string } = {};
  if (name) result.name = name;
  if (address) result.address = address;
  return result;
}
