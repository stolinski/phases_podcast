# Phases inbox watcher

Runs on the Mac that edits Phases (Scott's MacBook Pro), against the existing Phases folder in Documents. It uses only local folders; nothing involves iCloud.

When every required media file is in the inbox and has finished copying, the watcher:

1. moves the set into the normal episodes folder,
2. opens DaVinci Resolve if it is not already running (a running Resolve is left alone), and
3. starts Claude Code from the Phases folder, so that folder's `CLAUDE.md`, skills, and permission rules drive the edit the way they normally do.

```
~/Documents/phases/
  upnext/                        inbox (inboxDir)
  episodes/                      normal episodes folder (episodesDir)
    Episode 25/                  media lands here
      .upnext/                   hand-off record, prompt, and Claude logs
  .claude/skills/…               the editing skills Claude uses
```

## Set up on the MacBook Pro

```bash
git pull                          # in the Phases repo checkout
npm run upnext -- doctor          # checks folders, skills, Claude Code, folder trust, Resolve
```

`doctor` only reads. It lists the Phases folder's skills, shows which folder the next episode would go into, and flags anything missing. Adjust `tools/upnext/config.json` until it is clean:

- `inboxDir`, `episodesDir`: folder names inside `phasesDir` (or absolute paths). The watcher never creates them.
- `claude.skill`: the editing skill to run, for example `"edit-episode"`. The prompt then starts with `/edit-episode`. Left `null`, Claude picks the editing skill from the folder's skill descriptions.
- `requiredMedia`: what makes a set complete (see below).
- `episodeFolderName`: name for loose files. `{prefix}{next}` continues the existing numbering, so after `Episode 24 - Sleep` comes `Episode 25`. `{date}` is also available. A single folder dropped into the inbox keeps its own name instead, and if an episode folder with that name already exists, the media is added to it (any name clash stops the move before anything changes).

Then install the LaunchAgent. It uses launchd `WatchPaths`, so no process stays running between changes:

```bash
npm run upnext -- launchd install     # runs doctor first; refuses if anything fails
tail -f ~/Library/Logs/phases-upnext.log
npm run upnext -- launchd uninstall
```

macOS protects Documents. The LaunchAgent runs `node` directly, so give that node binary Documents access (System Settings > Privacy & Security > Files and Folders, or Full Disk Access) if the log shows `EPERM`. Alternatively run `npm run upnext:watch` in a terminal that already has access.

Open Claude Code in the Phases folder once and accept the trust prompt if `doctor` warns about folder trust; until then Claude ignores that folder's permission rules in unattended runs.

## Day to day

```bash
npm run upnext -- status                              # what's in the inbox, missing, or still copying
npm run upnext -- check --dry-run                     # where the next set would go, without moving anything
npm run upnext -- rerun ~/Documents/phases/episodes/"Episode 25"   # start the edit again
```

Claude runs headless (`claude -p`) with `--permission-prompts none`, so anything the Phases folder's permission rules do not allow is denied instead of waiting for someone. The log prints a `claude --resume <session>` command to pick the session up interactively. `claude.allowedTools` adds extra allow rules, and `claude.model`, `claude.effort`, and `claude.maxBudgetUsd` are passed through when set.

If Resolve cannot be opened, Claude is not started (`resolve.required`); the media stays in its episode folder and `rerun` starts the edit later. `resolve.readyDelaySeconds` gives a freshly opened Resolve time to load before the edit starts.

## When is a set complete?

`requiredMedia` lists media roles. Each role matches file names with case-insensitive globs (`match`) and/or `extensions`, and needs at least `min` files (optional `max`). The shipped roles are one Dr. Courtney track (`*courtney*`) and one Scott track (`*scott*`); change them to match how episodes are actually recorded. Other files ride along unless `allowExtraFiles` is `false`.

The watcher also waits until nothing is still downloading (`*.download`, `*.crdownload`, `*.part`, …), no file is empty or mid-Finder-copy, and nothing has changed for `settleSeconds` (default 30). Hidden files are ignored. An incomplete set is left in the inbox and checked again on the next change. A lock file in `~/Library/Caches` keeps two runs from overlapping.

`npm run test:upnext` runs the tests with fake Claude Code and Resolve.
