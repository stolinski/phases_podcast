// Config loading for the Phases inbox watcher. Folder paths are resolved once
// here so the rest of the tool only sees absolute paths.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_CONFIG_PATH = path.join(TOOL_DIR, 'config.json');

const NAME_TOKENS = ['prefix', 'next', 'date'];

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

/** @param {string} parent @param {string} child */
export function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const DEFAULT_RESOLVE = {
  enabled: true,
  required: true,
  appName: 'DaVinci Resolve',
  processName: 'Resolve',
  launchTimeoutSeconds: 120,
  readyDelaySeconds: 20
};

const DEFAULT_CLAUDE = {
  bin: 'claude',
  skill: /** @type {string | null} */ (null),
  promptTemplate: './prompt.md',
  permissionMode: /** @type {string | null} */ ('acceptEdits'),
  allowedTools: /** @type {string[]} */ ([]),
  model: /** @type {string | null} */ (null),
  effort: /** @type {string | null} */ (null),
  maxBudgetUsd: /** @type {number | null} */ (null),
  extraArgs: /** @type {string[]} */ ([])
};

const DEFAULTS = {
  phasesDir: '~/Documents/phases',
  inboxDir: 'upnext',
  episodesDir: 'episodes',
  episodeFolderName: '{prefix}{next}',
  lockPath: '~/Library/Caches/fm.phases.upnext.lock',
  settleSeconds: 30,
  pollSeconds: 5,
  idleExitSeconds: 120,
  maxWaitMinutes: 180,
  allowExtraFiles: true,
  ignore: ['.*', 'Icon\r', '*.icloud'],
  inProgress: ['*.download', '*.crdownload', '*.part', '*.partial', '*.opdownload', '*.tmp'],
  requiredMedia: /** @type {any[]} */ ([]),
  probe: true,
  ffprobeBin: 'ffprobe',
  notify: true,
  resolve: DEFAULT_RESOLVE,
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
  const merged = {
    ...DEFAULTS,
    ...raw,
    resolve: { ...DEFAULT_RESOLVE, ...(raw.resolve ?? {}) },
    claude: { ...DEFAULT_CLAUDE, ...(raw.claude ?? {}) }
  };

  const fromConfig = (/** @type {string} */ p) => path.resolve(baseDir, expandHome(p, home));
  const phasesDir = fromConfig(merged.phasesDir);
  const fromPhases = (/** @type {string} */ p) => path.resolve(phasesDir, expandHome(p, home));
  const inboxDir = fromPhases(merged.inboxDir);
  const episodesDir = fromPhases(merged.episodesDir);
  if (isInside(inboxDir, episodesDir) || isInside(episodesDir, inboxDir)) {
    throw new Error('config.inboxDir and config.episodesDir must be separate folders, neither inside the other');
  }

  const template = String(merged.episodeFolderName ?? '');
  const unknownTokens = [...template.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).filter((t) => !NAME_TOKENS.includes(t));
  if (!template.trim() || template.includes('/') || unknownTokens.length) {
    throw new Error(`config.episodeFolderName must be a folder name using only ${NAME_TOKENS.map((t) => `{${t}}`).join(', ')}`);
  }

  if (!Array.isArray(merged.requiredMedia) || merged.requiredMedia.length === 0) {
    throw new Error('config.requiredMedia must list at least one media role');
  }
  /** @type {Role[]} */
  const roles = merged.requiredMedia.map((role, index) => {
    if (!role || typeof role.id !== 'string' || !role.id) {
      throw new Error(`config.requiredMedia[${index}] needs a string id`);
    }
    const match = role.match ?? [];
    const extensions = (role.extensions ?? []).map((/** @type {string} */ ext) => ext.toLowerCase().replace(/^\./, ''));
    if (match.length === 0 && extensions.length === 0) {
      throw new Error(`config.requiredMedia "${role.id}" needs match globs or extensions`);
    }
    const min = role.min ?? 1;
    if (!Number.isInteger(min) || min < 0) {
      throw new Error(`config.requiredMedia "${role.id}" min must be a non-negative integer`);
    }
    const nameMatches = match.length ? compileGlobs(match) : () => true;
    return {
      id: role.id,
      label: role.label ?? role.id,
      min,
      max: role.max ?? null,
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
  if (claude.skill !== null && !/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(String(claude.skill))) {
    throw new Error('config.claude.skill must be a skill name such as "edit-episode" (no slash or spaces)');
  }

  return {
    configPath: options.configPath ?? null,
    home,
    phasesDir,
    inboxDir,
    episodesDir,
    episodeFolderName: template,
    lockPath: fromConfig(merged.lockPath),
    settleMs: merged.settleSeconds * 1000,
    pollMs: Math.max(250, merged.pollSeconds * 1000),
    idleExitMs: merged.idleExitSeconds * 1000,
    maxWaitMs: merged.maxWaitMinutes * 60_000,
    allowExtraFiles: Boolean(merged.allowExtraFiles),
    isIgnored: compileGlobs(merged.ignore),
    isInProgress: compileGlobs(merged.inProgress),
    roles,
    probe: Boolean(merged.probe),
    ffprobeBin: String(merged.ffprobeBin),
    notify: Boolean(merged.notify),
    resolve: {
      enabled: Boolean(merged.resolve.enabled),
      required: Boolean(merged.resolve.required),
      appName: String(merged.resolve.appName),
      processName: String(merged.resolve.processName),
      launchTimeoutMs: merged.resolve.launchTimeoutSeconds * 1000,
      readyDelayMs: merged.resolve.readyDelaySeconds * 1000
    },
    claude: {
      bin: String(claude.bin),
      skill: claude.skill === null ? null : String(claude.skill),
      promptTemplate: fromConfig(claude.promptTemplate),
      permissionMode: claude.permissionMode,
      allowedTools: claude.allowedTools,
      model: claude.model,
      effort: claude.effort,
      maxBudgetUsd: claude.maxBudgetUsd,
      extraArgs: claude.extraArgs
    }
  };
}

/** @param {string} [configPath] */
export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const absolute = path.resolve(configPath);
  const raw = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  return normalizeConfig(raw, { baseDir: path.dirname(absolute), configPath: absolute });
}
