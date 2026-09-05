# Inbox

Exported annotation files from the extension's options page go here, one
`slop-inbox-YYYYMMDD-HHMM.jsonl` per export. They are append-only history.
`node eval/triage.mjs` reads every file in this directory and never modifies them.
Decisions live in `eval/triage_log.json`, keyed by text hash, so re-running triage
on the same files asks nothing twice.
