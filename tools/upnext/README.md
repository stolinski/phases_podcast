# Phases upnext watcher

Drop an episode's media into `~/Documents/phases/upnext`. When every required file is present and has finished copying, the watcher moves the set into a new episode project folder and starts Claude Code headlessly to edit it.

```
~/Documents/phases/
  upnext/                      drop media here
  projects/<YYYY-MM-DD-HHMMSS>/
    media/                     the claimed originals (Claude treats them as read-only)
    edit/                      everything Claude produces
    upnext.json                manifest: roles, sizes, ffprobe data, run history
    prompt.md                  the exact prompt Claude received
    claude-settings.json       tool permissions passed with --settings
    claude-run-N.jsonl         stream-json log of run N (tail -f to follow)
```

## Use it

```bash
npm run upnext -- status            # what's present, missing, or still copying
npm run upnext:watch                # watch from a terminal (FSEvents, idle between events)
npm run upnext -- check --dry-run   # what the next hand-off would do, without doing it
npm run upnext -- rerun ~/Documents/phases/projects/<batch>   # retry a failed or unsatisfying edit
npm run test:upnext
```

To run unattended without a terminal open, install the LaunchAgent. It uses launchd `WatchPaths`, so no process stays running: launchd starts a short `check` when the folder changes, plus a cheap safety-net check every 15 minutes.

```bash
npm run upnext -- launchd print      # review the plist first
npm run upnext -- launchd install    # writes ~/Library/LaunchAgents/fm.phases.upnext.plist and loads it
npm run upnext -- launchd uninstall
tail -f ~/Library/Logs/phases-upnext.log
```

macOS protects `~/Documents`. A terminal that can already read Documents works immediately with `watch`. The LaunchAgent runs `node` directly, so give the node binary Documents access (or Full Disk Access) in System Settings > Privacy & Security if the log shows `EPERM`.

## When is a set "complete"?

`config.json` → `requiredMedia` lists the media roles. Each role matches file names with case-insensitive globs (`match`) and/or `extensions`, and needs at least `min` files (optional `max`). A file fills the first role it matches. Files that match no role are carried along as extras unless `allowExtraFiles` is `false`, in which case they block the hand-off.

Shipped defaults require one Dr. Courtney track (`*courtney*`) and one Scott track (`*scott*`), each audio or video. Add roles such as a guest track, a wide camera, or music beds as the workflow needs.

Before handing off, the watcher also requires that:

- nothing is still downloading (`*.download`, `*.crdownload`, `*.part`, …) and no file is empty or mid-Finder-copy;
- nothing has changed for `settleSeconds` (default 30), measured from the newest file change, so media that finished copying earlier is handed off immediately.

Hidden files (`.DS_Store`, iCloud placeholders) are ignored. Media can be dropped loose or inside a folder.

If the set is incomplete, the watcher exits after `idleExitSeconds` without changes and checks again on the next change. Moving the media out of `upnext` claims it, so the same set is never edited twice and the folder is ready for the next episode. A lock file keeps the terminal watcher and the LaunchAgent from running at the same time.

## What Claude does

`prompt.md` is the edit brief. It is a template with `{{batchId}}`, `{{projectDir}}`, `{{mediaDir}}`, `{{outputDir}}`, `{{manifestPath}}`, and `{{mediaList}}`; unknown placeholders fail loudly. The default brief syncs the host tracks, renders a loudness-normalized rough mix, proposes (but does not apply) content cuts, and writes `edit/EDIT-NOTES.md`.

Claude Code runs with `claude -p` inside the project folder, the prompt on stdin, `--permission-mode acceptEdits`, and `--permission-prompts none`, so anything not allowed by `claude.allowedTools` is denied instead of waiting for a person. Set `claude.model`, `claude.effort`, or `claude.maxBudgetUsd` to pin the model, effort, or a per-run spend cap. After a run, the log prints a `claude --resume <session>` command to continue the edit interactively.

Use `--config <path>` or `PHASES_UPNEXT_CONFIG` to point at a different config; relative paths in a config resolve from that config's folder.
