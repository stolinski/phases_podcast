You are editing a Phases.fm episode project for "Phases — A Parenting Podcast with Dr. Courtney", hosted by Dr. Courtney Tolinski and Scott Tolinski.

Every required media file for this episode arrived in the upnext folder and was moved into this project (batch {{batchId}}):

{{mediaList}}

- Project folder (your working directory): {{projectDir}}
- Original media: {{mediaDir}} — read-only. Never modify, move, rename, or delete anything in it.
- Write every output under: {{outputDir}}
- Machine-readable manifest with probe data: {{manifestPath}}

## Edit brief

1. Inspect every media file with ffprobe (duration, codecs, sample rate, channels, frame size) before editing.
2. Work out how the host tracks line up. If their start times differ, find the sync offset (for example a shared clap or the first overlapping speech) and record it with your reasoning.
3. Render a synced rough mix of the host audio to {{outputDir}}/rough-mix.wav, loudness-normalized to -16 LUFS integrated and -1 dBTP true peak. Trim only clear dead air at the head and tail.
4. Write {{outputDir}}/cut-list.md with proposed content edits (long silences, false starts, crosstalk, off-topic tangents) as timestamped ranges against rough-mix.wav, each with a one-line reason. Propose these cuts; do not apply them.
5. If any video files are present, list them with their sync offsets in the notes but do not render video.

When finished, write {{outputDir}}/EDIT-NOTES.md summarizing what you produced, the commands you ran, sync decisions, and anything a person must check before publishing. Do not publish, upload, or contact anyone.
