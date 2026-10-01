#!/usr/bin/env node
// Phases inbox watcher CLI. See tools/upnext/README.md.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEdit } from './lib/claude.mjs';
import { DEFAULT_CONFIG_PATH, loadConfig } from './lib/config.mjs';
import { formatFindings, runDoctor } from './lib/doctor.mjs';
import { claimEpisode, planEpisode, readManifest } from './lib/episodes.mjs';
import { describeEvaluation, evaluate, scanInbox, waitUntilReady } from './lib/inbox.mjs';
import { LAUNCHD_LABEL, acquireLock, formatBytes, launchdPath, launchdPlist, notify, resolveBin } from './lib/system.mjs';

const USAGE = `Usage: node tools/upnext/upnext.mjs <command> [options]

Commands:
  doctor                 Check this Mac: Phases, inbox and episodes folders, skills, Claude Code, DaVinci Resolve
  status                 Show which required media are in the inbox, missing, or still copying
  check                  One-shot: wait for the set to settle, move it into its episode folder, open Resolve, start the edit
  watch                  Keep watching the inbox from a terminal and run "check" on every change
  rerun <episodeDir>     Start the edit again for an episode the watcher already handed off
  launchd print          Print the LaunchAgent plist
  launchd install        Run doctor, then install and load the LaunchAgent
  launchd uninstall      Unload and remove the LaunchAgent

Options:
  --config <path>        Config file (default: tools/upnext/config.json, or $PHASES_UPNEXT_CONFIG)
  --now                  Skip the settle window (check/watch)
  --dry-run              Report what would happen without moving media or starting anything
  --force                Install the LaunchAgent even if doctor reports a failure
  --json                 Machine-readable output (status, doctor)`;

/** @param {string} message */
function log(message) {
  const stamp = new Date().toLocaleString('sv-SE', { hour12: false });
  console.log(`[${stamp}] ${message}`);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = {
    positionals: /** @type {string[]} */ ([]),
    config: process.env.PHASES_UPNEXT_CONFIG || DEFAULT_CONFIG_PATH,
    now: false,
    dryRun: false,
    force: false,
    json: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') options.config = argv[++i] ?? '';
    else if (arg.startsWith('--config=')) options.config = arg.slice('--config='.length);
    else if (arg === '--now') options.now = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '-h' || arg === '--help') options.positionals.unshift('help');
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else options.positionals.push(arg);
  }
  if (!options.config) throw new Error('--config needs a path');
  return options;
}

/** @param {unknown} error @param {import('./lib/config.mjs').Config} config */
function explain(error, config) {
  const err = /** @type {NodeJS.ErrnoException} */ (error);
  if (err?.code === 'EPERM' || err?.code === 'EACCES') {
    return `${err.message}\nmacOS privacy controls blocked access to ${config.phasesDir}. Give ${process.execPath} access to the Documents folder (System Settings > Privacy & Security > Files and Folders, or Full Disk Access), or run "watch" from a terminal that already has access.`;
  }
  return err instanceof Error ? err.message : String(error);
}

/**
 * Settle, move, and start the edit for every complete set in the inbox.
 * @param {import('./lib/config.mjs').Config} config
 * @param {{ now: boolean, dryRun: boolean }} options
 */
async function processInbox(config, options) {
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
        log(`inbox ${config.inboxDir} does not exist; run "doctor" and set inboxDir in the config`);
        return 1;
      }
      if (outcome.status === 'empty') return exitCode;
      if (outcome.status === 'incomplete') {
        const missing = outcome.evaluation?.missing.map((role) => role.label).join(', ');
        log(missing ? `waiting for: ${missing}` : 'media set not ready; waiting for the next change');
        return exitCode;
      }
      if (outcome.status === 'timeout') {
        log('gave up waiting for media to finish copying; the next change will check again');
        return 2;
      }
      const { scan, evaluation } = outcome;
      if (!scan || !evaluation) return exitCode;

      if (options.dryRun) {
        const plan = await planEpisode(scan, config);
        log(`dry run: would move ${scan.topLevel.join(', ')} into ${plan.dir}${plan.exists ? ' (existing folder)' : ''}, make sure ${config.resolve.appName} is open, and start the edit`);
        return exitCode;
      }

      const manifest = await claimEpisode(scan, evaluation, config);
      log(`moved media into ${manifest.episodeDir}`);
      notify('Phases', `Media complete. Starting the edit for ${manifest.episodeName}.`, config);
      const run = await startEdit(manifest, config, { log });
      if (run.status === 'succeeded') {
        const cost = typeof run.costUsd === 'number' ? ` (reported $${run.costUsd.toFixed(2)})` : '';
        log(`edit run finished for ${manifest.episodeName}${cost}`);
        if (run.sessionId) log(`continue it interactively: cd "${config.phasesDir}" && claude --resume ${run.sessionId}`);
        notify('Phases', `Edit run finished for ${manifest.episodeName}.`, config);
      } else {
        exitCode = 1;
        log(`edit did not finish for ${manifest.episodeName} (${run.error}). Retry with: npm run upnext -- rerun "${manifest.episodeDir}"`);
        notify('Phases', `Edit did not finish for ${manifest.episodeName}. Check the log.`, config);
      }
    }
  } finally {
    release();
  }
}

/** @param {import('./lib/config.mjs').Config} config @param {{ json: boolean }} options */
async function status(config, options) {
  const scan = await scanInbox(config);
  const evaluation = evaluate(scan, config);
  if (options.json) {
    const roles = evaluation.roles.map(({ role, files }) => ({
      id: role.id,
      label: role.label,
      min: role.min,
      files: files.map((f) => ({ path: f.rel, size: f.size, busy: f.busy }))
    }));
    const summary = {
      inboxDir: config.inboxDir,
      exists: scan.exists,
      ready: scan.exists && evaluation.ready,
      roles,
      missing: evaluation.missing.map((role) => role.id),
      extras: evaluation.extras.map((f) => f.rel),
      busy: evaluation.busy
    };
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }
  console.log(`inbox: ${config.inboxDir}${scan.exists ? '' : ' (missing)'}`);
  for (const { role, files } of evaluation.roles) {
    const detail = files.length
      ? files.map((f) => `${f.rel} (${formatBytes(f.size)}${f.busy ? `, ${f.busy}` : ''})`).join(', ')
      : `missing (need ${role.min})`;
    console.log(`  ${files.length >= role.min ? '✓' : '✗'} ${role.label}: ${detail}`);
  }
  for (const file of evaluation.extras) console.log(`  + extra: ${file.rel} (${formatBytes(file.size)})`);
  for (const rel of scan.inProgress) console.log(`  … downloading: ${rel}`);
  console.log(describeEvaluation(evaluation));
  return 0;
}

/** @param {import('./lib/config.mjs').Config} config @param {{ json: boolean }} options */
async function doctor(config, options) {
  const findings = await runDoctor(config);
  console.log(options.json ? JSON.stringify(findings, null, 2) : formatFindings(findings));
  return findings.some((f) => f.level === 'fail') ? 1 : 0;
}

/** @param {import('./lib/config.mjs').Config} config @param {{ now: boolean, dryRun: boolean }} options */
async function watch(config, options) {
  if (!fs.existsSync(config.inboxDir)) {
    log(`inbox ${config.inboxDir} does not exist; run "doctor" and set inboxDir in the config`);
    return 1;
  }
  log(`watching ${config.inboxDir} (Ctrl-C to stop)`);
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
      await processInbox(config, options);
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
  const watcher = fs.watch(config.inboxDir, { recursive: true }, schedule);
  watcher.on('error', (error) => {
    log(`watcher stopped: ${explain(error, config)}`);
    process.exit(1);
  });
  // Safety net in case a file system notification is ever dropped.
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

/** @param {import('./lib/config.mjs').Config} config @param {string | undefined} episodeDir */
async function rerun(config, episodeDir) {
  if (!episodeDir) throw new Error('rerun needs the episode folder path');
  const manifest = await readManifest(path.resolve(episodeDir));
  const release = acquireLock(config.lockPath);
  if (!release) {
    log('another upnext run is active (lock held); try again when it finishes');
    return 1;
  }
  try {
    const run = await startEdit(manifest, config, { log });
    log(`run ${run.run} ${run.status}${run.error ? ` (${run.error})` : ''}${run.sessionId ? `, session ${run.sessionId}` : ''}`);
    return run.status === 'succeeded' ? 0 : 1;
  } finally {
    release();
  }
}

/** @param {import('./lib/config.mjs').Config} config @param {string | undefined} action @param {{ force: boolean }} options */
async function launchd(config, action, options) {
  const home = os.homedir();
  const plistPath = path.join(home, 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const domain = `gui/${process.getuid?.() ?? ''}`;
  const xml = launchdPlist({
    nodePath: resolveBin('node') ?? process.execPath,
    scriptPath: fileURLToPath(import.meta.url),
    configPath: config.configPath ?? DEFAULT_CONFIG_PATH,
    inboxDir: config.inboxDir,
    logPath: path.join(home, 'Library/Logs/phases-upnext.log'),
    pathEnv: launchdPath(home)
  });

  if (action === 'print') {
    process.stdout.write(xml);
    return 0;
  }
  if (action === 'install') {
    const findings = await runDoctor(config);
    console.log(formatFindings(findings));
    if (findings.some((f) => f.level === 'fail') && !options.force) {
      log('not installing: fix the ✗ items above (or pass --force)');
      return 1;
    }
    await fsp.mkdir(path.dirname(plistPath), { recursive: true });
    await fsp.writeFile(plistPath, xml);
    spawnSync('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
    const result = spawnSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' });
    if (result.status !== 0) return result.status ?? 1;
    log(`installed ${LAUNCHD_LABEL}; it runs when ${config.inboxDir} changes. Log: ~/Library/Logs/phases-upnext.log`);
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
      case 'doctor':
        return await doctor(config, options);
      case 'status':
        return await status(config, options);
      case 'check':
        return await processInbox(config, options);
      case 'watch':
        return await watch(config, options);
      case 'rerun':
        return await rerun(config, arg);
      case 'launchd':
        return await launchd(config, arg, options);
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
