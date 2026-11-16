import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildOptionalPacks, optionalManifest, parseDomains } from './optional.mjs';

const sha = s => createHash('sha256').update(s).digest('hex');

test('parseDomains reads adblock, hosts and bare lines and skips the rest', () => {
  const text = [
    '[Adblock Plus]', '! Title: x', '# comment', '',
    '||Example.com^', '||sub.example.org^', '||example.com^',          // case, duplicate
    '0.0.0.0 hosts.example.net', '127.0.0.1 other.example.net # note',
    'bare.example.io', 'BARE2.example.io.',
    '@@||allowed.example.com^', '||path.example.com/x^', '||wild*.example.com^', '||opt.example.com^$third-party',
    '||nodot^', '||-bad-.example.com^', '||ünicode.example.com^', '0.0.0.0 localhost',
  ].join('\r\n');
  assert.deepEqual(parseDomains(text), [
    'bare.example.io', 'bare2.example.io', 'example.com', 'hosts.example.net', 'other.example.net', 'sub.example.org',
  ]);
});

test('parseDomains: very long or broken host names are skipped', () => {
  assert.deepEqual(parseDomains('||' + 'a'.repeat(64) + '.com^\n||' + 'a.'.repeat(130) + 'com^'), []);
});

const def = { id: 'adult', title: 'Adult', file: 'optional-adult.txt', minDomains: 3, urls: ['https://one.test/l.txt', 'https://two.test/l.txt'] };
const sources = { optionalPacks: [def], sanity: { optionalDropRatio: 0.5 } };
const listOf = n => Array.from({ length: n }, (_, i) => `||d${i}.example.com^`).join('\n');
const fetcher = table => async url => {
  if (!(url in table)) throw new Error('HTTP 404');
  return table[url];
};

test('a pack is built from the first source that works', async () => {
  const { packs, skipped } = await buildOptionalPacks(sources, null, fetcher({ 'https://two.test/l.txt': listOf(5) }));
  assert.equal(skipped.length, 0);
  assert.equal(packs.length, 1);
  assert.equal(packs[0].domains, 5);
  assert.equal(packs[0].source, 'https://two.test/l.txt');
  assert.equal(packs[0].kind, 'domains');
  assert.equal(packs[0].sha256, sha(packs[0].body));
  assert.equal(packs[0].size, Buffer.byteLength(packs[0].body));
  assert.equal(packs[0].body.split('\n').filter(Boolean).length, 5);
});

test('no source and no earlier copy: the pack is left out', async () => {
  const { packs, skipped } = await buildOptionalPacks(sources, null, fetcher({}));
  assert.equal(packs.length, 0);
  assert.deepEqual(skipped, ['adult']);
});

test('no source: the previous release copy is kept (only if its hash still matches)', async () => {
  const oldBody = listOf(10).replace(/\|\||\^/g, '') + '\n';
  const before = { id: 'adult', title: 'Adult', kind: 'domains', file: def.file, sha256: sha(oldBody), size: oldBody.length, domains: 10, source: 's' };
  const prev = { manifest: { packs: [before] }, read: () => oldBody };
  const kept = await buildOptionalPacks(sources, prev, fetcher({}));
  assert.equal(kept.packs.length, 1);
  assert.equal(kept.packs[0].kept, true);
  assert.equal(kept.packs[0].body, undefined);

  const damaged = await buildOptionalPacks(sources, { manifest: { packs: [before] }, read: () => 'tampered\n' }, fetcher({}));
  assert.equal(damaged.packs.length, 0);
});

test('a list that shrank a lot is not published, the previous copy stays', async () => {
  const oldBody = 'x\n';
  const before = { id: 'adult', file: def.file, sha256: sha(oldBody), domains: 100 };
  const prev = { manifest: { packs: [before] }, read: () => oldBody };
  const { packs } = await buildOptionalPacks({ ...sources, optionalPacks: [{ ...def, minDomains: 1 }] }, prev, fetcher({ 'https://one.test/l.txt': listOf(10) }));
  assert.equal(packs[0].kept, true);
  assert.equal(packs[0].domains, 100);
});

test('fewer domains than the minimum is refused', async () => {
  const { packs, skipped } = await buildOptionalPacks(sources, null, fetcher({ 'https://one.test/l.txt': listOf(2) }));
  assert.equal(packs.length, 0);
  assert.deepEqual(skipped, ['adult']);
});

test('optional.json describes the packs without their text', async () => {
  const { packs } = await buildOptionalPacks(sources, null, fetcher({ 'https://one.test/l.txt': listOf(4) }));
  const json = JSON.parse(optionalManifest(packs, '2026.11.15.1200', '2026-11-15T12:00:00.000Z'));
  assert.equal(json.schema, 1);
  assert.equal(json.version, '2026.11.15.1200');
  assert.equal(json.packs.length, 1);
  assert.equal(json.packs[0].id, 'adult');
  assert.equal(json.packs[0].file, 'optional-adult.txt');
  assert.equal(json.packs[0].domains, 4);
  assert.equal('body' in json.packs[0], false);
  assert.equal('kept' in json.packs[0], false);
});
