import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  treeify,
  flattenTree,
  groupBy,
  chunkArray,
  uniqueBy,
  pick,
  omit,
  sortByKey
} from '../../src/utils/collection';
import {
  formatRelativeTime,
  formatFileSize,
  formatDuration,
  safeJsonParse,
  safeJsonStringify,
  formatNumber,
  clamp
} from '../../src/utils/format';
import {
  isPhone,
  isIdCard,
  isEmail,
  isUrl,
  maskPhone,
  maskIdCard,
  maskName
} from '../../src/utils/validate';
import { jsonToExcelBlob } from '../../src/utils/excel';

test('L2 public contracts stay business-neutral, printable, typed, and keyboard-visible', async () => {
  const [
    hooksIndex,
    tagFilterSource,
    documentViewerSource,
    spreadsheetViewerSource,
    printSource,
    sharedStyles
  ] = await Promise.all([
    readFile(new URL('../../src/hooks/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../src/components/ui/TagFilterDialog.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/components/ui/DocumentSnapshotViewer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/components/ui/SpreadsheetViewer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/utils/print.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../index.css', import.meta.url), 'utf8')
  ]);

  assert.doesNotMatch(hooksIndex, /usePermissions/);
  assert.match(tagFilterSource, /useMemo, useState/);
  assert.match(documentViewerSource, /triggerPrint\(printableRef\.current, \{ title \}\)/);
  assert.doesNotMatch(documentViewerSource, /const printableHtml/);
  assert.match(spreadsheetViewerSource, /uploadInputRef\.current\?\.click\(\)/);
  assert.doesNotMatch(spreadsheetViewerSource, /\bas=/);
  assert.match(printSource, /importNode\(element, true\)/);
  assert.doesNotMatch(printSource, /element\.outerHTML|<title>\$\{/);
  assert.match(sharedStyles, /:focus-visible\s*\{[\s\S]*outline:\s*2px solid var\(--afc-color-primary\)/);
});

test('collection utilities: treeify and flattenTree correctly handle multi-level hierarchy', () => {
  const flatData = [
    { id: 1, name: '运营中心', parentId: null },
    { id: 2, name: '站务部', parentId: 1 },
    { id: 3, name: '一工区', parentId: 2 },
    { id: 4, name: '白班组', parentId: 3 },
    { id: 5, name: '夜班组', parentId: 3 },
    { id: 6, name: '票务车间', parentId: 1 }
  ];

  const tree = treeify(flatData, { idKey: 'id', parentIdKey: 'parentId' });
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, '运营中心');
  assert.equal(tree[0].children.length, 2);

  const dept1 = tree[0].children.find((c: any) => c.id === 2);
  assert.ok(dept1);
  assert.equal(dept1.children.length, 1);
  assert.equal(dept1.children[0].children.length, 2);

  const flattened = flattenTree(tree);
  assert.equal(flattened.length, 6);
  assert.deepEqual(
    flattened.map((f: any) => f.id).sort(),
    [1, 2, 3, 4, 5, 6]
  );
});

test('collection utilities: groupBy, chunkArray, uniqueBy, pick, omit, sortByKey work as expected', () => {
  const list = [
    { id: 1, type: 'A', score: 90 },
    { id: 2, type: 'B', score: 85 },
    { id: 3, type: 'A', score: 95 },
    { id: 4, type: 'B', score: 80 }
  ];

  // groupBy
  const grouped = groupBy(list, (x) => x.type);
  assert.equal(grouped.A.length, 2);
  assert.equal(grouped.B.length, 2);

  // chunkArray
  const chunks = chunkArray(list, 2);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 2);
  assert.equal(chunks[1].length, 2);

  // uniqueBy
  const uniques = uniqueBy(list, (x) => x.type);
  assert.equal(uniques.length, 2);
  assert.equal(uniques[0].id, 1);
  assert.equal(uniques[1].id, 2);

  // pick and omit
  const picked = pick(list[0], ['id', 'score']);
  assert.deepEqual(picked, { id: 1, score: 90 });

  const omitted = omit(list[0], ['type']);
  assert.deepEqual(omitted, { id: 1, score: 90 });

  // sortByKey
  const sortedDesc = sortByKey(list, 'score', 'desc');
  assert.equal(sortedDesc[0].score, 95);
  assert.equal(sortedDesc[3].score, 80);
});

test('formatting utilities: formatRelativeTime, formatFileSize, formatDuration, safeJsonParse', () => {
  const now = new Date('2026-08-30T10:00:00Z');

  // Relative time
  const justNow = new Date('2026-08-30T09:59:40Z');
  assert.equal(formatRelativeTime(justNow, now), '刚刚');

  const fiveMinAgo = new Date('2026-08-30T09:55:00Z');
  assert.equal(formatRelativeTime(fiveMinAgo, now), '5分钟前');

  const twoHoursAgo = new Date('2026-08-30T08:00:00Z');
  assert.equal(formatRelativeTime(twoHoursAgo, now), '2小时前');

  const yesterday = new Date('2026-08-29T10:00:00Z');
  assert.equal(formatRelativeTime(yesterday, now), '昨天');

  // File size
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(1024), '1 KB');
  assert.equal(formatFileSize(1024 * 1024 * 3.5, 1), '3.5 MB');
  assert.equal(formatFileSize(1024 * 1024 * 1024 * 2.25, 2), '2.25 GB');

  // Duration
  assert.equal(formatDuration(75, 'colon'), '01:15');
  assert.equal(formatDuration(3665, 'colon'), '01:01:05');
  assert.equal(formatDuration(3665, 'chinese'), '1小时1分5秒');

  // Safe JSON
  assert.deepEqual(safeJsonParse('{"ok": true}', {}), { ok: true });
  assert.deepEqual(safeJsonParse('invalid-json', { fallback: 1 }), { fallback: 1 });
  assert.deepEqual(safeJsonParse(null, []), []);

  // Numbers and Clamp
  assert.equal(formatNumber(1234567.89, 2), '1,234,567.89');
  assert.equal(clamp(150, 0, 100), 100);
  assert.equal(clamp(-10, 0, 100), 0);
});

test('validation & masking utilities: phone, idCard, email, maskPhone, maskIdCard, maskName', () => {
  // Phone
  assert.equal(isPhone('13812345678'), true);
  assert.equal(isPhone('12345678901'), false);
  assert.equal(isPhone('1381234567'), false);
  assert.equal(maskPhone('13812345678'), '138****5678');

  // ID Card (with valid checksum)
  assert.equal(isIdCard('110101199003072375'), true);
  assert.equal(isIdCard('11010119900307237X'), false);
  assert.equal(maskIdCard('110101199003072375'), '1101**********2375');

  // Email & URL
  assert.equal(isEmail('user@metro.gov.cn'), true);
  assert.equal(isEmail('invalid.email'), false);
  assert.equal(isUrl('https://ops.metro.internal/dashboard'), true);
  assert.equal(isUrl('not-a-url'), false);

  // Mask Name
  assert.equal(maskName('张三'), '张*');
  assert.equal(maskName('张三丰'), '张*丰');
  assert.equal(maskName('诸葛孔明'), '诸**明');
});

test('excel utility: jsonToExcelBlob builds valid XLSX binary blob', () => {
  const testData = [
    { station: '青岛站', code: 'QD01', lines: '1号线,3号线', status: '正常' },
    { station: '李村站', code: 'LC02', lines: '2号线,3号线', status: '正常' }
  ];

  const blob = jsonToExcelBlob({
    data: testData,
    sheetName: '车站导出测试',
    columns: [
      { key: 'station', header: '车站名称', width: 16 },
      { key: 'code', header: '车站编码', width: 12 },
      { key: 'lines', header: '所属线路', width: 20 },
      { key: 'status', header: '运行状态', width: 10 }
    ]
  });

  assert.ok(blob);
  assert.ok(blob.size > 100);
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});
