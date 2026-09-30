import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { calculateFloatingPosition, resolveFloatingPortalHost } from '../../src/components/ui/FloatingPortal.tsx';

const anchor = {
  top: 100,
  right: 200,
  bottom: 140,
  left: 100,
  width: 100,
  height: 40
};

test('FloatingPortal positions below its anchor when space is available', () => {
  assert.deepEqual(calculateFloatingPosition(anchor, { width: 292, height: 300 }, {
    viewportWidth: 800,
    viewportHeight: 700,
    align: 'start'
  }), {
    top: 148,
    left: 100,
    placement: 'bottom'
  });
});

test('FloatingPortal flips above and clamps horizontally inside the viewport', () => {
  assert.deepEqual(calculateFloatingPosition({ ...anchor, top: 600, bottom: 640 }, { width: 292, height: 300 }, {
    viewportWidth: 800,
    viewportHeight: 700,
    align: 'start'
  }), {
    top: 292,
    left: 100,
    placement: 'top'
  });

  assert.deepEqual(calculateFloatingPosition({ ...anchor, left: 690, right: 790 }, { width: 380, height: 200 }, {
    viewportWidth: 800,
    viewportHeight: 700,
    align: 'end'
  }), {
    top: 148,
    left: 408,
    placement: 'bottom'
  });

  // Automatically flips to end alignment when align: start would overflow the right viewport edge
  assert.deepEqual(calculateFloatingPosition({ ...anchor, left: 500, right: 620 }, { width: 380, height: 200 }, {
    viewportWidth: 800,
    viewportHeight: 700,
    align: 'start'
  }), {
    top: 148,
    left: 240, // 620 - 380 = 240
    placement: 'bottom'
  });
});

test('nested pickers stay inside their containing popover or modal', () => {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  const body={} as HTMLElement,container={} as HTMLElement;
  Object.defineProperty(globalThis,'document',{configurable:true,value:{body}});
  try {
    const nested={closest(selector:string){assert.equal(selector,'dialog[open], [popover]');return container;}} as HTMLElement;
    const outside={closest(){return null;}} as unknown as HTMLElement;
    assert.equal(resolveFloatingPortalHost(nested),container);
    assert.equal(resolveFloatingPortalHost(outside),body);
    assert.equal(resolveFloatingPortalHost(null),body);
  } finally {
    if(previous)Object.defineProperty(globalThis,'document',previous);
    else Reflect.deleteProperty(globalThis,'document');
  }
});

test('pickers and query menus use one native top-layer portal without timer or in-container popover positioning', async () => {
  const [portal, datePicker, timePicker, tagPicker, filterBar] = await Promise.all([
    readFile(new URL('../../src/components/ui/FloatingPortal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/components/ui/DatePicker.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/components/ui/TimePicker.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/components/ui/TagDropdownPicker.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/components/ui/FilterBar.tsx', import.meta.url), 'utf8')
  ]);

  assert.match(portal, /createPortal/);
  assert.match(portal, /showPopover\(\)/);
  assert.match(portal, /closest<HTMLElement>\('dialog\[open\], \[popover\]'\)/);
  assert.match(portal, /ResizeObserver/);
  assert.match(portal, /addEventListener\('scroll', updatePosition, true\)/);

  for (const source of [datePicker, timePicker, tagPicker, filterBar]) {
    assert.match(source, /<FloatingPortal/);
    assert.doesNotMatch(source, /className=["`][^"`]*\babsolute\b[^"`]*z-\[99999\]/);
  }
  assert.doesNotMatch(timePicker, /setTimeout\(/);
  assert.match(filterBar, /disabled\?: boolean/);
  assert.match(filterBar, /disabled=\{action\.disabled\}/);
  assert.match(filterBar, /if \(action\.disabled\) return;/);
});
