// macOS plumbing: finding binaries under launchd's minimal PATH, the run lock,
// notifications, and the LaunchAgent plist.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome } from './config.mjs';

export const LAUNCHD_LABEL = 'fm.phases.upnext';

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string }} ExecResult
 * @typedef {(command: string, args: string[]) => ExecResult} Exec
 */

/** @type {Exec} */
export function exec(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: childPath() } });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? String(result.error ?? '') };
}

/**
 * Locate an executable by absolute path, PATH, or common install dirs.
 * @param {string} bin
 */
export function resolveBin(bin, env = process.env, home = os.homedir()) {
  const expanded = expandHome(bin, home);
  if (expanded.includes('/')) return fs.existsSync(expanded) ? path.resolve(expanded) : null;
  const dirs = [...(env.PATH ?? '').split(':'), path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  for (const dir of dirs.filter(Boolean)) {
    const candidate = path.join(dir, expanded);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

/** PATH for child processes, including Homebrew and ~/.local/bin for launchd runs. */
export function childPath(env = process.env, home = os.homedir()) {
  const parts = [...(env.PATH ?? '').split(':'), path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set(parts.filter(Boolean))].join(':');
}

/** Fixed PATH for the LaunchAgent, independent of whatever shell installs it. */
export function launchdPath(home = os.homedir()) {
  return [path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
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
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
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

/** @param {string} title @param {string} message @param {{ notify: boolean }} config */
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
 * LaunchAgent that runs `check` whenever the inbox changes (WatchPaths), plus a
 * cheap periodic safety-net check. No process stays resident between events.
 * @param {{ nodePath: string, scriptPath: string, configPath: string, inboxDir: string, logPath: string, pathEnv: string, startIntervalSeconds?: number, label?: string }} options
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
${strings([options.inboxDir])}
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
