// Decide when the inbox holds a complete, fully copied set of episode media.

import fsp from 'node:fs/promises';
import path from 'node:path';

// Finder stamps files with this creation date while a copy is still in flight.
const FINDER_COPY_BIRTH_YEAR = 1984;
const MAX_SCAN_DEPTH = 4;

/**
 * @typedef {import('./config.mjs').Config} Config
 * @typedef {{ rel: string, name: string, size: number, mtimeMs: number, ctimeMs: number, busy: string | null }} MediaFile
 * @typedef {{ exists: boolean, topLevel: string[], topLevelDirs: string[], files: MediaFile[], inProgress: string[], dirChangeMs: number }} Scan
 */

/**
 * Why a file is not safe to hand off yet, or null when it looks fully written.
 * @param {{ size: number, birthtime: Date }} stat
 */
export function busyReason(stat) {
  if (stat.size === 0) return 'empty file (still being created)';
  if (stat.birthtime.getFullYear() === FINDER_COPY_BIRTH_YEAR) return 'Finder copy in progress';
  return null;
}

/**
 * List the media in the inbox, recursing into dropped folders.
 * @param {Config} config
 * @returns {Promise<Scan>}
 */
export async function scanInbox(config) {
  /** @type {Scan} */
  const scan = { exists: true, topLevel: [], topLevelDirs: [], files: [], inProgress: [], dirChangeMs: 0 };
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await fsp.readdir(config.inboxDir, { withFileTypes: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return { ...scan, exists: false };
    throw error;
  }

  /** @param {string} relDir @param {import('node:fs').Dirent[]} dirents @param {number} depth */
  const walk = async (relDir, dirents, depth) => {
    for (const entry of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (config.isIgnored(entry.name)) continue;
      const rel = relDir ? path.join(relDir, entry.name) : entry.name;
      if (!relDir) {
        scan.topLevel.push(entry.name);
        if (entry.isDirectory()) scan.topLevelDirs.push(entry.name);
      }
      if (config.isInProgress(entry.name)) {
        scan.inProgress.push(rel);
        continue;
      }
      const absolute = path.join(config.inboxDir, rel);
      if (entry.isDirectory()) {
        const dirStat = await fsp.stat(absolute).catch(() => null);
        if (dirStat) scan.dirChangeMs = Math.max(scan.dirChangeMs, dirStat.ctimeMs);
        if (dirStat && depth < MAX_SCAN_DEPTH) {
          await walk(rel, await fsp.readdir(absolute, { withFileTypes: true }), depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fsp.stat(absolute).catch(() => null);
      if (!stat) continue;
      scan.files.push({
        rel,
        name: entry.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        busy: busyReason(stat)
      });
    }
  };
  await walk('', entries, 0);
  return scan;
}

/** @param {Scan} scan */
export function fingerprint(scan) {
  return JSON.stringify([scan.files.map((f) => [f.rel, f.size, f.mtimeMs, f.ctimeMs, f.busy]), scan.inProgress]);
}

/**
 * Most recent change to any media file or dropped folder. ctime advances on
 * every write, rename, and metadata change, and unlike mtime it cannot be
 * back-dated by copy tools that preserve the source modification date.
 * @param {Scan} scan
 */
export function lastChangeMs(scan) {
  return scan.files.reduce((latest, file) => Math.max(latest, file.ctimeMs), scan.dirChangeMs);
}

/**
 * Assign files to roles (first matching role wins) and decide readiness.
 * @param {Scan} scan
 * @param {Config} config
 */
export function evaluate(scan, config) {
  const roles = config.roles.map((role) => ({ role, files: /** @type {MediaFile[]} */ ([]) }));
  /** @type {MediaFile[]} */
  const extras = [];
  for (const file of scan.files) {
    const slot = roles.find(({ role, files }) => role.matches(file.name) && (role.max === null || files.length < role.max));
    if (slot) slot.files.push(file);
    else extras.push(file);
  }
  const missing = roles.filter(({ role, files }) => files.length < role.min).map(({ role }) => role);
  const busy = [
    ...scan.files.filter((f) => f.busy).map((f) => `${f.rel} (${f.busy})`),
    ...scan.inProgress.map((rel) => `${rel} (download in progress)`)
  ];
  const complete = missing.length === 0;
  const blockedByExtras = !config.allowExtraFiles && extras.length > 0;
  return { roles, extras, missing, busy, complete, ready: complete && busy.length === 0 && !blockedByExtras, blockedByExtras };
}

/** @typedef {ReturnType<typeof evaluate>} Evaluation */

/** @param {Evaluation} evaluation */
export function describeEvaluation(evaluation) {
  const parts = evaluation.roles.map(({ role, files }) => `${role.id} ${files.length}/${role.min}${files.length >= role.min ? ' ok' : ''}`);
  if (evaluation.extras.length) parts.push(`extra ${evaluation.extras.length}`);
  if (evaluation.busy.length) parts.push(`busy: ${evaluation.busy.join(', ')}`);
  if (evaluation.blockedByExtras) parts.push('blocked: unexpected files (allowExtraFiles is false)');
  const state = evaluation.ready ? 'complete, settling' : evaluation.complete ? 'complete, waiting' : 'incomplete';
  return `${state} — ${parts.join('; ')}`;
}

export const realClock = {
  now: () => Date.now(),
  sleep: (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

/** @typedef {typeof realClock} Clock */

/**
 * Poll the inbox until the media set is complete and unchanged for the settle
 * window, the inbox goes idle while incomplete, or the wait times out. Settling
 * is measured from the newest file change, so media that finished copying
 * before the watcher started is handed off without an extra wait.
 * @param {Config} config
 * @param {{ settleMs?: number, log?: (msg: string) => void, clock?: Clock }} [options]
 * @returns {Promise<{ status: 'missing-dir' | 'empty' | 'ready' | 'incomplete' | 'timeout', scan?: Scan, evaluation?: Evaluation }>}
 */
export async function waitUntilReady(config, options = {}) {
  const clock = options.clock ?? realClock;
  const log = options.log ?? (() => {});
  const settleMs = options.settleMs ?? config.settleMs;
  const started = clock.now();
  let lastSummary = '';
  let lastFingerprint = '';
  let changedAt = 0;

  for (;;) {
    const scan = await scanInbox(config);
    if (!scan.exists) return { status: 'missing-dir' };
    if (scan.topLevel.length === 0) return { status: 'empty', scan };
    const evaluation = evaluate(scan, config);
    const now = clock.now();
    const print = fingerprint(scan);
    if (lastFingerprint && print !== lastFingerprint) changedAt = now;
    lastFingerprint = print;
    changedAt = Math.max(changedAt, Math.min(now, lastChangeMs(scan)));
    if (scan.inProgress.length) changedAt = now;

    const summary = describeEvaluation(evaluation);
    if (summary !== lastSummary) {
      log(summary);
      lastSummary = summary;
    }

    if (evaluation.ready && now - changedAt >= settleMs) return { status: 'ready', scan, evaluation };
    const idle = evaluation.busy.length === 0 && now - changedAt >= config.idleExitMs;
    if (!evaluation.ready && idle) return { status: 'incomplete', scan, evaluation };
    if (now - started >= config.maxWaitMs) return { status: 'timeout', scan, evaluation };
    await clock.sleep(config.pollMs);
  }
}
