// Make sure DaVinci Resolve is running before the edit starts. A running
// Resolve is left alone (no relaunch, no focus change).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realClock } from './inbox.mjs';
import { exec as realExec } from './system.mjs';

const POLL_MS = 1000;

/**
 * @typedef {import('./config.mjs').Config} Config
 * @typedef {{ status: 'skipped' | 'already-running' | 'launched' | 'failed', error?: string }} ResolveState
 */

/** @param {Config} config @param {import('./system.mjs').Exec} [exec] */
export function resolveRunning(config, exec = realExec) {
  return exec('pgrep', ['-x', config.resolve.processName]).status === 0;
}

/**
 * Where the Resolve app is installed, or null. Checks the usual install
 * locations, then Spotlight.
 * @param {Config} config
 * @param {import('./system.mjs').Exec} [exec]
 */
export function resolveAppPath(config, exec = realExec, home = os.homedir()) {
  const bundle = `${config.resolve.appName}.app`;
  const candidates = [
    path.join('/Applications', config.resolve.appName, bundle),
    path.join('/Applications', bundle),
    path.join(home, 'Applications', config.resolve.appName, bundle),
    path.join(home, 'Applications', bundle)
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;
  const query = `kMDItemContentType == "com.apple.application-bundle" && kMDItemDisplayName == "${config.resolve.appName.replace(/"/g, '')}*"`;
  const spotlight = exec('mdfind', [query]);
  return spotlight.status === 0 ? spotlight.stdout.split('\n').find(Boolean) ?? null : null;
}

/**
 * Open Resolve if it is not already running, then wait for its process plus a
 * short delay so its project manager and scripting API are up.
 * @param {Config} config
 * @param {{ exec?: import('./system.mjs').Exec, clock?: import('./inbox.mjs').Clock, log?: (msg: string) => void }} [deps]
 * @returns {Promise<ResolveState>}
 */
export async function ensureResolve(config, deps = {}) {
  if (!config.resolve.enabled) return { status: 'skipped' };
  const exec = deps.exec ?? realExec;
  const clock = deps.clock ?? realClock;
  const log = deps.log ?? (() => {});
  const { appName } = config.resolve;

  if (resolveRunning(config, exec)) return { status: 'already-running' };
  log(`opening ${appName}`);
  const opened = exec('open', ['-a', appName]);
  if (opened.status !== 0) {
    return { status: 'failed', error: `could not open ${appName}${opened.stderr.trim() ? `: ${opened.stderr.trim()}` : ''}` };
  }
  const deadline = clock.now() + config.resolve.launchTimeoutMs;
  while (!resolveRunning(config, exec)) {
    if (clock.now() >= deadline) {
      return { status: 'failed', error: `${appName} did not start within ${Math.round(config.resolve.launchTimeoutMs / 1000)}s` };
    }
    await clock.sleep(POLL_MS);
  }
  if (config.resolve.readyDelayMs > 0) await clock.sleep(config.resolve.readyDelayMs);
  return { status: 'launched' };
}

/** @param {ResolveState} state @param {Config} config */
export function describeResolve(state, config) {
  const { appName } = config.resolve;
  if (state.status === 'already-running') return `${appName} was already open`;
  if (state.status === 'launched') return `${appName} was opened for this edit`;
  if (state.status === 'skipped') return `${appName} is not managed by the watcher`;
  return `${appName} could not be opened (${state.error})`;
}
