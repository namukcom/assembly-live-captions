import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const html = await readFile(new URL('../captions.html', import.meta.url), 'utf8');
const source = html.match(/<script id="theme-init">([\s\S]*?)<\/script>/)[1];
const key = 'assembly-caption-theme';

function openPage(storage = new Map(), blocked = false) {
  const readyHandlers = new Map(), toggleHandlers = new Map();
  const root = { dataset: {} };
  const toggle = { checked: true, addEventListener(name, handler) { toggleHandlers.set(name, handler); } };
  const scheme = { content: 'dark' }, browserColor = { content: '#0c111b' };
  const context = { document: {
    documentElement: root,
    querySelector(selector) {
      if (selector === 'meta[name="color-scheme"]') return scheme;
      if (selector === 'meta[name="theme-color"]') return browserColor;
      throw Error(`Unexpected theme selector: ${selector}`);
    },
    getElementById(id) { assert.equal(id, 'dark-mode'); return toggle; },
    addEventListener(name, handler) { readyHandlers.set(name, handler); },
  } };
  Object.defineProperty(context, 'localStorage', { get() {
    if (blocked) throw Error('Storage is unavailable');
    return { getItem: name => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, value) };
  } });
  runInNewContext(source, context);
  return { root, toggle, scheme, browserColor,
    ready() { readyHandlers.get('DOMContentLoaded')(); },
    change(dark) { toggle.checked = dark; toggleHandlers.get('change')(); },
  };
}

test('첫 방문은 다크모드로 표시하고 브라우저 색상과 체크 상태를 맞춘다', () => {
  const page = openPage();
  assert.equal(page.root.dataset.theme, 'dark');
  assert.equal(page.scheme.content, 'dark');
  assert.equal(page.browserColor.content, '#0c111b');
  page.ready();
  assert.equal(page.toggle.checked, true);
});

test('저장된 밝은 테마를 화면 표시 전에 복원하고 양방향 전환과 재접속을 유지한다', () => {
  const storage = new Map([[key, 'light']]);
  const page = openPage(storage);
  assert.equal(page.root.dataset.theme, 'light');
  assert.equal(page.scheme.content, 'light');
  assert.equal(page.browserColor.content, '#f3f6fa');
  page.ready();
  assert.equal(page.toggle.checked, false);
  for (const dark of [true, false]) {
    page.change(dark);
    const expected = dark ? 'dark' : 'light';
    assert.equal(storage.get(key), expected);
    assert.equal(page.root.dataset.theme, expected);
    assert.equal(page.scheme.content, expected);
    assert.equal(page.browserColor.content, dark ? '#0c111b' : '#f3f6fa');
    const reopened = openPage(storage); reopened.ready();
    assert.equal(reopened.root.dataset.theme, expected);
    assert.equal(reopened.toggle.checked, dark);
  }
});

test('브라우저 저장소를 사용할 수 없어도 테마 전환은 계속 동작한다', () => {
  const page = openPage(new Map(), true); page.ready();
  assert.equal(page.toggle.checked, true);
  page.change(false);
  assert.equal(page.root.dataset.theme, 'light');
  page.change(true);
  assert.equal(page.root.dataset.theme, 'dark');
});
