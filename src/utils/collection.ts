/**
 * Platform - Shared Engineering Collection & Tree Utilities (PLATFORM-L2-004)
 * 纯净集合与树形算法工具，100% 纯计算，无任何业务依赖。
 */

export interface TreeifyOptions<T> {
  idKey?: keyof T;
  parentIdKey?: keyof T;
  childrenKey?: string;
  rootValue?: any;
}

/**
 * 将扁平数组根据父子 ID 关系重组为深层树形结构
 */
export function treeify<T extends Record<string, any>>(
  items: readonly T[],
  options: TreeifyOptions<T> = {}
): (T & { [key: string]: any })[] {
  const {
    idKey = 'id' as keyof T,
    parentIdKey = 'parentId' as keyof T,
    childrenKey = 'children',
    rootValue = null
  } = options;

  const itemMap = new Map<any, T & { [key: string]: any }>();
  const roots: (T & { [key: string]: any })[] = [];

  // First pass: clone items and index by ID
  for (const item of items) {
    const id = item[idKey];
    itemMap.set(id, { ...item, [childrenKey]: [] });
  }

  // Second pass: build parent-child relations
  for (const item of items) {
    const id = item[idKey];
    const parentId = item[parentIdKey];
    const node = itemMap.get(id)!;

    if (
      parentId === rootValue ||
      parentId === undefined ||
      parentId === null ||
      !itemMap.has(parentId)
    ) {
      roots.push(node);
    } else {
      const parentNode = itemMap.get(parentId);
      if (parentNode) {
        parentNode[childrenKey].push(node);
      } else {
        roots.push(node);
      }
    }
  }

  return roots;
}

/**
 * 将深层树形结构递归扁平化为一维数组
 */
export function flattenTree<T extends Record<string, any>>(
  tree: readonly T[],
  childrenKey: string = 'children'
): T[] {
  const result: T[] = [];

  function traverse(nodes: readonly T[]) {
    for (const node of nodes) {
      const { [childrenKey]: children, ...rest } = node;
      result.push(rest as T);
      if (Array.isArray(children) && children.length > 0) {
        traverse(children);
      }
    }
  }

  traverse(tree);
  return result;
}

/**
 * 根据指定键选择器对数组元素进行分组
 */
export function groupBy<T, K extends string | number | symbol>(
  items: readonly T[],
  keyFn: (item: T) => K
): Record<K, T[]> {
  const result = {} as Record<K, T[]>;
  for (const item of items) {
    const key = keyFn(item);
    if (!result[key]) {
      result[key] = [];
    }
    result[key].push(item);
  }
  return result;
}

/**
 * 将数组按指定大小分块为二维数组
 */
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) return [items.slice()];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * 根据指定键对数组进行唯一去重（保留首个遇到的元素）
 */
export function uniqueBy<T, K>(items: readonly T[], keyFn: (item: T) => K): T[] {
  const seen = new Set<K>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

/**
 * 从对象中选取指定的属性键
 */
export function pick<T extends Record<string, any>, K extends keyof T>(
  obj: T,
  keys: readonly K[]
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}

/**
 * 从对象中排除指定的属性键
 */
export function omit<T extends Record<string, any>, K extends keyof T>(
  obj: T,
  keys: readonly K[]
): Omit<T, K> {
  const keySet = new Set<any>(keys);
  const result = {} as any;
  for (const key of Object.keys(obj)) {
    if (!keySet.has(key)) {
      result[key] = obj[key];
    }
  }
  return result as Omit<T, K>;
}

/**
 * 根据对象属性排序
 */
export function sortByKey<T extends Record<string, any>>(
  items: readonly T[],
  key: keyof T,
  order: 'asc' | 'desc' = 'asc'
): T[] {
  const sorted = items.slice();
  sorted.sort((a, b) => {
    const valA = a[key];
    const valB = b[key];
    if (valA === valB) return 0;
    if (valA === undefined || valA === null) return 1;
    if (valB === undefined || valB === null) return -1;
    if (valA < valB) return order === 'asc' ? -1 : 1;
    return order === 'asc' ? 1 : -1;
  });
  return sorted;
}
