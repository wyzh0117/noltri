// Run against a configured local Core: node apps/desktop/scripts/test-classification.mjs
// Uses real AI requests; requires an OpenAI-compatible provider and preserves collected cards.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const cases = JSON.parse(await readFile(path.join(repo, 'docs/testing/classification-cases.json'), 'utf8'));
const base = process.env.NOLTRI_API_BASE_URL || 'http://127.0.0.1:8787';
const output = process.env.NOLTRI_TEST_RESULTS || path.join(repo, 'docs/testing/0.1.1-deepseek-results.json');
async function request(route, method = 'GET', body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-noltri-client': 'desktop',
      ...(process.env.NOLTRI_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.NOLTRI_ACCESS_TOKEN}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(180_000),
  });
  const payload = await response.json();
  assert.ok(response.ok, `${method} ${route}: ${payload.error?.message || response.status}`);
  return payload;
}

const health = await request('/api/health');
assert.equal(health.version, '0.1.1');
assert.equal(health.aiProvider, 'openai-compatible', 'Live acceptance must use AI');
const results = { testedAt: new Date().toISOString(), version: '0.1.1', health, cases: [], manualEdit: null };
try {
  for (const [index, fixture] of cases.entries()) {
    const started = Date.now();
    const source = { type: 'web', title: fixture.label, url: fixture.url };
    let item;
    let capture;
    const entrypoint = index % 2 === 0 ? '/api/items' : '/api/capture';
    if (entrypoint === '/api/items') {
      ({ item } = await request(entrypoint, 'POST', {
        content: fixture.content, kind: fixture.kind, source: { ...source, ...(fixture.doi ? { doi: fixture.doi } : {}) },
        ...(fixture.doi ? {} : { subjectPath: [] }),
      }));
    } else {
      capture = await request(entrypoint, 'POST', {
        requestId: `acceptance-0.1.1-${fixture.id}`, text: fixture.content, source,
        capture: { capturedAt: new Date().toISOString(), client: 'desktop', deviceId: 'noltri-0.1.1-acceptance' },
        library: { kind: fixture.kind, ...(fixture.doi ? { doi: fixture.doi } : {}) },
      });
      item = await request(`/api/items/${encodeURIComponent(capture.rawSourceId)}`);
    }
    const passed = item.aiStatus === 'ready' && item.subjectPath.length > 1
      && new RegExp(fixture.pathPattern, 'i').test(item.subjectPath.join(' / '));
    results.cases.push({ id: fixture.id, expected: fixture.expected, entrypoint, passed, durationMs: Date.now() - started, item, ...(capture ? { capture } : {}) });
    console.log(`${passed ? 'PASS' : 'FAIL'} ${fixture.id}: ${item.subjectPath.join(' / ') || '(unclassified)'}`);
  }
  const original = results.cases[0].item;
  const editedPath = ['计算机科学', '编程语言', 'Python', '用户修订分类'];
  const editedResearchPoint = '用户可修改 AI 分类和研究点';
  const editedContent = `${original.content}\n用户校验编辑`;
  const editedTitle = `${original.source.title} · 已编辑`;
  await request(`/api/items/${original.id}`, 'PATCH', { subjectPath: editedPath, researchPoint: editedResearchPoint, content: editedContent, source: { title: editedTitle } });
  const edited = await request(`/api/items/${original.id}`);
  results.manualEdit = { itemId: original.id, originalPath: original.subjectPath, editedPath: edited.subjectPath, researchPoint: edited.researchPoint, content: edited.content, title: edited.source.title, passed: JSON.stringify(edited.subjectPath) === JSON.stringify(editedPath) && edited.researchPoint === editedResearchPoint && edited.content === editedContent && edited.source.title === editedTitle };
  // Keep the visible example in its original AI classification after checking the override.
  await request(`/api/items/${original.id}`, 'PATCH', { subjectPath: original.subjectPath, researchPoint: original.researchPoint, content: original.content, source: { title: original.source.title } });
  assert.ok(results.cases.every(result => result.passed), 'At least one AI classification failed; inspect saved results');
  assert.ok(results.manualEdit.passed, 'Manual classification edit was not persisted');
} finally {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`Saved ${results.cases.length} cases to ${output}`);
}
