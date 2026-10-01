import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { buildClaudeArgs, parseResult, renderPrompt, renderTemplate } from './lib/claude.mjs';
import { DEFAULT_CONFIG_PATH, TOOL_DIR, globToRegExp, loadConfig, normalizeConfig } from './lib/config.mjs';
import { runDoctor } from './lib/doctor.mjs';
import { claimEpisode, episodeFolderName, manifestPath } from './lib/episodes.mjs';
import { busyReason, evaluate, scanInbox, waitUntilReady } from './lib/inbox.mjs';
import { ensureResolve } from './lib/resolve.mjs';
import { acquireLock, launchdPlist } from './lib/system.mjs';

const CLI = path.join(TOOL_DIR, 'upnext.mjs');
const PROMPT = path.join(TOOL_DIR, 'prompt.md');
const FIXED_DATE = new Date(2026, 9, 1, 9, 30);

const ROLES = [
  { id: 'courtney', label: 'Courtney', match: ['*courtney*'], extensions: ['wav', 'mov'], min: 1 },
  { id: 'scott', label: 'Scott', match: ['*scott*'], extensions: ['wav', 'mov'], min: 1 }
];

const SKILL_MD = `---
name: edit-episode
description: Edit a Phases episode in DaVinci Resolve
---
Steps live here.
`;

function tempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phases-upnext-')));
}

/** @param {string} dir @param {Record<string, string>} files */
function writeFiles(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

/** A Phases folder shaped like the real one: inbox, episodes, and a project skill. */
function makePhases() {
  const root = tempDir();
  const phasesDir = path.join(root, 'phases');
  fs.mkdirSync(path.join(phasesDir, 'upnext'), { recursive: true });
  fs.mkdirSync(path.join(phasesDir, 'episodes', 'Episode 23 - Back to school'), { recursive: true });
  fs.mkdirSync(path.join(phasesDir, 'episodes', 'Episode 24 - Sleep'), { recursive: true });
  writeFiles(path.join(phasesDir, '.claude', 'skills', 'edit-episode'), { 'SKILL.md': SKILL_MD });
  return { root, phasesDir, inboxDir: path.join(phasesDir, 'upnext'), episodesDir: path.join(phasesDir, 'episodes') };
}

/** @param {string} root @param {string} phasesDir @param {Record<string, any>} [overrides] */
function rawConfig(root, phasesDir, overrides = {}) {
  return {
    phasesDir,
    lockPath: path.join(root, '.upnext.lock'),
    settleSeconds: 30,
    pollSeconds: 5,
    idleExitSeconds: 120,
    maxWaitMinutes: 10,
    requiredMedia: ROLES,
    probe: false,
    notify: false,
    ...overrides,
    resolve: { enabled: false, ...(overrides.resolve ?? {}) },
    claude: { promptTemplate: PROMPT, ...(overrides.claude ?? {}) }
  };
}

/** @param {number} [start] */
function fakeClock(start = Date.now(), onSleep = (/** @type {number} */ _t) => {}) {
  const clock = {
    t: start,
    now: () => clock.t,
    sleep: async (/** @type {number} */ ms) => {
      clock.t += ms;
      onSleep(clock.t);
    }
  };
  return clock;
}

/** @param {Partial<import('./lib/inbox.mjs').MediaFile>[]} files @param {string[]} [inProgress] */
function scanOf(files, inProgress = []) {
  return {
    exists: true,
    topLevel: files.map((f) => f.rel ?? ''),
    topLevelDirs: [],
    dirChangeMs: 0,
    inProgress,
    files: files.map((f) => ({ rel: f.rel ?? '', name: path.basename(f.rel ?? ''), size: 10, mtimeMs: 1, ctimeMs: 1, busy: null, ...f }))
  };
}

/** @param {Record<string, (args: string[]) => { status: number | null, stdout?: string, stderr?: string }>} handlers */
function fakeExec(handlers) {
  /** @type {string[][]} */
  const calls = [];
  /** @type {import('./lib/system.mjs').Exec} */
  const exec = (command, args) => {
    calls.push([path.basename(command), ...args]);
    const handler = handlers[path.basename(command)];
    const result = handler ? handler(args) : { status: 1 };
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { exec, calls };
}

describe('config', () => {
  test('the shipped config targets the Phases folder in Documents', () => {
    const config = loadConfig(DEFAULT_CONFIG_PATH);
    const phases = path.join(os.homedir(), 'Documents/phases');
    assert.equal(config.phasesDir, phases);
    assert.equal(config.inboxDir, path.join(phases, 'upnext'));
    assert.equal(config.episodesDir, path.join(phases, 'episodes'));
    assert.equal(config.resolve.appName, 'DaVinci Resolve');
    assert.ok(!config.lockPath.startsWith(phases), 'lock file stays out of the Phases folder');
    assert.ok(fs.existsSync(config.claude.promptTemplate));
  });

  test('inbox and episodes resolve inside the Phases folder unless absolute', () => {
    const config = normalizeConfig(rawConfig('/r', '/x/phases', { inboxDir: 'inbox', episodesDir: '/elsewhere/episodes' }));
    assert.equal(config.inboxDir, '/x/phases/inbox');
    assert.equal(config.episodesDir, '/elsewhere/episodes');
  });

  test('rejects unusable settings', () => {
    const base = rawConfig('/r', '/x/phases');
    assert.throws(() => normalizeConfig({ ...base, inboxDir: 'episodes/inbox' }), /separate folders/);
    assert.throws(() => normalizeConfig({ ...base, episodeFolderName: 'Ep {num}' }), /episodeFolderName/);
    assert.throws(() => normalizeConfig({ ...base, episodeFolderName: 'a/{next}' }), /episodeFolderName/);
    assert.throws(() => normalizeConfig({ ...base, claude: { skill: '/edit episode' } }), /skill name/);
    assert.throws(() => normalizeConfig({ ...base, requiredMedia: [] }), /at least one media role/);
    assert.throws(() => normalizeConfig({ ...base, requiredMedia: [{ id: 'x' }] }), /match globs or extensions/);
    assert.throws(() => normalizeConfig({ ...base, requiredMedia: [{ id: 'x', match: ['*'], min: 0 }] }), /min >= 1/);
  });
});

describe('inbox matching', () => {
  test('globs are case-insensitive and support alternatives', () => {
    const re = globToRegExp('*courtney*.{wav,m4a}');
    assert.ok(re.test('Ep24 - Courtney Track.WAV'));
    assert.ok(!re.test('courtney.mov'));
    assert.ok(globToRegExp('.*').test('.DS_Store'));
    assert.ok(!globToRegExp('a.b').test('axb'));
  });

  test('evaluate reports missing, extra, busy, and ready', () => {
    const config = normalizeConfig(rawConfig('/r', '/x/phases'));
    const partial = evaluate(scanOf([{ rel: 'Courtney.wav' }, { rel: 'notes.txt' }]), config);
    assert.deepEqual(partial.missing.map((r) => r.id), ['scott']);
    assert.deepEqual(partial.extras.map((f) => f.rel), ['notes.txt']);
    assert.equal(evaluate(scanOf([{ rel: 'Courtney.wav' }, { rel: 'ep/Scott.mov' }]), config).ready, true);
    const busy = evaluate(scanOf([{ rel: 'Courtney.wav' }, { rel: 'Scott.wav', busy: 'Finder copy in progress' }]), config);
    assert.equal(busy.ready, false);
    assert.equal(evaluate(scanOf([{ rel: 'Courtney.wav' }, { rel: 'Scott.wav' }], ['g.crdownload']), config).ready, false);
    const strict = normalizeConfig({ ...rawConfig('/r', '/x/phases'), allowExtraFiles: false });
    assert.equal(evaluate(scanOf([{ rel: 'Courtney.wav' }, { rel: 'Scott.wav' }, { rel: 'x.txt' }]), strict).blockedByExtras, true);
  });

  test('busyReason flags empty files and Finder copies', () => {
    assert.equal(busyReason({ size: 0, birthtime: new Date() }), 'empty file (still being created)');
    assert.equal(busyReason({ size: 5, birthtime: new Date(1984, 0, 24, 8) }), 'Finder copy in progress');
    assert.equal(busyReason({ size: 5, birthtime: new Date() }), null);
  });
});

describe('settling', () => {
  test('waits the settle window, then reports ready', async () => {
    const { root, phasesDir, inboxDir } = makePhases();
    const config = normalizeConfig(rawConfig(root, phasesDir));
    writeFiles(inboxDir, { 'Courtney.wav': 'a', 'Scott.wav': 'b', '.DS_Store': '' });
    const clock = fakeClock();
    const started = clock.t;
    assert.equal((await waitUntilReady(config, { clock })).status, 'ready');
    assert.ok(clock.t - started >= 25_000);
  });

  test('a change during settling restarts the window', async () => {
    const { root, phasesDir, inboxDir } = makePhases();
    const config = normalizeConfig(rawConfig(root, phasesDir));
    writeFiles(inboxDir, { 'Courtney.wav': 'a', 'Scott.wav': 'b' });
    const start = Date.now();
    let grew = false;
    const clock = fakeClock(start, (t) => {
      if (!grew && t - start >= 20_000) {
        fs.appendFileSync(path.join(inboxDir, 'Scott.wav'), 'more');
        grew = true;
      }
    });
    assert.equal((await waitUntilReady(config, { clock })).status, 'ready');
    assert.ok(clock.t - start >= 50_000);
  });

  test('media that finished copying earlier is ready without waiting', async () => {
    const { root, phasesDir, inboxDir } = makePhases();
    const config = normalizeConfig(rawConfig(root, phasesDir));
    writeFiles(inboxDir, { 'Courtney.wav': 'a', 'Scott.wav': 'b' });
    const clock = fakeClock(Date.now() + 3_600_000);
    const started = clock.t;
    assert.equal((await waitUntilReady(config, { clock })).status, 'ready');
    assert.equal(clock.t, started);
  });

  test('incomplete sets exit when idle; downloads hold until timeout; empty and missing return at once', async () => {
    const { root, phasesDir, inboxDir } = makePhases();
    const config = normalizeConfig(rawConfig(root, phasesDir, { maxWaitMinutes: 1, idleExitSeconds: 30 }));
    assert.equal((await waitUntilReady(config, { clock: fakeClock() })).status, 'empty');
    writeFiles(inboxDir, { 'Courtney.wav': 'a' });
    assert.equal((await waitUntilReady(config, { clock: fakeClock() })).status, 'incomplete');
    writeFiles(inboxDir, { 'Scott.wav': 'b', 'Guest.wav.crdownload': 'c' });
    assert.equal((await waitUntilReady(config, { clock: fakeClock() })).status, 'timeout');
    fs.rmSync(inboxDir, { recursive: true });
    assert.equal((await waitUntilReady(config, { clock: fakeClock() })).status, 'missing-dir');
  });
});

describe('episode folders', () => {
  test('next folder name follows the existing numbering', () => {
    const existing = ['Episode 23 - Back to school', 'Episode 9', 'notes', '2026-09-30'];
    assert.equal(episodeFolderName('{prefix}{next}', existing, FIXED_DATE), 'Episode 24');
    assert.equal(episodeFolderName('{prefix}{next}', ['023 Topic', '024'], FIXED_DATE), '025');
    assert.equal(episodeFolderName('{prefix}{next}', [], FIXED_DATE), '1');
    assert.equal(episodeFolderName('{prefix}{next} {date}', ['ep7'], FIXED_DATE), 'ep8 2026-10-01');
  });

  test('loose files move into a new numbered episode folder', async () => {
    const { root, phasesDir, inboxDir, episodesDir } = makePhases();
    const config = normalizeConfig(rawConfig(root, phasesDir));
    writeFiles(inboxDir, { 'Courtney.wav': 'a', 'Scott.wav': 'b', 'notes.txt': 'n', '.DS_Store': '' });
    const scan = await scanInbox(config);
    const manifest = await claimEpisode(scan, evaluate(scan, config), config, FIXED_DATE);
    assert.equal(manifest.episodeDir, path.join(episodesDir, 'Episode 25'));
    assert.deepEqual(fs.readdirSync(manifest.episodeDir).sort(), ['.upnext', 'Courtney.wav', 'Scott.wav', 'notes.txt']);
    assert.deepEqual(fs.readdirSync(inboxDir), ['.DS_Store']);
    assert.deepEqual(manifest.roles.map((r) => r.files.map((f) => f.path)), [['Courtney.wav'], ['Scott.wav']]);
    assert.ok(fs.existsSync(manifestPath(manifest.episodeDir)));
  });

  test('a dropped folder keeps its name', async () => {
    const { root, phasesDir, inboxDir, episodesDir } = makePhases();
    const config = normalizeConfig(rawConfig(root, phasesDir));
    writeFiles(path.join(inboxDir, 'Episode 25 - Screen time'), { 'Courtney.wav': 'a', 'Scott.wav': 'b' });
    const scan = await scanInbox(config);
    const manifest = await claimEpisode(scan, evaluate(scan, config), config, FIXED_DATE);
    assert.equal(manifest.episodeDir, path.join(episodesDir, 'Episode 25 - Screen time'));
    assert.deepEqual(manifest.roles.map((r) => r.files.map((f) => f.path)), [['Courtney.wav'], ['Scott.wav']]);
    assert.deepEqual(fs.readdirSync(inboxDir), []);
  });

  test('a dropped folder matching an existing episode merges into it', async () => {
    const { root, phasesDir, inboxDir, episodesDir } = makePhases();
    const config = normalizeConfig(rawConfig(root, phasesDir));
    writeFiles(path.join(episodesDir, 'Episode 24 - Sleep'), { 'outline.md': 'o' });
    writeFiles(path.join(inboxDir, 'Episode 24 - Sleep'), { 'Courtney.wav': 'a', 'Scott.wav': 'b', '.DS_Store': '' });
    const scan = await scanInbox(config);
    const manifest = await claimEpisode(scan, evaluate(scan, config), config, FIXED_DATE);
    assert.deepEqual(fs.readdirSync(manifest.episodeDir).sort(), ['.upnext', 'Courtney.wav', 'Scott.wav', 'outline.md']);
    assert.deepEqual(fs.readdirSync(inboxDir), []);
  });

  test('a name collision moves nothing', async () => {
    const { root, phasesDir, inboxDir, episodesDir } = makePhases();
    const config = normalizeConfig(rawConfig(root, phasesDir));
    writeFiles(path.join(episodesDir, 'Episode 24 - Sleep'), { 'Scott.wav': 'old' });
    writeFiles(path.join(inboxDir, 'Episode 24 - Sleep'), { 'Courtney.wav': 'a', 'Scott.wav': 'b' });
    const scan = await scanInbox(config);
    await assert.rejects(claimEpisode(scan, evaluate(scan, config), config), /already contains Scott\.wav; nothing was moved/);
    assert.deepEqual(fs.readdirSync(path.join(inboxDir, 'Episode 24 - Sleep')).sort(), ['Courtney.wav', 'Scott.wav']);
    assert.equal(fs.readFileSync(path.join(episodesDir, 'Episode 24 - Sleep', 'Scott.wav'), 'utf8'), 'old');
  });

  test('a missing episodes folder is never created', async () => {
    const { root, phasesDir, inboxDir, episodesDir } = makePhases();
    fs.rmSync(episodesDir, { recursive: true });
    const config = normalizeConfig(rawConfig(root, phasesDir));
    writeFiles(inboxDir, { 'Courtney.wav': 'a', 'Scott.wav': 'b' });
    const scan = await scanInbox(config);
    await assert.rejects(claimEpisode(scan, evaluate(scan, config), config), /episodes folder .* does not exist/);
    assert.ok(!fs.existsSync(episodesDir));
    assert.equal(fs.readdirSync(inboxDir).length, 2);
  });
});

describe('DaVinci Resolve', () => {
  const config = normalizeConfig(rawConfig('/r', '/x/phases', { resolve: { enabled: true, readyDelaySeconds: 20, launchTimeoutSeconds: 30 } }));

  test('disabled means no process checks at all', async () => {
    const { exec, calls } = fakeExec({});
    const disabled = normalizeConfig(rawConfig('/r', '/x/phases'));
    assert.deepEqual(await ensureResolve(disabled, { exec }), { status: 'skipped' });
    assert.equal(calls.length, 0);
  });

  test('a running Resolve is left alone', async () => {
    const { exec, calls } = fakeExec({ pgrep: () => ({ status: 0 }) });
    assert.equal((await ensureResolve(config, { exec, clock: fakeClock() })).status, 'already-running');
    assert.deepEqual(calls, [['pgrep', '-x', 'Resolve']]);
  });

  test('a closed Resolve is opened, then given time to load', async () => {
    let running = false;
    let checks = 0;
    const { exec, calls } = fakeExec({
      pgrep: () => {
        checks += 1;
        if (checks > 3) running = true;
        return { status: running ? 0 : 1 };
      },
      open: () => ({ status: 0 })
    });
    const clock = fakeClock();
    const started = clock.t;
    assert.equal((await ensureResolve(config, { exec, clock })).status, 'launched');
    assert.deepEqual(calls.filter((c) => c[0] === 'open'), [['open', '-a', 'DaVinci Resolve']]);
    assert.ok(clock.t - started >= 20_000, 'waits the ready delay');
  });

  test('open failures and slow launches are reported', async () => {
    const failing = fakeExec({ pgrep: () => ({ status: 1 }), open: () => ({ status: 1, stderr: 'Unable to find application' }) });
    const failed = await ensureResolve(config, { exec: failing.exec, clock: fakeClock() });
    assert.equal(failed.status, 'failed');
    assert.match(failed.error ?? '', /Unable to find application/);
    const slow = fakeExec({ pgrep: () => ({ status: 1 }), open: () => ({ status: 0 }) });
    const timedOut = await ensureResolve(config, { exec: slow.exec, clock: fakeClock() });
    assert.match(timedOut.error ?? '', /did not start within 30s/);
  });
});

describe('Claude hand-off', () => {
  const manifest = {
    version: 2,
    episodeName: 'Episode 25',
    episodeDir: '/x/phases/episodes/Episode 25',
    claimedAt: '',
    inboxDir: '/x/phases/upnext',
    roles: [{ id: 'courtney', label: 'Courtney', files: [{ path: 'Courtney.wav', size: 2048, probe: null }] }],
    extras: [],
    runs: []
  };

  test('prompt invokes the configured skill and names the episode and Resolve state', async () => {
    const withSkill = normalizeConfig(rawConfig('/r', '/x/phases', { claude: { skill: 'edit-episode' } }));
    const prompt = await renderPrompt(manifest, withSkill, { status: 'launched' });
    assert.ok(prompt.startsWith('/edit-episode '));
    assert.match(prompt, /Episode folder: \/x\/phases\/episodes\/Episode 25/);
    assert.match(prompt, /Courtney: Courtney\.wav \(2\.0 KB\)/);
    assert.match(prompt, /DaVinci Resolve was opened for this edit/);
    assert.ok(!prompt.includes('{{'));

    const noSkill = normalizeConfig(rawConfig('/r', '/x/phases'));
    const generic = await renderPrompt(manifest, noSkill, { status: 'already-running' });
    assert.ok(!generic.startsWith('/'));
    assert.match(generic, /this folder's episode editing skill/);
    assert.throws(() => renderTemplate('{{nope}}', {}), /Unknown prompt placeholder/);
  });

  test('arguments never wait on a person and only add flags that are configured', () => {
    const config = normalizeConfig(rawConfig('/r', '/x/phases'));
    const args = buildClaudeArgs(config, { episodeName: 'Episode 25', episodeDir: '/x/phases/episodes/Episode 25', settingsPath: null });
    assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
    assert.ok(!args.includes('--settings'));
    assert.ok(!args.includes('--add-dir'));
    const outside = buildClaudeArgs(config, { episodeName: 'E', episodeDir: '/elsewhere/E', settingsPath: '/s.json' });
    assert.equal(outside[outside.indexOf('--add-dir') + 1], '/elsewhere/E');
    assert.equal(outside[outside.indexOf('--settings') + 1], '/s.json');
  });

  test('parseResult finds the final stream-json result', () => {
    const log = ['{"type":"system"}', '{"type":"result","is_error":false,"session_id":"s1"}', ''].join('\n');
    assert.equal(parseResult(log)?.session_id, 's1');
    assert.equal(parseResult('{"type":"assistant"}'), null);
  });
});

describe('doctor', () => {
  test('reports folders, the next episode, skills, trust, and Resolve', async () => {
    const { root, phasesDir } = makePhases();
    const claudeJsonPath = path.join(root, 'claude.json');
    fs.writeFileSync(claudeJsonPath, JSON.stringify({ projects: { [phasesDir]: { hasTrustDialogAccepted: true } } }));
    const config = normalizeConfig(rawConfig(root, phasesDir, { resolve: { enabled: true }, claude: { skill: 'edit-episode', bin: process.execPath } }));
    const { exec } = fakeExec({
      mdfind: () => ({ status: 0, stdout: '/Applications/DaVinci Resolve/DaVinci Resolve.app\n' }),
      pgrep: () => ({ status: 1 }),
      [path.basename(process.execPath)]: () => ({ status: 0, stdout: 'v1' })
    });
    const findings = await runDoctor(config, { exec, claudeJsonPath, userClaudeDir: path.join(root, 'none'), launchAgentPath: path.join(root, 'none.plist'), now: FIXED_DATE });
    const byLabel = Object.fromEntries(findings.map((f) => [f.label, f]));
    for (const label of ['Phases folder', 'Inbox', 'Episodes folder', 'Phases folder skills', 'Edit skill', 'Claude Code', 'Folder trust', 'DaVinci Resolve']) {
      assert.equal(byLabel[label]?.level, 'ok', `${label}: ${byLabel[label]?.detail}`);
    }
    assert.match(byLabel['Next episode folder'].detail, /"Episode 25"/);
    assert.match(byLabel['Phases folder skills'].detail, /edit-episode \(Edit a Phases episode in DaVinci Resolve\)/);
    assert.match(byLabel['DaVinci Resolve'].detail, /not running/);
  });

  test('fails on a missing inbox and lists the folders that do exist', async () => {
    const { root, phasesDir } = makePhases();
    const config = normalizeConfig(rawConfig(root, phasesDir, { inboxDir: 'inbox', claude: { bin: '/nonexistent/claude' } }));
    const findings = await runDoctor(config, { exec: fakeExec({}).exec, claudeJsonPath: path.join(root, 'none.json'), userClaudeDir: path.join(root, 'none') });
    const byLabel = Object.fromEntries(findings.map((f) => [f.label, f]));
    assert.equal(byLabel.Inbox.level, 'fail');
    assert.match(byLabel.Inbox.detail, /folders in the Phases folder: episodes, upnext/);
    assert.equal(byLabel['Claude Code'].level, 'fail');
    assert.equal(byLabel['Edit skill'].level, 'warn');
    assert.equal(byLabel['Folder trust'].level, 'warn');
  });
});

describe('helpers', () => {
  test('lock is exclusive and stale locks are reclaimed', () => {
    const lockPath = path.join(tempDir(), 'nested', '.lock');
    assert.ok(acquireLock(lockPath));
    fs.writeFileSync(lockPath, String(process.ppid));
    assert.equal(acquireLock(lockPath), null);
    fs.writeFileSync(lockPath, '999999');
    const again = acquireLock(lockPath);
    assert.ok(again);
    again();
    assert.ok(!fs.existsSync(lockPath));
  });

  test('launchd plist watches the inbox and escapes XML', () => {
    const xml = launchdPlist({
      nodePath: '/opt/homebrew/bin/node',
      scriptPath: '/x/upnext.mjs',
      configPath: '/x/a&b.json',
      inboxDir: '/Users/me/Documents/phases/upnext',
      logPath: '/tmp/log',
      pathEnv: '/usr/bin:/bin'
    });
    assert.match(xml, /<key>WatchPaths<\/key>\s*<array>\s*<string>\/Users\/me\/Documents\/phases\/upnext<\/string>/);
    assert.match(xml, /a&amp;b\.json/);
    assert.match(xml, /<string>check<\/string>/);
  });
});

describe('cli end to end (fake Claude Code and Resolve)', () => {
  /**
   * Fake `claude`, `open`, `pgrep`, and `mdfind` on PATH, recording what they were asked to do.
   * @param {string} root
   */
  function fakeTools(root) {
    const bin = path.join(root, 'bin');
    const out = path.join(root, 'out');
    fs.mkdirSync(bin);
    fs.mkdirSync(out);
    const script = (/** @type {string} */ name, /** @type {string} */ body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    script('pgrep', `[ -f "${out}/resolve-running" ]`);
    script('open', `echo "$@" >> "${out}/open.log"\n[ -f "${out}/open-fails" ] && exit 1\ntouch "${out}/resolve-running"`);
    script('mdfind', 'echo "/Applications/DaVinci Resolve/DaVinci Resolve.app"');
    script(
      'claude',
      `if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
pwd -P > "${out}/claude-cwd.txt"
printf '%s\\n' "$@" > "${out}/claude-args.txt"
cat > "${out}/claude-stdin.txt"
[ -f "${out}/resolve-running" ] && echo yes > "${out}/resolve-was-running.txt"
echo '{"type":"system","subtype":"init"}'
if [ -f "${out}/claude-fails" ]; then echo '{"type":"result","is_error":true,"session_id":"bad"}'; exit 1; fi
echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-1","total_cost_usd":0.12,"num_turns":3,"result":"edited"}'`
    );
    return { bin, out, claude: path.join(bin, 'claude') };
  }

  /** @param {string} root @param {Record<string, any>} config */
  function writeConfig(root, config) {
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, JSON.stringify(config));
    return file;
  }

  /** @param {string} root @param {string} binDir @param {string[]} args */
  function cli(root, binDir, args) {
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    return spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH}` }
    });
  }

  function setup(overrides = {}) {
    const fixture = makePhases();
    const tools = fakeTools(fixture.root);
    const config = rawConfig(fixture.root, fixture.phasesDir, {
      idleExitSeconds: 0,
      resolve: { enabled: true, readyDelaySeconds: 0, launchTimeoutSeconds: 5 },
      claude: { bin: tools.claude, skill: 'edit-episode' },
      ...overrides
    });
    const configPath = writeConfig(fixture.root, config);
    const run = (/** @type {string[]} */ args) => cli(fixture.root, tools.bin, [...args, '--config', configPath]);
    return { ...fixture, ...tools, config, configPath, run };
  }

  test('a complete set moves into the episodes folder, Resolve opens, and the edit skill runs from the Phases folder', () => {
    const t = setup();
    writeFiles(t.inboxDir, { 'Courtney.wav': 'a', 'Scott.wav': 'b', '.DS_Store': '' });

    const dry = t.run(['check', '--now', '--dry-run']);
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /would move Courtney\.wav, Scott\.wav into .*Episode 25/);
    assert.ok(!fs.existsSync(path.join(t.out, 'open.log')));

    const result = t.run(['check', '--now']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const episodeDir = path.join(t.episodesDir, 'Episode 25');
    assert.deepEqual(fs.readdirSync(t.inboxDir), ['.DS_Store']);
    assert.ok(fs.existsSync(path.join(episodeDir, 'Courtney.wav')));
    assert.equal(fs.readFileSync(path.join(t.out, 'open.log'), 'utf8').trim(), '-a DaVinci Resolve');
    assert.ok(fs.existsSync(path.join(t.out, 'resolve-was-running.txt')), 'Resolve is open before Claude starts');
    assert.equal(fs.readFileSync(path.join(t.out, 'claude-cwd.txt'), 'utf8').trim(), t.phasesDir);
    const prompt = fs.readFileSync(path.join(t.out, 'claude-stdin.txt'), 'utf8');
    assert.ok(prompt.startsWith('/edit-episode '));
    assert.match(prompt, new RegExp(`Episode folder: ${episodeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const args = fs.readFileSync(path.join(t.out, 'claude-args.txt'), 'utf8').split('\n');
    assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
    assert.ok(!args.includes('--settings'), 'the Phases folder permissions apply as-is');

    const manifest = JSON.parse(fs.readFileSync(manifestPath(episodeDir), 'utf8'));
    assert.equal(manifest.runs[0].status, 'succeeded');
    assert.equal(manifest.runs[0].resolve, 'launched');
    assert.equal(manifest.runs[0].sessionId, 'sess-1');
    assert.ok(!fs.existsSync(t.config.lockPath), 'lock is released');
  });

  test('an already open Resolve is not relaunched', () => {
    const t = setup();
    fs.writeFileSync(path.join(t.out, 'resolve-running'), '');
    writeFiles(t.inboxDir, { 'Courtney.wav': 'a', 'Scott.wav': 'b' });
    const result = t.run(['check', '--now']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(!fs.existsSync(path.join(t.out, 'open.log')));
    const manifest = JSON.parse(fs.readFileSync(manifestPath(path.join(t.episodesDir, 'Episode 25')), 'utf8'));
    assert.equal(manifest.runs[0].resolve, 'already-running');
  });

  test('incomplete sets stay in the inbox', () => {
    const t = setup();
    writeFiles(t.inboxDir, { 'Courtney.wav': 'a' });
    const result = t.run(['check', '--now']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /waiting for: Scott/);
    assert.ok(fs.existsSync(path.join(t.inboxDir, 'Courtney.wav')));
    assert.ok(!fs.existsSync(path.join(t.out, 'open.log')));
  });

  test('if Resolve cannot open, Claude is not started; rerun picks it up', () => {
    const t = setup();
    fs.writeFileSync(path.join(t.out, 'open-fails'), '');
    writeFiles(t.inboxDir, { 'Courtney.mov': 'a', 'Scott.mov': 'b' });
    const failed = t.run(['check', '--now']);
    assert.equal(failed.status, 1);
    assert.ok(!fs.existsSync(path.join(t.out, 'claude-stdin.txt')));
    const episodeDir = path.join(t.episodesDir, 'Episode 25');
    assert.equal(JSON.parse(fs.readFileSync(manifestPath(episodeDir), 'utf8')).runs[0].status, 'failed');

    fs.rmSync(path.join(t.out, 'open-fails'));
    const rerun = t.run(['rerun', episodeDir]);
    assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
    const runs = JSON.parse(fs.readFileSync(manifestPath(episodeDir), 'utf8')).runs;
    assert.deepEqual(runs.map((/** @type {any} */ r) => r.status), ['failed', 'succeeded']);
  });

  test('a missing episodes folder leaves the media in the inbox', () => {
    const t = setup();
    fs.rmSync(t.episodesDir, { recursive: true });
    writeFiles(t.inboxDir, { 'Courtney.wav': 'a', 'Scott.wav': 'b' });
    const result = t.run(['check', '--now']);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /episodes folder .* does not exist/);
    assert.equal(fs.readdirSync(t.inboxDir).length, 2);
    assert.ok(!fs.existsSync(t.episodesDir));
  });

  test('a held lock makes check skip without touching media', () => {
    const t = setup();
    writeFiles(t.inboxDir, { 'Courtney.wav': 'a', 'Scott.wav': 'b' });
    fs.writeFileSync(t.config.lockPath, String(process.pid));
    const result = t.run(['check', '--now']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /lock held/);
    assert.ok(fs.existsSync(path.join(t.inboxDir, 'Scott.wav')));
  });

  test('doctor passes on a ready Phases folder and fails when the inbox is wrong', () => {
    const t = setup();
    const ok = t.run(['doctor']);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /✓ Inbox/);
    assert.match(ok.stdout, /✓ Edit skill: edit-episode \(Phases folder\)/);
    assert.match(ok.stdout, /✓ DaVinci Resolve: installed, not running/);

    const wrong = setup({ inboxDir: 'inbox' });
    const bad = wrong.run(['doctor']);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /✗ Inbox: .*missing.*folders in the Phases folder: episodes, upnext/);
  });
});
