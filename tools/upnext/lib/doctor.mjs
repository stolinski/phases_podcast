// Read-only readiness checks, meant to be run on the Mac that does the editing
// before installing the LaunchAgent. Nothing here creates or changes files.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { episodeFolderName, listEpisodeFolders } from './episodes.mjs';
import { describeEvaluation, evaluate, scanInbox } from './inbox.mjs';
import { resolveAppPath, resolveRunning } from './resolve.mjs';
import { LAUNCHD_LABEL, exec as realExec, resolveBin } from './system.mjs';

/**
 * @typedef {import('./config.mjs').Config} Config
 * @typedef {{ level: 'ok' | 'warn' | 'fail' | 'info', label: string, detail: string }} Finding
 * @typedef {{ name: string, description: string, source: string }} SkillInfo
 */

/** @param {string} text */
function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of (match?.[1] ?? '').split(/\r?\n/)) {
    const field = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (field) fields[field[1]] = field[2].replace(/^["'>|]\s*|["']$/g, '').trim();
  }
  return fields;
}

/**
 * Skills and slash commands defined in a `.claude` folder.
 * @param {string} claudeDir
 * @param {string} source
 * @returns {Promise<SkillInfo[]>}
 */
export async function listSkills(claudeDir, source) {
  /** @type {SkillInfo[]} */
  const found = [];
  const skillsDir = path.join(claudeDir, 'skills');
  for (const entry of await fsp.readdir(skillsDir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(skillsDir, entry.name, 'SKILL.md');
    const text = await fsp.readFile(file, 'utf8').catch(() => null);
    if (text === null) continue;
    const fields = frontmatter(text);
    found.push({ name: fields.name || entry.name, description: fields.description ?? '', source });
  }
  const commandsDir = path.join(claudeDir, 'commands');
  for (const entry of await fsp.readdir(commandsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const text = await fsp.readFile(path.join(commandsDir, entry.name), 'utf8').catch(() => '');
    found.push({ name: entry.name.slice(0, -3), description: frontmatter(text).description ?? '', source: `${source} command` });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** @param {string} dir */
async function folderState(dir) {
  try {
    const stat = await fsp.stat(dir);
    if (!stat.isDirectory()) return 'not a folder';
    await fsp.readdir(dir);
    return 'ok';
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ENOENT') return 'missing';
    if (code === 'EPERM' || code === 'EACCES') return 'blocked by macOS privacy controls';
    return String(code);
  }
}

/** @param {string} text @param {number} max */
function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * @param {Config} config
 * @param {{ exec?: import('./system.mjs').Exec, claudeJsonPath?: string, launchAgentPath?: string, userClaudeDir?: string, now?: Date }} [deps]
 * @returns {Promise<Finding[]>}
 */
export async function runDoctor(config, deps = {}) {
  const exec = deps.exec ?? realExec;
  const home = config.home ?? os.homedir();
  /** @type {Finding[]} */
  const findings = [];
  const add = (/** @type {Finding['level']} */ level, /** @type {string} */ label, /** @type {string} */ detail) =>
    findings.push({ level, label, detail });

  const phasesState = await folderState(config.phasesDir);
  add(phasesState === 'ok' ? 'ok' : 'fail', 'Phases folder', `${config.phasesDir} (${phasesState})`);
  if (phasesState === 'blocked by macOS privacy controls') {
    add('info', 'Privacy access', `give ${process.execPath} access to the Documents folder in System Settings > Privacy & Security`);
  }
  const subfolders = phasesState === 'ok'
    ? (await fsp.readdir(config.phasesDir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
    : [];
  const hint = subfolders.length ? `; folders in the Phases folder: ${subfolders.join(', ')}` : '';

  const inboxState = await folderState(config.inboxDir);
  add(inboxState === 'ok' ? 'ok' : 'fail', 'Inbox', `${config.inboxDir} (${inboxState})${inboxState === 'ok' ? '' : hint}`);

  const episodesState = await folderState(config.episodesDir);
  add(episodesState === 'ok' ? 'ok' : 'fail', 'Episodes folder', `${config.episodesDir} (${episodesState})${episodesState === 'ok' ? '' : hint}`);
  if (episodesState === 'ok') {
    const existing = await listEpisodeFolders(config);
    const nextName = episodeFolderName(config.episodeFolderName, existing, deps.now ?? new Date());
    const recent = existing.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(-3);
    add('info', 'Episode folders', `${existing.length} found${recent.length ? `, latest: ${recent.join(' | ')}` : ''}`);
    add('info', 'Next episode folder', `loose files would go into "${nextName}"; a single dropped folder keeps its own name`);
  }

  const projectSkills = phasesState === 'ok' ? await listSkills(path.join(config.phasesDir, '.claude'), 'Phases folder') : [];
  const userSkills = await listSkills(deps.userClaudeDir ?? path.join(home, '.claude'), 'user');
  add(projectSkills.length ? 'ok' : 'warn', 'Phases folder skills', projectSkills.length
    ? projectSkills.map((s) => `${s.name}${s.description ? ` (${clip(s.description, 80)})` : ''}`).join('; ')
    : 'no skills or commands found in the Phases folder .claude directory');
  const hasClaudeMd = fs.existsSync(path.join(config.phasesDir, 'CLAUDE.md')) || fs.existsSync(path.join(config.phasesDir, '.claude', 'CLAUDE.md'));
  add(hasClaudeMd ? 'ok' : 'info', 'Phases CLAUDE.md', hasClaudeMd ? 'present' : 'none (optional)');
  if (config.claude.skill) {
    const match = [...projectSkills, ...userSkills].find((s) => s.name === config.claude.skill);
    add(match ? 'ok' : 'warn', 'Edit skill', match
      ? `${config.claude.skill} (${match.source})`
      : `${config.claude.skill} not found in the Phases folder or user skills; fine only if a plugin provides it`);
  } else {
    add('warn', 'Edit skill', 'claude.skill is not set; Claude will choose the editing skill itself. Set it to one of the skills above for a predictable hand-off');
  }

  const claudeBin = resolveBin(config.claude.bin);
  const version = claudeBin ? exec(claudeBin, ['--version']).stdout.trim() : '';
  add(claudeBin ? 'ok' : 'fail', 'Claude Code', claudeBin ? `${claudeBin}${version ? ` (${version})` : ''}` : `"${config.claude.bin}" not found`);

  const claudeJson = await fsp.readFile(deps.claudeJsonPath ?? path.join(home, '.claude.json'), 'utf8').then(JSON.parse).catch(() => null);
  const realPhases = await fsp.realpath(config.phasesDir).catch(() => config.phasesDir);
  const projects = claudeJson?.projects ?? {};
  const trusted = Boolean(projects[config.phasesDir]?.hasTrustDialogAccepted || projects[realPhases]?.hasTrustDialogAccepted);
  add(trusted ? 'ok' : 'warn', 'Folder trust', trusted
    ? 'Claude Code trusts the Phases folder, so its permission rules apply to unattended edits'
    : 'open Claude Code in the Phases folder once and accept the trust prompt; until then its permission rules are ignored in unattended runs');

  if (config.resolve.enabled) {
    const appPath = resolveAppPath(config, exec, home);
    add(appPath ? 'ok' : config.resolve.required ? 'fail' : 'warn', config.resolve.appName, appPath
      ? `installed${resolveRunning(config, exec) ? ', running' : ', not running (it will be opened when an edit starts)'}`
      : 'not found');
  } else {
    add('info', config.resolve.appName, 'not managed (resolve.enabled is false)');
  }

  add(resolveBin(config.ffprobeBin) ? 'ok' : 'info', 'ffprobe', resolveBin(config.ffprobeBin) ? 'found (media details go into the hand-off)' : 'not found (optional)');
  add('info', 'Complete set', config.roles.map((role) => `${role.label} x${role.min}`).join(', '));

  if (inboxState === 'ok') {
    const scan = await scanInbox(config);
    add('info', 'Inbox now', scan.topLevel.length ? describeEvaluation(evaluate(scan, config)) : 'empty');
  }

  const agentPath = deps.launchAgentPath ?? path.join(home, 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  add('info', 'LaunchAgent', fs.existsSync(agentPath) ? 'installed' : 'not installed');
  return findings;
}

/** @param {Finding[]} findings */
export function formatFindings(findings) {
  const icon = { ok: '✓', warn: '!', fail: '✗', info: '·' };
  return findings.map((f) => `${icon[f.level]} ${f.label}: ${f.detail}`).join('\n');
}
