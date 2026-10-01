// Move a settled inbox set into the normal episodes folder and record what was
// handed off. The watcher never creates the Phases or episodes folders; they
// must already exist.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { formatBytes, formatDuration, resolveBin } from './system.mjs';

export const STATE_DIR_NAME = '.upnext';
export const MANIFEST_NAME = 'upnext.json';

// Leading episode number, optionally after a word prefix ("Episode 23 - Topic",
// "ep023", "23"). Date-like names such as "2026-10-01" do not count.
const NUMBERED_FOLDER = /^(\D*?)(\d{1,3})(?!\d)/;

/**
 * @typedef {import('./config.mjs').Config} Config
 * @typedef {import('./inbox.mjs').Scan} Scan
 * @typedef {import('./inbox.mjs').Evaluation} Evaluation
 * @typedef {import('./inbox.mjs').MediaFile} MediaFile
 * @typedef {{ path: string, size: number, probe: { durationSeconds: number | null, streams: string[] } | null }} ManifestFile
 * @typedef {{
 *   version: number, episodeName: string, episodeDir: string, claimedAt: string, inboxDir: string,
 *   roles: { id: string, label: string, files: ManifestFile[] }[], extras: ManifestFile[],
 *   runs: import('./claude.mjs').EditRun[]
 * }} Manifest
 */

/** @param {string} name */
function parseEpisodeNumber(name) {
  const match = NUMBERED_FOLDER.exec(name);
  if (!match) return null;
  return { prefix: match[1], digits: match[2], number: Number.parseInt(match[2], 10) };
}

/** @param {Date} date */
export function localDate(date) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Fill the episode folder template. `{next}` is one more than the highest
 * numbered existing episode folder, keeping its zero padding; `{prefix}` is the
 * text before that folder's number ("Episode ", "ep", or nothing).
 * @param {string} template
 * @param {string[]} existing
 * @param {Date} now
 */
export function episodeFolderName(template, existing, now) {
  let latest = { prefix: '', digits: '0', number: 0 };
  for (const name of existing) {
    const parsed = parseEpisodeNumber(name);
    if (parsed && parsed.number >= latest.number) latest = parsed;
  }
  const width = latest.digits.startsWith('0') && latest.number > 0 ? latest.digits.length : 0;
  const next = String(latest.number + 1).padStart(width, '0');
  return template.replace(/\{(prefix|next|date)\}/g, (_, token) =>
    token === 'prefix' ? latest.prefix : token === 'next' ? next : localDate(now)
  );
}

/** @param {string} name */
function assertFolderName(name) {
  if (!name.trim() || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new Error(`"${name}" is not a usable episode folder name`);
  }
}

/** @param {Config} config */
export async function listEpisodeFolders(config) {
  let entries;
  try {
    entries = await fsp.readdir(config.episodesDir, { withFileTypes: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      throw new Error(`episodes folder ${config.episodesDir} does not exist; set episodesDir in the config to the normal episodes folder`);
    }
    throw error;
  }
  return entries.filter((e) => e.isDirectory() && !config.isIgnored(e.name)).map((e) => e.name);
}

/**
 * Decide which episode folder a settled inbox set goes into. A single folder
 * dropped into the inbox keeps its name; loose files get a folder named from
 * `episodeFolderName`.
 * @param {Scan} scan
 * @param {Config} config
 * @param {Date} [now]
 */
export async function planEpisode(scan, config, now = new Date()) {
  const existing = await listEpisodeFolders(config);
  const droppedFolder = scan.topLevel.length === 1 && scan.topLevelDirs.length === 1;
  const name = droppedFolder ? scan.topLevelDirs[0] : episodeFolderName(config.episodeFolderName, existing, now);
  assertFolderName(name);
  const dir = path.join(config.episodesDir, name);
  return { name, dir, source: droppedFolder ? 'dropped-folder' : 'template', exists: fs.existsSync(dir) };
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
 * Best-effort media probe; null when ffprobe is unavailable or fails.
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

/** @param {string} episodeDir */
export function manifestPath(episodeDir) {
  return path.join(episodeDir, STATE_DIR_NAME, MANIFEST_NAME);
}

/**
 * Move the settled media out of the inbox into the episode folder and write the
 * hand-off manifest. Moving (not copying) empties the inbox for the next
 * episode, so the same set can never be handed off twice. Name collisions in an
 * existing episode folder abort before anything moves.
 * @param {Scan} scan
 * @param {Evaluation} evaluation
 * @param {Config} config
 * @param {Date} [now]
 * @returns {Promise<Manifest>}
 */
export async function claimEpisode(scan, evaluation, config, now = new Date()) {
  const plan = await planEpisode(scan, config, now);
  const droppedDir = plan.source === 'dropped-folder' ? path.join(config.inboxDir, plan.name) : null;

  /** @type {[string, string][]} */
  let moves;
  if (droppedDir && !plan.exists) moves = [[droppedDir, plan.dir]];
  else if (droppedDir) {
    const children = (await fsp.readdir(droppedDir)).filter((name) => !config.isIgnored(name));
    moves = children.map((name) => [path.join(droppedDir, name), path.join(plan.dir, name)]);
  } else moves = scan.topLevel.map((name) => [path.join(config.inboxDir, name), path.join(plan.dir, name)]);

  const collisions = moves.filter(([, to]) => fs.existsSync(to)).map(([, to]) => path.basename(to));
  if (collisions.length) {
    throw new Error(`${plan.dir} already contains ${collisions.join(', ')}; nothing was moved`);
  }

  if (!plan.exists && !droppedDir) await fsp.mkdir(plan.dir);
  for (const [from, to] of moves) await moveEntry(from, to);
  if (droppedDir && plan.exists) {
    const leftovers = await fsp.readdir(droppedDir).catch(() => []);
    if (leftovers.every((name) => config.isIgnored(name))) await fsp.rm(droppedDir, { recursive: true, force: true });
  }

  const prefix = droppedDir ? `${plan.name}${path.sep}` : '';
  /** @returns {ManifestFile} */
  const describe = (/** @type {MediaFile} */ file) => {
    const rel = prefix && file.rel.startsWith(prefix) ? file.rel.slice(prefix.length) : file.rel;
    return { path: rel, size: file.size, probe: probeMedia(path.join(plan.dir, rel), config) };
  };
  const previous = await readManifest(plan.dir).catch(() => null);
  /** @type {Manifest} */
  const manifest = {
    version: 2,
    episodeName: plan.name,
    episodeDir: plan.dir,
    claimedAt: now.toISOString(),
    inboxDir: config.inboxDir,
    roles: evaluation.roles.map(({ role, files }) => ({ id: role.id, label: role.label, files: files.map(describe) })),
    extras: evaluation.extras.map(describe),
    runs: previous?.runs ?? []
  };
  await writeManifest(manifest);
  return manifest;
}

/** @param {Manifest} manifest */
export async function writeManifest(manifest) {
  const target = manifestPath(manifest.episodeDir);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(`${target}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
  await fsp.rename(`${target}.tmp`, target);
}

/** @param {string} episodeDir @returns {Promise<Manifest>} */
export async function readManifest(episodeDir) {
  const manifest = JSON.parse(await fsp.readFile(manifestPath(episodeDir), 'utf8'));
  return { ...manifest, episodeDir };
}

/** @param {Manifest} manifest */
export function mediaList(manifest) {
  const line = (/** @type {string} */ label, /** @type {ManifestFile} */ file) => {
    const details = [formatBytes(file.size)];
    if (file.probe?.durationSeconds) details.push(formatDuration(file.probe.durationSeconds));
    if (file.probe?.streams?.length) details.push(file.probe.streams.join(' + '));
    return `  - ${label}: ${file.path} (${details.join(', ')})`;
  };
  return [
    ...manifest.roles.flatMap((role) => role.files.map((file) => line(role.label, file))),
    ...manifest.extras.map((file) => line('Additional file', file))
  ].join('\n');
}
