import type { FilterNode } from './port';

export type V3Condition = {
  key: string;
  value: string;
  filterType?: 'metadata' | 'numeric' | 'array_contains' | 'string_contains';
  negate?: boolean;
  numericOperator?: '>' | '<' | '>=' | '<=' | '=';
};
export type V3FilterExpr = V3Condition | { AND: V3FilterExpr[] } | { OR: V3FilterExpr[] };
export type V3FilterRoot = { AND: V3FilterExpr[] } | { OR: V3FilterExpr[] };

// The server validates up to 5 levels of AND/OR nesting; fail locally rather than on a 400.
const MAX_DEPTH = 5;

const NUMERIC_OPERATORS = { gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;

function toExpr(node: FilterNode, depth: number): V3FilterExpr {
  if ('and' in node || 'or' in node) {
    if (depth > MAX_DEPTH)
      throw new Error(`Supermemory filters nest at most ${MAX_DEPTH} levels deep`);
    if ('and' in node) return { AND: node.and.map((n) => toExpr(n, depth + 1)) };
    return { OR: node.or.map((n) => toExpr(n, depth + 1)) };
  }
  const { field: key, operator, value } = node;
  if (Array.isArray(value))
    throw new Error(`Supermemory filters do not support array values (field ${key})`);
  switch (operator) {
    case 'eq':
    case 'neq': {
      const negate = operator === 'neq' ? { negate: true as const } : {};
      if (typeof value === 'number')
        return {
          key,
          value: String(value),
          filterType: 'numeric',
          numericOperator: '=',
          ...negate,
        };
      return { key, value: String(value), ...negate };
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      if (typeof value !== 'number')
        throw new Error(`Supermemory numeric filter needs a number value (field ${key})`);
      return {
        key,
        value: String(value),
        filterType: 'numeric',
        numericOperator: NUMERIC_OPERATORS[operator],
      };
    case 'contains':
    case 'notContains':
      return {
        key,
        value: String(value),
        filterType: 'string_contains',
        ...(operator === 'notContains' ? { negate: true } : {}),
      };
    case 'arrayContains':
    case 'arrayNotContains':
      return {
        key,
        value: String(value),
        filterType: 'array_contains',
        ...(operator === 'arrayNotContains' ? { negate: true } : {}),
      };
  }
}

/** Port filter -> v3 `{AND|OR: [...]}` tree; a bare leaf is wrapped as `{AND: [leaf]}`. */
export function toV3Filter(node: FilterNode): V3FilterRoot {
  if ('and' in node || 'or' in node) return toExpr(node, 1) as V3FilterRoot;
  return { AND: [toExpr(node, 1)] };
}
