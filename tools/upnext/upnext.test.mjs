import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  DEFAULT_CONFIG_PATH,
  TOOL_DIR,
  acquireLock,
  busyReason,
  evaluate,
  globToRegExp,
  launchdPlist,
  loadConfig,
  normalizeConfig,
  parseResult,
  renderTemplate,
  waitUntilReady
} from './lib.mjs';

const CLI = path.join(TOOL_DIR, 'upnext.mjs');
const PROMPT = path.join(TOOL_DIR, 'prompt.md');

const ROLES = [
  { id: 'courtney', label: 'Courtney', match: ['*courtney*'], extensions: ['wav', 'mov'], min: 1 },
  { id: 'scott', label: 'Scott', match: ['*scott*'], extensions: ['wav', 'mov'], min: 1 }
];

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phases-upnext-'));
}

/** @param {string} root @param {Record<string, any>} [overrides] */
function makeConfig(root, overrides = {}) {
  return {
    watchDir: path.join(root, 'upnext'),
    projectsDir: path.join(root, 'projects'),
    lockPath: path.join(root, '.upnext.lock'),
    settleSeconds: 30,
    pollSeconds: 5,
    idleExitSeconds: 120,
    maxWaitMinutes: 10,
    requiredMedia: ROLES,
    probe: false,
    notify: false,
    ...overrides,
    claude: { promptTemplate: PROMPT, ...(overrides.claude ?? {}) }
  };
}

/** @param {string} dir @param {Record<string, string>} files */
function writeFiles(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
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

/** @param {Partial<import('./lib.mjs').MediaFile>[]} files @param {string[]} [inProgress] */
function scanOf(files, inProgress = []) {
  return {
    exists: true,
    topLevel: files.map((f) => f.rel ?? ''),
    dirChangeMs: 0,
    inProgress,
    files: files.map((f) => ({ rel: f.rel ?? '', name: path.basename(f.rel ?? ''), size: 10, mtimeMs: 1, ctimeMs: 1, busy: null, ...f }))
  };
}

describe('matching', () => {
  test('globs are case-insensitive and support alternatives', () => {
    const re = globToRegExp('*courtney*.{wav,m4a}');
    assert.ok(re.test('Ep24 - Courtney Track.WAV'));
    assert.ok(re.test('courtney.m4a'));
    assert.ok(!re.test('courtney.mov'));
    assert.ok(!re.test('scott.wav'));
    assert.ok(globToRegExp('.*').test('.DS_Store'));
    assert.ok(globToRegExp('file?.txt').test('file1.txt'));
    assert.ok(!globToRegExp('a.b').test('axb'));
  });

  test('config validation rejects unusable media rules', () => {
    assert.throws(() => normalizeConfig({ requiredMedia: [] }), /at least one media role/);
    assert.throws(() => normalizeConfig({ requiredMedia: [{ id: 'x' }] }), /match globs or extensions/);
    assert.throws(() => normalizeConfig({ requiredMedia: [{ id: 'x', match: ['*'], min: 0 }] }), /min >= 1/);
    assert.throws(() => normalizeConfig({ requiredMedia: [{ id: 'x', match: ['*'], min: -1 }] }), /non-negative/);
  });

  test('the shipped config loads and expands ~ paths', () => {
    const config = loadConfig(DEFAULT_CONFIG_PATH);
    assert.equal(config.watchDir, path.join(os.homedir(), 'Documents/phases/upnext'));
    assert.ok(config.roles.length >= 1);
    assert.ok(fs.existsSync(config.claude.promptTemplate));
  });

  test('evaluate reports missing, extra, busy, and ready', () => {
    const config = normalizeConfig(makeConfig(tempDir()));
    const partial = evaluate(scanOf([{ rel: 'Courtney.wav' }, { rel: 'notes.txt' }]), config);
    assert.equal(partial.complete, false);
    assert.deepEqual(partial.missing.map((r) => r.id), ['scott']);
    assert.deepEqual(partial.extras.map((f) => f.rel), ['notes.txt']);

    const full = evaluate(scanOf([{ rel: 'Courtney.wav' }, { rel: 'ep/Scott.mov' }]), config);
    assert.equal(full.ready, true);

    const busy = evaluate(scanOf([{ rel: 'Courtney.wav' }, { rel: 'Scott.wav', busy: 'Finder copy in progress' }]), config);
    assert.equal(busy.complete, true);
    assert.equal(busy.ready, false);

    const downloading = evaluate(scanOf([{ rel: 'Courtney.wav' }, { rel: 'Scott.wav' }], ['Guest.wav.crdownload']), config);
    assert.equal(downloading.ready, false);

    const strict = normalizeConfig({ ...makeConfig(tempDir()), allowExtraFiles: false });
    const blocked = evaluate(scanOf([{ rel: 'Courtney.wav' }, { rel: 'Scott.wav' }, { rel: 'x.txt' }]), strict);
    assert.equal(blocked.ready, false);
    assert.equal(blocked.blockedByExtras, true);
  });

  test('roles honor max so extra takes can fill a later role', () => {
    const config = normalizeConfig({
      ...makeConfig(tempDir()),
      requiredMedia: [
        { id: 'audio', match: ['*'], extensions: ['wav'], min: 1, max: 1 },
        { id: 'backup', match: ['*'], extensions: ['wav'], min: 1 }
      ]
    });
    const result = evaluate(scanOf([{ rel: 'a.wav' }, { rel: 'b.wav' }]), config);
    assert.equal(result.ready, true);
  });

  test('busyReason flags empty files and Finder copies', () => {
    assert.equal(busyReason({ size: 0, birthtime: new Date() }), 'empty file (still being created)');
    assert.equal(busyReason({ size: 5, birthtime: new Date(1984, 0, 24, 8) }), 'Finder copy in progress');
    assert.equal(busyReason({ size: 5, birthtime: new Date() }), null);
  });
});

describe('settling', () => {
  test('waits the settle window, then reports ready', async () => {
    const root = tempDir();
    const config = normalizeConfig(makeConfig(root));
    writeFiles(config.watchDir, { 'Courtney.wav': 'a', 'Scott.wav': 'b', '.DS_Store': '' });
    const clock = fakeClock();
    const started = clock.t;
    const outcome = await waitUntilReady(config, { clock });
    assert.equal(outcome.status, 'ready');
    assert.ok(clock.t - started >= 25_000, 'should not hand off before the files have been quiet');
  });

  test('a change during settling restarts the window', async () => {
    const root = tempDir();
    const config = normalizeConfig(makeConfig(root));
    writeFiles(config.watchDir, { 'Courtney.wav': 'a', 'Scott.wav': 'b' });
    const start = Date.now();
    let grew = false;
    const clock = fakeClock(start, (t) => {
      if (!grew && t - start >= 20_000) {
        fs.appendFileSync(path.join(config.watchDir, 'Scott.wav'), 'more');
        grew = true;
      }
    });
    const outcome = await waitUntilReady(config, { clock });
    assert.equal(outcome.status, 'ready');
    assert.ok(clock.t - start >= 50_000, `restarted window should end after 20s + 30s, ended at ${clock.t - start}`);
  });

  test('media that finished copying earlier is ready without waiting', async () => {
    const root = tempDir();
    const config = normalizeConfig(makeConfig(root));
    writeFiles(config.watchDir, { 'Courtney.wav': 'a', 'Scott.wav': 'b' });
    const clock = fakeClock(Date.now() + 3_600_000);
    const started = clock.t;
    const outcome = await waitUntilReady(config, { clock });
    assert.equal(outcome.status, 'ready');
    assert.equal(clock.t, started);
  });

  test('an incomplete set exits once the folder is idle', async () => {
    const root = tempDir();
    const config = normalizeConfig(makeConfig(root));
    writeFiles(config.watchDir, { 'Courtney.wav': 'a' });
    const outcome = await waitUntilReady(config, { clock: fakeClock() });
    assert.equal(outcome.status, 'incomplete');
    assert.deepEqual(outcome.evaluation?.missing.map((r) => r.id), ['scott']);
  });

  test('an in-progress download keeps it waiting until timeout', async () => {
    const root = tempDir();
    const config = normalizeConfig({ ...makeConfig(root), maxWaitMinutes: 1 });
    writeFiles(config.watchDir, { 'Courtney.wav': 'a', 'Scott.wav': 'b', 'Guest.wav.crdownload': 'c' });
    const outcome = await waitUntilReady(config, { clock: fakeClock() });
    assert.equal(outcome.status, 'timeout');
  });

  test('empty and missing folders return immediately', async () => {
    const root = tempDir();
    const config = normalizeConfig(makeConfig(root));
    assert.equal((await waitUntilReady(config, { clock: fakeClock() })).status, 'missing-dir');
    writeFiles(config.watchDir, { '.DS_Store': '' });
    assert.equal((await waitUntilReady(config, { clock: fakeClock() })).status, 'empty');
  });
});

describe('helpers', () => {
  test('prompt template rejects unknown placeholders and the shipped template renders', () => {
    assert.throws(() => renderTemplate('{{nope}}', {}), /Unknown prompt placeholder/);
    const rendered = renderTemplate(fs.readFileSync(PROMPT, 'utf8'), {
      batchId: 'b',
      projectDir: '/p',
      mediaDir: '/p/media',
      outputDir: '/p/edit',
      manifestPath: '/p/upnext.json',
      mediaList: '- x'
    });
    assert.ok(!rendered.includes('{{'));
  });

  test('parseResult finds the final stream-json result', () => {
    const log = ['{"type":"system"}', '{"type":"result","is_error":false,"session_id":"s1"}', ''].join('\n');
    assert.equal(parseResult(log)?.session_id, 's1');
    assert.equal(parseResult('{"type":"assistant"}'), null);
  });

  test('lock is exclusive and stale locks are reclaimed', () => {
    const root = tempDir();
    const lockPath = path.join(root, 'nested', '.lock');
    const release = acquireLock(lockPath);
    assert.ok(release);
    fs.writeFileSync(lockPath, String(process.ppid));
    assert.equal(acquireLock(lockPath), null);
    fs.writeFileSync(lockPath, '999999');
    const again = acquireLock(lockPath);
    assert.ok(again);
    again();
    assert.ok(!fs.existsSync(lockPath));
  });

  test('launchd plist watches the folder and escapes XML', () => {
    const xml = launchdPlist({
      nodePath: '/opt/homebrew/bin/node',
      scriptPath: '/x/upnext.mjs',
      configPath: '/x/a&b.json',
      watchDir: '/Users/me/Documents/phases/upnext',
      logPath: '/tmp/log',
      pathEnv: '/usr/bin:/bin'
    });
    assert.match(xml, /<key>WatchPaths<\/key>\s*<array>\s*<string>\/Users\/me\/Documents\/phases\/upnext<\/string>/);
    assert.match(xml, /a&amp;b\.json/);
    assert.match(xml, /<string>check<\/string>/);
  });
});

describe('cli end to end (stub Claude Code)', () => {
  /** @param {string} root @param {number} exitCode */
  function stubClaude(root, exitCode) {
    const bin = path.join(root, `fake-claude-${exitCode}`);
    const isError = exitCode === 0 ? 'false' : 'true';
    fs.writeFileSync(
      bin,
      `#!/bin/sh
printf '%s\\n' "$@" > "$PWD/args.txt"
cat > "$PWD/stdin.txt"
echo '{"type":"system","subtype":"init"}'
echo '{"type":"result","subtype":"success","is_error":${isError},"session_id":"sess-${exitCode}","total_cost_usd":0.12,"num_turns":3,"result":"edited"}'
exit ${exitCode}
`,
      { mode: 0o755 }
    );
    return bin;
  }

  /** @param {string} root @param {Record<string, any>} config */
  function writeConfig(root, config) {
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, JSON.stringify(config));
    return file;
  }

  /** @param {string[]} args */
  function cli(args) {
    return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30_000 });
  }

  test('check claims a complete set, runs Claude in the project, and records the run', () => {
    const root = tempDir();
    const config = makeConfig(root, { idleExitSeconds: 0, claude: { bin: stubClaude(root, 0), allowedTools: ['Read', 'Bash(ffmpeg *)'] } });
    const configPath = writeConfig(root, config);
    writeFiles(config.watchDir, { 'Courtney.wav': 'a', 'Scott.wav': 'b', 'show notes.txt': 'n', '.DS_Store': '' });

    const status = cli(['status', '--json', '--config', configPath]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).ready, true);

    const dry = cli(['check', '--now', '--dry-run', '--config', configPath]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /dry run: would claim/);
    assert.ok(fs.existsSync(path.join(config.watchDir, 'Courtney.wav')));

    const result = cli(['check', '--now', '--config', configPath]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(fs.readdirSync(config.watchDir), ['.DS_Store']);

    const [batch] = fs.readdirSync(config.projectsDir);
    const projectDir = path.join(config.projectsDir, batch);
    const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, 'upnext.json'), 'utf8'));
    assert.deepEqual(manifest.roles.map((/** @type {any} */ r) => r.files.map((/** @type {any} */ f) => f.path)), [['media/Courtney.wav'], ['media/Scott.wav']]);
    assert.deepEqual(manifest.extras.map((/** @type {any} */ f) => f.path), ['media/show notes.txt']);
    assert.equal(manifest.runs[0].status, 'succeeded');
    assert.equal(manifest.runs[0].sessionId, 'sess-0');
    assert.ok(fs.existsSync(path.join(projectDir, 'edit')));

    const prompt = fs.readFileSync(path.join(projectDir, 'stdin.txt'), 'utf8');
    assert.match(prompt, /media\/Courtney\.wav/);
    assert.ok(!prompt.includes('{{'));
    const args = fs.readFileSync(path.join(projectDir, 'args.txt'), 'utf8').split('\n');
    assert.ok(args.includes('-p'));
    assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
    const settingsPath = path.join(projectDir, 'claude-settings.json');
    assert.equal(args[args.indexOf('--settings') + 1], settingsPath);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(settings.permissions.allow, ['Read', 'Bash(ffmpeg *)']);
    assert.equal(settings.permissions.defaultMode, 'acceptEdits');
    assert.ok(!fs.existsSync(config.lockPath), 'lock is released');
  });

  test('incomplete sets are left alone', () => {
    const root = tempDir();
    const config = makeConfig(root, { idleExitSeconds: 0, claude: { bin: stubClaude(root, 0) } });
    const configPath = writeConfig(root, config);
    writeFiles(config.watchDir, { 'Courtney.wav': 'a' });
    const result = cli(['check', '--now', '--config', configPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /waiting for: Scott/);
    assert.ok(fs.existsSync(path.join(config.watchDir, 'Courtney.wav')));
    assert.ok(!fs.existsSync(config.projectsDir));
  });

  test('a failed edit is recorded and can be rerun', () => {
    const root = tempDir();
    const config = makeConfig(root, { idleExitSeconds: 0, claude: { bin: stubClaude(root, 3) } });
    const configPath = writeConfig(root, config);
    writeFiles(config.watchDir, { 'Courtney.mov': 'a', 'Scott.mov': 'b' });

    const failed = cli(['check', '--now', '--config', configPath]);
    assert.equal(failed.status, 1);
    const [batch] = fs.readdirSync(config.projectsDir);
    const projectDir = path.join(config.projectsDir, batch);
    assert.equal(JSON.parse(fs.readFileSync(path.join(projectDir, 'upnext.json'), 'utf8')).runs[0].status, 'failed');

    const fixedPath = writeConfig(root, { ...config, claude: { ...config.claude, bin: stubClaude(root, 0) } });
    const rerun = cli(['rerun', projectDir, '--config', fixedPath]);
    assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
    const runs = JSON.parse(fs.readFileSync(path.join(projectDir, 'upnext.json'), 'utf8')).runs;
    assert.deepEqual(runs.map((/** @type {any} */ r) => r.status), ['failed', 'succeeded']);
  });

  test('a held lock makes check skip without touching media', () => {
    const root = tempDir();
    const config = makeConfig(root, { idleExitSeconds: 0, claude: { bin: stubClaude(root, 0) } });
    const configPath = writeConfig(root, config);
    writeFiles(config.watchDir, { 'Courtney.wav': 'a', 'Scott.wav': 'b' });
    fs.writeFileSync(config.lockPath, String(process.pid));
    const result = cli(['check', '--now', '--config', configPath]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /lock held/);
    assert.ok(fs.existsSync(path.join(config.watchDir, 'Scott.wav')));
  });
});
