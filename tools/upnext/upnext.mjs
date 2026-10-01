#!/usr/bin/env node
// Phases upnext watcher CLI. See tools/upnext/README.md.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG_PATH,
  LAUNCHD_LABEL,
  acquireLock,
  claimBatch,
  describeEvaluation,
  evaluate,
  formatBytes,
  launchdPath,
  launchdPlist,
  loadConfig,
  notify,
  readManifest,
  resolveBin,
  runClaude,
  scanWatchDir,
  waitUntilReady
} from './lib.mjs';

const USAGE = `Usage: node tools/upnext/upnext.mjs <command> [options]

Commands:
  status                 Show which required media are present, missing, or still copying
  check                  One-shot: wait for the set to settle, claim it, run Claude Code
  watch                  Keep watching upnext (FSEvents) and run "check" on every change
  rerun <projectDir>     Run Claude Code again for an already-claimed project
  launchd print          Print the LaunchAgent plist (WatchPaths, no resident process)
  launchd install        Install and load the LaunchAgent for this config
  launchd uninstall      Unload and remove the LaunchAgent

Options:
  --config <path>        Config file (default: tools/upnext/config.json, or $PHASES_UPNEXT_CONFIG)
  --now                  Skip the settle window (check/watch)
  --dry-run              Report what would happen without moving media or running Claude
  --json                 Machine-readable status output`;

/** @param {string} message */
function log(message) {
  const stamp = new Date().toLocaleString('sv-SE', { hour12: false });
  console.log(`[${stamp}] ${message}`);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ positionals: string[], config: string, now: boolean, dryRun: boolean, json: boolean }} */
  const options = {
    positionals: [],
    config: process.env.PHASES_UPNEXT_CONFIG || DEFAULT_CONFIG_PATH,
    now: false,
    dryRun: false,
    json: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') options.config = argv[++i] ?? '';
    else if (arg.startsWith('--config=')) options.config = arg.slice('--config='.length);
    else if (arg === '--now') options.now = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '-h' || arg === '--help') options.positionals.unshift('help');
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else options.positionals.push(arg);
  }
  if (!options.config) throw new Error('--config needs a path');
  return options;
}

/** @param {unknown} error @param {import('./lib.mjs').Config} config */
function explain(error, config) {
  const err = /** @type {NodeJS.ErrnoException} */ (error);
  if (err?.code === 'EPERM' || err?.code === 'EACCES') {
    return `${err.message}\nmacOS privacy controls blocked access to ${config.watchDir}. Grant "${process.execPath}" access to the Documents folder (System Settings > Privacy & Security > Files and Folders, or Full Disk Access), or run "watch" from a terminal that already has access.`;
  }
  return err?.stack ?? String(error);
}

/**
 * Settle, claim, and edit every complete batch in upnext. Returns an exit code.
 * @param {import('./lib.mjs').Config} config
 * @param {{ now: boolean, dryRun: boolean }} options
 */
async function processPending(config, options) {
  const release = options.dryRun ? () => {} : acquireLock(config.lockPath);
  if (!release) {
    log('another upnext run is active (lock held); skipping');
    return 0;
  }
  let exitCode = 0;
  try {
    for (;;) {
      const outcome = await waitUntilReady(config, { settleMs: options.now ? 0 : undefined, log });
      if (outcome.status === 'missing-dir') {
        log(`watch folder ${config.watchDir} does not exist yet; create it or run "watch"`);
        return exitCode;
      }
      if (outcome.status === 'empty') return exitCode;
      if (outcome.status === 'incomplete') {
        const missing = outcome.evaluation?.missing.map((role) => role.label).join(', ');
        log(missing ? `waiting for: ${missing}` : 'media set not ready; waiting for the next change');
        return exitCode;
      }
      if (outcome.status === 'timeout') {
        log('gave up waiting for media to finish copying; the next change will re-check');
        return 2;
      }
      const { scan, evaluation } = outcome;
      if (!scan || !evaluation) return exitCode;
      if (options.dryRun) {
        log(`dry run: would claim ${scan.topLevel.join(', ')} into ${config.projectsDir} and start Claude Code`);
        return exitCode;
      }

      const manifest = await claimBatch(scan, evaluation, config);
      log(`claimed media into ${manifest.projectDir}`);
      notify('Phases upnext', `Media complete. Claude Code is editing ${manifest.batchId}.`, config);
      const run = await runClaude(manifest, config, { log });
      if (run.status === 'succeeded') {
        const cost = typeof run.costUsd === 'number' ? ` ($${run.costUsd.toFixed(2)})` : '';
        log(`Claude Code finished ${manifest.batchId}${cost}; outputs in ${manifest.outputDir}`);
        if (run.sessionId) log(`resume interactively: cd "${manifest.projectDir}" && claude --resume ${run.sessionId}`);
        notify('Phases upnext', `Edit finished for ${manifest.batchId}.`, config);
      } else {
        exitCode = 1;
        log(`Claude Code failed for ${manifest.batchId} (${run.error ?? `exit ${run.exitCode}`}); see ${manifest.projectDir}. Retry with: npm run upnext -- rerun "${manifest.projectDir}"`);
        notify('Phases upnext', `Edit failed for ${manifest.batchId}. Check the project log.`, config);
      }
    }
  } finally {
    release();
  }
}

/** @param {import('./lib.mjs').Config} config @param {{ json: boolean }} options */
async function status(config, options) {
  const scan = await scanWatchDir(config);
  const evaluation = evaluate(scan, config);
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          watchDir: config.watchDir,
          exists: scan.exists,
          ready: scan.exists && evaluation.ready,
          roles: evaluation.roles.map(({ role, files }) => ({
            id: role.id,
            label: role.label,
            min: role.min,
            files: files.map((f) => ({ path: f.rel, size: f.size, busy: f.busy }))
          })),
          missing: evaluation.missing.map((role) => role.id),
          extras: evaluation.extras.map((f) => f.rel),
          busy: evaluation.busy
        },
        null,
        2
      )
    );
    return 0;
  }
  console.log(`watch folder: ${config.watchDir}${scan.exists ? '' : ' (missing)'}`);
  for (const { role, files } of evaluation.roles) {
    const ok = files.length >= role.min;
    const detail = files.length
      ? files.map((f) => `${f.rel} (${formatBytes(f.size)}${f.busy ? `, ${f.busy}` : ''})`).join(', ')
      : `missing (need ${role.min})`;
    console.log(`  ${ok ? '✓' : '✗'} ${role.label}: ${detail}`);
  }
  for (const file of evaluation.extras) console.log(`  + extra: ${file.rel} (${formatBytes(file.size)})`);
  for (const busy of scan.inProgress) console.log(`  … downloading: ${busy}`);
  console.log(describeEvaluation(evaluation));
  return 0;
}

/** @param {import('./lib.mjs').Config} config @param {{ now: boolean, dryRun: boolean }} options */
async function watch(config, options) {
  await fsp.mkdir(config.watchDir, { recursive: true });
  log(`watching ${config.watchDir} (Ctrl-C to stop)`);
  let running = false;
  let again = false;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 1000);
  };
  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await processPending(config, options);
    } catch (error) {
      log(`error: ${explain(error, config)}`);
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    }
  };
  const watcher = fs.watch(config.watchDir, { recursive: true }, schedule);
  watcher.on('error', (error) => {
    log(`watcher stopped: ${explain(error, config)}`);
    process.exit(1);
  });
  // Safety net in case an FSEvents notification is ever dropped.
  setInterval(schedule, 15 * 60_000).unref();
  const stop = () => {
    watcher.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  schedule();
  return new Promise(() => {});
}

/** @param {import('./lib.mjs').Config} config @param {string | undefined} projectDir */
async function rerun(config, projectDir) {
  if (!projectDir) throw new Error('rerun needs the project folder path');
  const manifest = await readManifest(path.resolve(projectDir));
  const release = acquireLock(config.lockPath);
  if (!release) {
    log('another upnext run is active (lock held); try again when it finishes');
    return 1;
  }
  try {
    const run = await runClaude(manifest, config, { log });
    log(`run ${run.run} ${run.status}${run.sessionId ? ` (session ${run.sessionId})` : ''}`);
    return run.status === 'succeeded' ? 0 : 1;
  } finally {
    release();
  }
}

/** @param {import('./lib.mjs').Config} config @param {string | undefined} action */
async function launchd(config, action) {
  const home = os.homedir();
  const plistPath = path.join(home, 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const domain = `gui/${process.getuid?.() ?? ''}`;
  const xml = launchdPlist({
    nodePath: resolveBin('node') ?? process.execPath,
    scriptPath: fileURLToPath(import.meta.url),
    configPath: config.configPath ?? DEFAULT_CONFIG_PATH,
    watchDir: config.watchDir,
    logPath: path.join(home, 'Library/Logs/phases-upnext.log'),
    pathEnv: launchdPath(home)
  });

  if (action === 'print') {
    process.stdout.write(xml);
    return 0;
  }
  if (action === 'install') {
    await fsp.mkdir(config.watchDir, { recursive: true });
    await fsp.mkdir(path.dirname(plistPath), { recursive: true });
    await fsp.writeFile(plistPath, xml);
    spawnSync('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
    const result = spawnSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' });
    if (result.status !== 0) return result.status ?? 1;
    log(`installed ${LAUNCHD_LABEL}; it runs when ${config.watchDir} changes. Log: ~/Library/Logs/phases-upnext.log`);
    return 0;
  }
  if (action === 'uninstall') {
    spawnSync('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
    await fsp.rm(plistPath, { force: true });
    log(`removed ${LAUNCHD_LABEL}`);
    return 0;
  }
  console.error(`launchd needs one of: print, install, uninstall\n\n${USAGE}`);
  return 64;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [command = 'help', arg] = options.positionals;
  if (command === 'help') {
    console.log(USAGE);
    return 0;
  }
  const config = loadConfig(options.config);
  try {
    switch (command) {
      case 'status':
        return await status(config, options);
      case 'check':
        return await processPending(config, options);
      case 'watch':
        return await watch(config, options);
      case 'rerun':
        return await rerun(config, arg);
      case 'launchd':
        return await launchd(config, arg);
      default:
        console.error(`Unknown command "${command}"\n\n${USAGE}`);
        return 64;
    }
  } catch (error) {
    log(`error: ${explain(error, config)}`);
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
);
