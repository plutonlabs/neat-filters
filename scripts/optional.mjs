// Optional packs: lists that are NOT part of the default set and that clients only fetch when the person
// switches the matching feature on (today: the adult-content filter).
//
// They are published next to manifest.json as `optional.json` plus one file per pack. Clients that only know
// manifest.json never read them, so a new pack cannot turn itself on for anybody.
//
// A pack is a plain list of domains, one per line (lower case, sorted, no comments). A client blocks a domain
// and everything below it.

import { createHash } from 'node:crypto';

export const OPTIONAL_SCHEMA = 1;

const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const sha256 = data => createHash('sha256').update(data).digest('hex');

/**
 * The domains in a list in Adblock Plus syntax (`||example.com^`), hosts syntax (`0.0.0.0 example.com`) or one
 * bare domain per line. Rules with options, paths, wildcards or exceptions, comments and anything that is not a
 * valid host name are skipped. Returns a sorted array without duplicates.
 */
export function parseDomains(text) {
  const out = new Set();
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '!' || line[0] === '#' || line[0] === '[' || line.startsWith('@@')) continue;

    let host = null;
    let m;
    if ((m = /^\|\|([^\s/^*$|]+)\^$/.exec(line))) host = m[1];
    else if ((m = /^(?:0\.0\.0\.0|127\.0\.0\.1)\s+(\S+)(?:\s+#.*)?$/.exec(line))) host = m[1];
    else if (/^[A-Za-z0-9.-]+$/.test(line)) host = line;
    if (host === null) continue;

    host = host.toLowerCase().replace(/\.$/, '');
    if (host.length <= 253 && HOST.test(host)) out.add(host);
  }
  return [...out].sort();
}

/**
 * Builds the packs of `sources.optionalPacks`. A pack whose sources cannot be reached, or that shrank to less than
 * half of what the previous release had, keeps the previous release's copy.
 *
 * @param prev { manifest: parsed optional.json of the previous release or null, read(file): its text or null }
 * @param fetchText async (url) => text
 */
export async function buildOptionalPacks(sources, prev, fetchText, log = () => {}) {
  const packs = [];
  const skipped = [];
  const dropRatio = sources.sanity?.optionalDropRatio ?? 0.5;

  for (const def of sources.optionalPacks ?? []) {
    const before = prev?.manifest?.packs?.find(p => p.id === def.id);
    let domains = null;
    let source = null;
    for (const url of def.urls) {
      try {
        const found = parseDomains(await fetchText(url));
        if (found.length === 0) throw new Error('no domains in it');
        domains = found;
        source = url;
        break;
      } catch (e) {
        log(`${def.file}: ${url} unusable (${String(e.message).split('\n')[0]})`);
      }
    }

    const tooSmall = domains !== null && domains.length < (def.minDomains ?? 1);
    const shrank = domains !== null && before?.domains > 0 && domains.length < before.domains * (1 - dropRatio);
    if (domains === null || tooSmall || shrank) {
      const old = before && prev.read(before.file);
      if (old && sha256(old) === before.sha256) {
        log(`${def.file}: ${domains === null ? 'no source reachable' : `only ${domains.length} domains`}; keeping the previous release's copy`);
        packs.push({ ...before, kept: true });
      } else {
        log(`${def.file}: ${domains === null ? 'no source reachable' : `only ${domains.length} domains`} and no earlier copy; left out`);
        skipped.push(def.id);
      }
      continue;
    }

    const body = domains.join('\n') + '\n';
    packs.push({
      id: def.id,
      title: def.title,
      kind: 'domains',
      file: def.file,
      sha256: sha256(body),
      size: Buffer.byteLength(body),
      domains: domains.length,
      source,
      license: def.license ?? null,
      body,
    });
    log(`${def.file}: ${domains.length} domains from ${source}`);
  }

  return { packs, skipped };
}

/** The text of optional.json for these packs (nothing in it depends on the pack bodies). */
export function optionalManifest(packs, version, generated) {
  return JSON.stringify({
    schema: OPTIONAL_SCHEMA,
    version,
    generated,
    packs: packs.map(({ body, kept, ...p }) => p),
  }, null, 2) + '\n';
}
