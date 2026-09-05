// Shows what has been captured and gets it out as a JSONL file for eval/inbox/.

const $ = id => document.getElementById(id);
const DEFAULT_STATUS = "Drop the exported file into eval/inbox/ and run node eval/triage.mjs.";

async function load() {
  const { records = [], lastExportAt = null } = await chrome.storage.local.get(["records", "lastExportAt"]);
  const annotations = records.filter(r => r.kind === "annotation");
  // The reader disagreed when their label points the other way from what the
  // extension drew on the page.
  const disagreements = annotations.filter(r => (r.label_quality === "SLOP") !== Boolean(r.model.flagged));
  $("annotations").textContent = annotations.length;
  $("dismissals").textContent = records.filter(r => r.kind === "dismissal").length;
  $("disagreements").textContent = disagreements.length;
  const bytes = await chrome.storage.local.getBytesInUse(null);
  $("bytes").textContent = `${(bytes / 1024).toFixed(1)} KB`;
  $("clear").disabled = !lastExportAt || !records.some(r => r.created_at <= lastExportAt);
  return { records, lastExportAt };
}

function stamp(date) {
  const two = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`;
}

$("export").addEventListener("click", async () => {
  const { records } = await load();
  if (records.length === 0) { $("status").textContent = "Nothing to export yet."; return; }
  const now = new Date();
  const body = records.map(r => JSON.stringify(r)).join("\n") + "\n";
  const url = URL.createObjectURL(new Blob([body], { type: "application/x-ndjson" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `slop-inbox-${stamp(now)}.jsonl`;
  link.click();
  // Revoking straight away can cancel the download in some builds. Give it time.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  await chrome.storage.local.set({ lastExportAt: now.toISOString() });
  $("status").textContent = `Exported ${records.length} record(s). ${DEFAULT_STATUS}`;
  await load();
});

$("clear").addEventListener("click", async () => {
  const { records, lastExportAt } = await load();
  const keep = records.filter(r => r.created_at > lastExportAt);
  const removing = records.length - keep.length;
  if (!confirm(`Delete ${removing} exported record(s)? Anything saved after the last export is kept.`)) return;
  await chrome.storage.local.set({ records: keep });
  $("status").textContent = `Removed ${removing} record(s), kept ${keep.length}.`;
  await load();
});

load();
