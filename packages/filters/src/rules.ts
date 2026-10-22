import { parseFromAddress } from './address';
import type { ExclusionRule, InspectionInput } from './categories';

type RuleInput = Pick<InspectionInput, 'subject' | 'bodyText' | 'headers' | 'folders'>;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function keywordMatches(keyword: string, text: string): boolean {
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(keyword)}(?![\\p{L}\\p{N}_])`, 'iu');
  return re.test(text);
}

function ruleMatches(rule: ExclusionRule, input: RuleInput): boolean {
  const value = rule.value.trim().toLowerCase();
  if (!value) return false;
  switch (rule.type) {
    case 'sender':
      return parseFromAddress(input.headers.from).address === value;
    case 'domain': {
      const address = parseFromAddress(input.headers.from).address;
      return address !== undefined && address.slice(address.lastIndexOf('@') + 1) === value;
    }
    case 'folder_label':
      return input.folders.some((folder) => folder.toLowerCase() === value);
    case 'keyword':
      return keywordMatches(rule.value.trim(), `${input.subject ?? ''}\n${input.bodyText}`);
  }
}

export function matchRules(
  input: RuleInput,
  rules: readonly ExclusionRule[],
): { matched: ExclusionRule | null } {
  for (const rule of rules) {
    if (ruleMatches(rule, input)) return { matched: rule };
  }
  return { matched: null };
}
