// Start the edit: open DaVinci Resolve if needed, then run Claude Code from the
// Phases folder so its CLAUDE.md, project skills, and permission rules apply.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isInside } from './config.mjs';
import { STATE_DIR_NAME, manifestPath, mediaList, writeManifest } from './episodes.mjs';
import { describeResolve, ensureResolve } from './resolve.mjs';
import { childPath, resolveBin } from './system.mjs';

/**
 * @typedef {import('./config.mjs').Config} Config
 * @typedef {import('./episodes.mjs').Manifest} Manifest
 * @typedef {import('./resolve.mjs').ResolveState} ResolveState
 * @typedef {{
 *   run: number, startedAt: string, finishedAt: string, status: 'succeeded' | 'failed',
 *   resolve: ResolveState['status'], exitCode: number | null, error: string | null,
 *   sessionId: string | null, costUsd: number | null, numTurns: number | null,
 *   summary: string | null, log: string | null, stderr: string | null
 * }} EditRun
 */

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

/**
 * The prompt Claude receives. With `claude.skill` set, it starts with
 * `/<skill>` so that exact skill runs; otherwise Claude picks the Phases
 * folder's editing skill from its description.
 * @param {Manifest} manifest
 * @param {Config} config
 * @param {ResolveState} resolveState
 */
export async function renderPrompt(manifest, config, resolveState) {
  const template = await fsp.readFile(config.claude.promptTemplate, 'utf8');
  const skill = config.claude.skill;
  const body = renderTemplate(template, {
    episodeName: manifest.episodeName,
    episodeDir: manifest.episodeDir,
    mediaList: mediaList(manifest),
    manifestPath: manifestPath(manifest.episodeDir),
    resolveStatus: describeResolve(resolveState, config),
    skill: skill ? `the ${skill} skill` : "this folder's episode editing skill"
  }).trim();
  return skill ? `/${skill} ${body}\n` : `${body}\n`;
}

/** @param {Config} config @param {{ episodeName: string, episodeDir: string, settingsPath: string | null }} context */
export function buildClaudeArgs(config, context) {
  const c = config.claude;
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none', '--name', `phases ${context.episodeName}`];
  if (c.permissionMode) args.push('--permission-mode', c.permissionMode);
  if (context.settingsPath) args.push('--settings', context.settingsPath);
  if (!isInside(config.phasesDir, context.episodeDir)) args.push('--add-dir', context.episodeDir);
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
  for (const line of log.trim().split('\n').reverse()) {
    if (!line.includes('"result"')) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'result') return event;
    } catch {}
  }
  return null;
}

/**
 * @param {Manifest} manifest
 * @param {Partial<EditRun> & { status: EditRun['status'], resolve: EditRun['resolve'], startedAt: string }} fields
 * @returns {Promise<EditRun>}
 */
async function recordRun(manifest, fields) {
  /** @type {EditRun} */
  const run = {
    run: manifest.runs.length + 1,
    finishedAt: new Date().toISOString(),
    exitCode: null,
    error: null,
    sessionId: null,
    costUsd: null,
    numTurns: null,
    summary: null,
    log: null,
    stderr: null,
    ...fields
  };
  manifest.runs.push(run);
  await writeManifest(manifest);
  return run;
}

/**
 * Open Resolve if needed, then run Claude Code headlessly from the Phases
 * folder. Nothing waits on a person: anything the folder's permission rules do
 * not allow is denied (`--permission-prompts none`).
 * @param {Manifest} manifest
 * @param {Config} config
 * @param {{ log?: (msg: string) => void, resolveDeps?: Parameters<typeof ensureResolve>[1] }} [options]
 * @returns {Promise<EditRun>}
 */
export async function startEdit(manifest, config, options = {}) {
  const log = options.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const resolveState = await ensureResolve(config, { log, ...options.resolveDeps });
  if (resolveState.status === 'failed') {
    log(describeResolve(resolveState, config));
    if (config.resolve.required) {
      return recordRun(manifest, { status: 'failed', resolve: resolveState.status, startedAt, error: resolveState.error ?? 'Resolve failed to open' });
    }
  }

  const bin = resolveBin(config.claude.bin);
  if (!bin) {
    return recordRun(manifest, { status: 'failed', resolve: resolveState.status, startedAt, error: `Claude Code binary "${config.claude.bin}" not found` });
  }

  const runNumber = manifest.runs.length + 1;
  const stateDir = path.join(manifest.episodeDir, STATE_DIR_NAME);
  await fsp.mkdir(stateDir, { recursive: true });
  const prompt = await renderPrompt(manifest, config, resolveState);
  await fsp.writeFile(path.join(stateDir, `prompt-run-${runNumber}.md`), prompt);

  let settingsPath = null;
  if (config.claude.allowedTools.length) {
    // Extra allow rules go through --settings: Claude Code ignores a folder's
    // own .claude/settings.json permissions until that folder is trusted.
    settingsPath = path.join(stateDir, 'claude-settings.json');
    await fsp.writeFile(settingsPath, `${JSON.stringify({ permissions: { allow: config.claude.allowedTools } }, null, 2)}\n`);
  }

  const logName = `claude-run-${runNumber}.jsonl`;
  const errName = `claude-run-${runNumber}.stderr.log`;
  const out = fs.openSync(path.join(stateDir, logName), 'w');
  const err = fs.openSync(path.join(stateDir, errName), 'w');
  const args = buildClaudeArgs(config, { episodeName: manifest.episodeName, episodeDir: manifest.episodeDir, settingsPath });
  log(`starting Claude Code (run ${runNumber}) in ${config.phasesDir}; follow with: tail -f "${path.join(stateDir, logName)}"`);

  /** @type {number} */
  const exitCode = await new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: config.phasesDir, stdio: ['pipe', out, err], env: { ...process.env, PATH: childPath() } });
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

  const result = parseResult(await fsp.readFile(path.join(stateDir, logName), 'utf8'));
  const succeeded = exitCode === 0 && result !== null && !result.is_error;
  return recordRun(manifest, {
    status: succeeded ? 'succeeded' : 'failed',
    resolve: resolveState.status,
    startedAt,
    exitCode,
    error: succeeded ? null : result?.is_error ? 'Claude Code reported an error' : `exit ${exitCode}`,
    sessionId: result?.session_id ?? null,
    costUsd: result?.total_cost_usd ?? null,
    numTurns: result?.num_turns ?? null,
    summary: typeof result?.result === 'string' ? result.result.slice(0, 2000) : null,
    log: logName,
    stderr: errName
  });
}
