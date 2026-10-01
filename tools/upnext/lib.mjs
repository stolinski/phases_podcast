// Core logic for the Phases upnext watcher: decide when the upnext folder holds a
// complete, fully-copied set of episode media, claim it into a per-episode project
// folder, and hand that project to Claude Code in headless mode.
//
// Node built-ins only, so it runs the same from a terminal, npm, or launchd.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = path.join(TOOL_DIR, 'config.json');
export const LAUNCHD_LABEL = 'fm.phases.upnext';
export const MANIFEST_NAME = 'upnext.json';

// Finder stamps files with this creation date while a copy is still in flight.
const FINDER_COPY_BIRTH_YEAR = 1984;
const MAX_SCAN_DEPTH = 4;

/** @param {string} p */
export function expandHome(p, home = os.homedir()) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/**
 * Case-insensitive glob supporting `*`, `?`, and `{a,b}` alternatives.
 * @param {string} glob
 */
export function globToRegExp(glob) {
  let source = '';
  let braceDepth = 0;
  for (const ch of glob) {
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else if (ch === '{') {
      braceDepth += 1;
      source += '(?:';
    } else if (ch === '}' && braceDepth > 0) {
      braceDepth -= 1;
      source += ')';
    } else if (ch === ',' && braceDepth > 0) source += '|';
    else source += ch.replace(/[\\^$.+()[\]{}|/]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'is');
}

/** @param {string[]} globs */
function compileGlobs(globs) {
  const patterns = globs.map(globToRegExp);
  return (/** @type {string} */ name) => patterns.some((re) => re.test(name));
}

const DEFAULT_CLAUDE = {
  bin: 'claude',
  promptTemplate: './prompt.md',
  permissionMode: 'acceptEdits',
  allowedTools: /** @type {string[]} */ ([]),
  model: /** @type {string | null} */ (null),
  effort: /** @type {string | null} */ (null),
  maxBudgetUsd: /** @type {number | null} */ (null),
  extraArgs: /** @type {string[]} */ ([])
};

const DEFAULTS = {
  watchDir: '~/Documents/phases/upnext',
  projectsDir: '~/Documents/phases/projects',
  lockPath: '~/Documents/phases/.upnext.lock',
  settleSeconds: 30,
  pollSeconds: 5,
  idleExitSeconds: 120,
  maxWaitMinutes: 180,
  allowExtraFiles: true,
  ignore: ['.*', '*.icloud'],
  inProgress: ['*.download', '*.crdownload', '*.part', '*.partial', '*.opdownload', '*.tmp'],
  requiredMedia: /** @type {any[]} */ ([]),
  probe: true,
  ffprobeBin: 'ffprobe',
  notify: true,
  claude: DEFAULT_CLAUDE
};

/**
 * @typedef {{ id: string, label: string, min: number, max: number | null, matches: (name: string) => boolean }} Role
 * @typedef {ReturnType<typeof normalizeConfig>} Config
 */

/**
 * @param {Record<string, any>} raw
 * @param {{ baseDir?: string, home?: string, configPath?: string }} [options]
 */
export function normalizeConfig(raw, options = {}) {
  const baseDir = options.baseDir ?? TOOL_DIR;
  const home = options.home ?? os.homedir();
  const merged = { ...DEFAULTS, ...raw, claude: { ...DEFAULT_CLAUDE, ...(raw.claude ?? {}) } };
  const resolvePath = (/** @type {string} */ p) => path.resolve(baseDir, expandHome(p, home));

  if (!Array.isArray(merged.requiredMedia) || merged.requiredMedia.length === 0) {
    throw new Error('config.requiredMedia must list at least one media role');
  }
  /** @type {Role[]} */
  const roles = merged.requiredMedia.map((role, index) => {
    if (!role || typeof role.id !== 'string' || !role.id) {
      throw new Error(`config.requiredMedia[${index}] needs a string id`);
    }
    const match = role.match ?? [];
    const extensions = (role.extensions ?? []).map((/** @type {string} */ ext) =>
      ext.toLowerCase().replace(/^\./, '')
    );
    if (match.length === 0 && extensions.length === 0) {
      throw new Error(`config.requiredMedia "${role.id}" needs match globs or extensions`);
    }
    const min = role.min ?? 1;
    if (!Number.isInteger(min) || min < 0) {
      throw new Error(`config.requiredMedia "${role.id}" min must be a non-negative integer`);
    }
    const max = role.max ?? null;
    const nameMatches = match.length ? compileGlobs(match) : () => true;
    return {
      id: role.id,
      label: role.label ?? role.id,
      min,
      max,
      matches: (/** @type {string} */ name) => {
        const ext = path.extname(name).slice(1).toLowerCase();
        return (extensions.length === 0 || extensions.includes(ext)) && nameMatches(name);
      }
    };
  });
  if (!roles.some((role) => role.min > 0)) {
    throw new Error('config.requiredMedia must require at least one file (min >= 1)');
  }

  const claude = merged.claude;
  return {
    configPath: options.configPath ?? null,
    watchDir: resolvePath(merged.watchDir),
    projectsDir: resolvePath(merged.projectsDir),
    lockPath: resolvePath(merged.lockPath),
    settleMs: merged.settleSeconds * 1000,
    pollMs: Math.max(250, merged.pollSeconds * 1000),
    idleExitMs: merged.idleExitSeconds * 1000,
    maxWaitMs: merged.maxWaitMinutes * 60_000,
    allowExtraFiles: Boolean(merged.allowExtraFiles),
    isIgnored: compileGlobs(merged.ignore),
    isInProgress: compileGlobs(merged.inProgress),
    roles,
    probe: Boolean(merged.probe),
    ffprobeBin: merged.ffprobeBin,
    notify: Boolean(merged.notify),
    claude: {
      ...claude,
      promptTemplate: resolvePath(claude.promptTemplate)
    }
  };
}

/** @param {string} [configPath] */
export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const absolute = path.resolve(configPath);
  const raw = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  return normalizeConfig(raw, { baseDir: path.dirname(absolute), configPath: absolute });
}

/**
 * @typedef {{ rel: string, name: string, size: number, mtimeMs: number, ctimeMs: number, busy: string | null }} MediaFile
 * @typedef {{ exists: boolean, topLevel: string[], files: MediaFile[], inProgress: string[], dirChangeMs: number }} Scan
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
 * List the media in the watch folder (recursing into dropped folders).
 * @param {Config} config
 * @returns {Promise<Scan>}
 */
export async function scanWatchDir(config) {
  /** @type {Scan} */
  const scan = { exists: true, topLevel: [], files: [], inProgress: [], dirChangeMs: 0 };
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await fsp.readdir(config.watchDir, { withFileTypes: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return { ...scan, exists: false };
    throw error;
  }

  /** @param {string} relDir @param {import('node:fs').Dirent[]} dirents @param {number} depth */
  const walk = async (relDir, dirents, depth) => {
    for (const entry of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (config.isIgnored(entry.name)) continue;
      const rel = relDir ? path.join(relDir, entry.name) : entry.name;
      if (!relDir) scan.topLevel.push(entry.name);
      if (config.isInProgress(entry.name)) {
        scan.inProgress.push(rel);
        continue;
      }
      const absolute = path.join(config.watchDir, rel);
      if (entry.isDirectory()) {
        const dirStat = await fsp.stat(absolute).catch(() => null);
        if (dirStat) scan.dirChangeMs = Math.max(scan.dirChangeMs, dirStat.ctimeMs);
        if (dirStat && depth < MAX_SCAN_DEPTH) {
          await walk(rel, await fsp.readdir(absolute, { withFileTypes: true }), depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = await fsp.stat(absolute);
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
        throw error;
      }
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
  return JSON.stringify([
    scan.files.map((f) => [f.rel, f.size, f.mtimeMs, f.ctimeMs, f.busy]),
    scan.inProgress
  ]);
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
    const slot = roles.find(
      ({ role, files }) => role.matches(file.name) && (role.max === null || files.length < role.max)
    );
    if (slot) slot.files.push(file);
    else extras.push(file);
  }
  const missing = roles.filter(({ role, files }) => files.length < role.min).map(({ role }) => role);
  const busy = [
    ...scan.files.filter((f) => f.busy).map((f) => `${f.rel} (${f.busy})`),
    ...scan.inProgress.map((rel) => `${rel} (download in progress)`)
  ];
  const complete = missing.length === 0;
  const extrasBlock = !config.allowExtraFiles && extras.length > 0;
  return {
    roles,
    extras,
    missing,
    busy,
    complete,
    ready: complete && busy.length === 0 && !extrasBlock,
    blockedByExtras: extrasBlock
  };
}

/** @typedef {ReturnType<typeof evaluate>} Evaluation */

const realClock = {
  now: () => Date.now(),
  sleep: (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

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
 * Poll the watch folder until the media set is complete and unchanged for the
 * settle window, the folder goes idle while incomplete, or the wait times out.
 * Settling is measured from the newest file change, so media that finished
 * copying before the watcher started is handed off without an extra wait.
 * @param {Config} config
 * @param {{ settleMs?: number, log?: (msg: string) => void, clock?: typeof realClock }} [options]
 * @returns {Promise<{ status: 'missing-dir' | 'empty' | 'ready' | 'incomplete' | 'timeout', scan?: Scan, evaluation?: Evaluation }>}
 */
export async function waitUntilReady(config, options = {}) {
  const clock = options.clock ?? realClock;
  const log = options.log ?? (() => {});
  const settleMs = options.settleMs ?? config.settleMs;
  const started = clock.now();
  let lastPrint = '';
  let lastFingerprint = '';
  let changedAt = 0;

  for (;;) {
    const scan = await scanWatchDir(config);
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
    if (summary !== lastPrint) {
      log(summary);
      lastPrint = summary;
    }

    if (evaluation.ready && now - changedAt >= settleMs) return { status: 'ready', scan, evaluation };
    const idle = evaluation.busy.length === 0 && now - changedAt >= config.idleExitMs;
    if (!evaluation.ready && idle) return { status: 'incomplete', scan, evaluation };
    if (now - started >= config.maxWaitMs) return { status: 'timeout', scan, evaluation };
    await clock.sleep(config.pollMs);
  }
}

/** @param {Evaluation} evaluation */
export function describeEvaluation(evaluation) {
  const parts = evaluation.roles.map(
    ({ role, files }) => `${role.id} ${files.length}/${role.min}${files.length >= role.min ? ' ok' : ''}`
  );
  if (evaluation.extras.length) parts.push(`extra ${evaluation.extras.length}`);
  if (evaluation.busy.length) parts.push(`busy: ${evaluation.busy.join(', ')}`);
  if (evaluation.blockedByExtras) parts.push('blocked: unexpected files (allowExtraFiles is false)');
  const state = evaluation.ready ? 'complete, settling' : evaluation.complete ? 'complete, waiting' : 'incomplete';
  return `${state} — ${parts.join('; ')}`;
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** @param {number} seconds */
export function formatDuration(seconds) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/**
 * Locate an executable by absolute path, PATH, or common install dirs (launchd
 * starts jobs with a minimal PATH).
 * @param {string} bin
 */
export function resolveBin(bin, env = process.env, home = os.homedir()) {
  const expanded = expandHome(bin, home);
  if (expanded.includes('/')) return fs.existsSync(expanded) ? path.resolve(expanded) : null;
  const dirs = [
    ...(env.PATH ?? '').split(':'),
    path.join(home, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin'
  ].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, expanded);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

/** Fixed PATH for the LaunchAgent, independent of whatever shell installs it. */
export function launchdPath(home = os.homedir()) {
  return [path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
}

/** PATH for child processes, including Homebrew and ~/.local/bin for launchd runs. */
export function childPath(env = process.env, home = os.homedir()) {
  const parts = [path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', ...(env.PATH ?? '').split(':'), '/usr/bin', '/bin'];
  return [...new Set(parts.filter(Boolean))].join(':');
}

/**
 * Best-effort media probe; returns null when ffprobe is unavailable or fails.
 * @param {string} file
 * @param {Config} config
 */
export function probeMedia(file, config) {
  if (!config.probe) return null;
  const bin = resolveBin(config.ffprobeBin);
  if (!bin) return null;
  const result = spawnSync(
    bin,
    ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,sample_rate,channels,width,height', '-of', 'json', file],
    { encoding: 'utf8', timeout: 30_000 }
  );
  if (result.status !== 0) return null;
  try {
    const data = JSON.parse(result.stdout);
    const duration = Number.parseFloat(data.format?.duration);
    return {
      durationSeconds: Number.isFinite(duration) ? duration : null,
      streams: (data.streams ?? []).map((/** @type {Record<string, any>} */ s) =>
        [s.codec_type, s.codec_name, s.sample_rate && `${s.sample_rate} Hz`, s.channels && `${s.channels}ch`, s.width && `${s.width}x${s.height}`]
          .filter(Boolean)
          .join(' ')
      )
    };
  } catch {
    return null;
  }
}

/** @param {Date} date */
export function batchIdFor(date) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** @param {string} from @param {string} to */
async function moveEntry(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EXDEV') throw error;
    await fsp.cp(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

/**
 * Move the settled media out of upnext into a fresh project folder and write the
 * manifest. Moving (not copying) frees upnext for the next episode and makes the
 * hand-off idempotent: the watcher can never claim the same media twice.
 * @param {Scan} scan
 * @param {Evaluation} evaluation
 * @param {Config} config
 * @param {Date} [now]
 */
export async function claimBatch(scan, evaluation, config, now = new Date()) {
  const baseId = batchIdFor(now);
  let batchId = baseId;
  let projectDir = path.join(config.projectsDir, batchId);
  for (let n = 2; fs.existsSync(projectDir); n += 1) {
    batchId = `${baseId}-${n}`;
    projectDir = path.join(config.projectsDir, batchId);
  }
  const mediaDir = path.join(projectDir, 'media');
  const outputDir = path.join(projectDir, 'edit');
  await fsp.mkdir(mediaDir, { recursive: true });
  await fsp.mkdir(outputDir, { recursive: true });

  for (const name of scan.topLevel) {
    await moveEntry(path.join(config.watchDir, name), path.join(mediaDir, name));
  }

  const describe = (/** @type {MediaFile} */ file) => {
    const absolute = path.join(mediaDir, file.rel);
    return { path: path.join('media', file.rel), size: file.size, probe: probeMedia(absolute, config) };
  };
  const manifest = {
    version: 1,
    batchId,
    claimedAt: now.toISOString(),
    watchDir: config.watchDir,
    projectDir,
    mediaDir,
    outputDir,
    roles: evaluation.roles.map(({ role, files }) => ({
      id: role.id,
      label: role.label,
      files: files.map(describe)
    })),
    extras: evaluation.extras.map(describe),
    runs: /** @type {Record<string, any>[]} */ ([])
  };
  await writeManifest(projectDir, manifest);
  return manifest;
}

/** @typedef {Awaited<ReturnType<typeof claimBatch>>} Manifest */

/** @param {string} projectDir @param {Manifest} manifest */
export async function writeManifest(projectDir, manifest) {
  const target = path.join(projectDir, MANIFEST_NAME);
  const temp = `${target}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  await fsp.rename(temp, target);
}

/** @param {string} projectDir */
export async function readManifest(projectDir) {
  return /** @type {Manifest} */ (JSON.parse(await fsp.readFile(path.join(projectDir, MANIFEST_NAME), 'utf8')));
}

/** @param {Manifest} manifest */
export function mediaList(manifest) {
  const line = (/** @type {string} */ label, /** @type {{ path: string, size: number, probe: any }} */ file) => {
    const details = [formatBytes(file.size)];
    if (file.probe?.durationSeconds) details.push(formatDuration(file.probe.durationSeconds));
    if (file.probe?.streams?.length) details.push(file.probe.streams.join(' + '));
    return `- ${label}: ${file.path} (${details.join(', ')})`;
  };
  return [
    ...manifest.roles.flatMap((role) => role.files.map((file) => line(role.label, file))),
    ...manifest.extras.map((file) => line('Additional file', file))
  ].join('\n');
}

/**
 * Fill `{{name}}` placeholders; unknown placeholders are an error so template
 * typos fail loudly instead of reaching Claude.
 * @param {string} template
 * @param {Record<string, string>} values
 */
export function renderTemplate(template, values) {
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Unknown prompt placeholder {{${key}}}`);
    return values[key];
  });
}

/** @param {Manifest} manifest @param {Config} config */
export async function renderPrompt(manifest, config) {
  const template = await fsp.readFile(config.claude.promptTemplate, 'utf8');
  return renderTemplate(template, {
    batchId: manifest.batchId,
    projectDir: manifest.projectDir,
    mediaDir: manifest.mediaDir,
    outputDir: manifest.outputDir,
    manifestPath: path.join(manifest.projectDir, MANIFEST_NAME),
    mediaList: mediaList(manifest)
  });
}

/** @param {Config} config @param {{ batchId: string, settingsPath: string }} context */
export function buildClaudeArgs(config, context) {
  const c = config.claude;
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    c.permissionMode,
    '--permission-prompts',
    'none',
    '--settings',
    context.settingsPath,
    '--name',
    `phases upnext ${context.batchId}`
  ];
  if (c.model) args.push('--model', c.model);
  if (c.effort) args.push('--effort', c.effort);
  if (c.maxBudgetUsd) args.push('--max-budget-usd', String(c.maxBudgetUsd));
  args.push(...c.extraArgs);
  return args;
}

/**
 * Pull the final result event out of a stream-json log.
 * @param {string} log
 */
export function parseResult(log) {
  const lines = log.trim().split('\n').reverse();
  for (const line of lines) {
    if (!line.includes('"type":"result"') && !line.includes('"type": "result"')) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'result') return event;
    } catch {}
  }
  return null;
}

/**
 * Run Claude Code headlessly inside the project folder. The prompt goes over
 * stdin; tool permissions go through `--settings` (flag settings), because a
 * brand-new project folder is untrusted and Claude Code ignores permission
 * rules from an untrusted folder's .claude/settings.json.
 * @typedef {{ run: number, startedAt: string, finishedAt: string, status: 'succeeded' | 'failed', exitCode: number | null, error: string | null, sessionId: string | null, costUsd: number | null, numTurns: number | null, summary: string | null, log: string | null, stderr: string | null }} ClaudeRun
 * @param {Manifest} manifest
 * @param {Config} config
 * @param {{ log?: (msg: string) => void }} [options]
 * @returns {Promise<ClaudeRun>}
 */
export async function runClaude(manifest, config, options = {}) {
  const log = options.log ?? (() => {});
  const projectDir = manifest.projectDir;
  const runNumber = manifest.runs.length + 1;
  const bin = resolveBin(config.claude.bin);
  const startedAt = new Date().toISOString();
  if (!bin) {
    /** @type {ClaudeRun} */
    const run = {
      run: runNumber,
      startedAt,
      finishedAt: startedAt,
      status: 'failed',
      exitCode: null,
      error: `Claude Code binary "${config.claude.bin}" not found`,
      sessionId: null,
      costUsd: null,
      numTurns: null,
      summary: null,
      log: null,
      stderr: null
    };
    manifest.runs.push(run);
    await writeManifest(projectDir, manifest);
    return run;
  }

  const prompt = await renderPrompt(manifest, config);
  await fsp.writeFile(path.join(projectDir, 'prompt.md'), prompt);
  const settingsPath = path.join(projectDir, 'claude-settings.json');
  const settings = { permissions: { allow: config.claude.allowedTools, defaultMode: config.claude.permissionMode } };
  await fsp.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  const logName = `claude-run-${runNumber}.jsonl`;
  const errName = `claude-run-${runNumber}.stderr.log`;
  const out = fs.openSync(path.join(projectDir, logName), 'w');
  const err = fs.openSync(path.join(projectDir, errName), 'w');
  const args = buildClaudeArgs(config, { batchId: manifest.batchId, settingsPath });
  log(`starting Claude Code (run ${runNumber}) in ${projectDir}; follow with: tail -f "${path.join(projectDir, logName)}"`);

  /** @type {number} */
  const exitCode = await new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: projectDir,
      stdio: ['pipe', out, err],
      env: { ...process.env, PATH: childPath() }
    });
    child.on('error', (error) => {
      fs.writeSync(err, `${error.stack ?? error}\n`);
      resolve(127);
    });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    child.stdin?.on('error', () => {});
    child.stdin?.end(prompt);
  });
  fs.closeSync(out);
  fs.closeSync(err);

  const result = parseResult(await fsp.readFile(path.join(projectDir, logName), 'utf8'));
  const succeeded = exitCode === 0 && result !== null && !result.is_error;
  /** @type {ClaudeRun} */
  const run = {
    run: runNumber,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: succeeded ? 'succeeded' : 'failed',
    exitCode,
    error: succeeded ? null : result?.is_error ? 'Claude Code reported an error' : `exit ${exitCode}`,
    sessionId: result?.session_id ?? null,
    costUsd: result?.total_cost_usd ?? null,
    numTurns: result?.num_turns ?? null,
    summary: typeof result?.result === 'string' ? result.result.slice(0, 2000) : null,
    log: logName,
    stderr: errName
  };
  manifest.runs.push(run);
  await writeManifest(projectDir, manifest);
  return run;
}

/**
 * Exclusive lock (pid file created with O_EXCL); stale locks from dead
 * processes are reclaimed.
 * @param {string} lockPath
 * @returns {(() => void) | null}
 */
export function acquireLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => fs.rmSync(lockPath, { force: true });
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
      const pid = Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
      if (pid && pid !== process.pid && isAlive(pid)) return null;
      fs.rmSync(lockPath, { force: true });
    }
  }
  return null;
}

/** @param {number} pid */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/** @param {string} title @param {string} message @param {Config} config */
export function notify(title, message, config) {
  if (!config.notify || process.platform !== 'darwin') return;
  const quote = (/** @type {string} */ s) => `"${s.replace(/[\\"]/g, '\\$&')}"`;
  const child = spawn('osascript', ['-e', `display notification ${quote(message)} with title ${quote(title)}`], {
    stdio: 'ignore',
    detached: true
  });
  child.on('error', () => {});
  child.unref();
}

/** @param {string} value */
function xmlEscape(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * LaunchAgent that runs `check` whenever upnext changes (WatchPaths), plus a
 * cheap periodic safety-net check. No process stays resident between events.
 * @param {{ nodePath: string, scriptPath: string, configPath: string, watchDir: string, logPath: string, pathEnv: string, startIntervalSeconds?: number, label?: string }} options
 */
export function launchdPlist(options) {
  const args = [options.nodePath, options.scriptPath, 'check', '--config', options.configPath];
  const strings = (/** @type {string[]} */ values) => values.map((v) => `    <string>${xmlEscape(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(options.label ?? LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${strings(args)}
  </array>
  <key>WatchPaths</key>
  <array>
${strings([options.watchDir])}
  </array>
  <key>StartInterval</key>
  <integer>${options.startIntervalSeconds ?? 900}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(options.pathEnv)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(options.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(options.logPath)}</string>
</dict>
</plist>
`;
}
