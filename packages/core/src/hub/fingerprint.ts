import { hmacHex } from '../crypto';

/** Per-user fingerprint of a finding: type, normalised target identity and normalised value. */
export function factFingerprint(userId: string, type: string, targetIdentity: string, value: string): string {
  return hmacHex(`hubfact:${userId}:${type}:${targetIdentity}:${value.trim().toLowerCase()}`);
}

// Block-marker keys. Only the HMAC is stored in `hub_block_marker.key_hash`.
const mk = (key: string): string => hmacHex(key);

export const markerKey = {
  personEmail: (address: string) => mk(`person:email:${address.trim().toLowerCase()}`),
  companyDomain: (domain: string) => mk(`company:domain:${domain.trim().toLowerCase()}`),
  companyName: (name: string) => mk(`company:name:${name.trim().toLowerCase()}`),
  projectName: (name: string) => mk(`project:name:${name.trim().toLowerCase()}`),
  link: (kind: string, idA: string, idB: string) => mk(`link:${kind}:${idA}:${idB}`),
  field: (kind: string, id: string, field: string, value: string) =>
    mk(`field:${kind}:${id}:${field}:${hmacHex(value.trim().toLowerCase())}`),
  fact: (fingerprint: string) => mk(`fact:${fingerprint}`),
};
