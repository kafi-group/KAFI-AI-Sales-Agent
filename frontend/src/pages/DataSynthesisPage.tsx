import { useMemo, useState } from "react";
import { client, type SynthesisJobStatus } from "../api/client";

const ACCEPT = ".csv,.xlsx,.xls,.xlsm,.tsv";
const POLL_MS = 800;
const MAX_POLL_FAILURES = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

function ProgressPanel({ status }: { status: SynthesisJobStatus }) {
  const done = status.status === "completed";
  const failed = status.status === "failed";
  const percent = done ? 100 : status.percent ?? 0;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-slate-100">
          {failed
            ? "Synthesis failed"
            : done
              ? "Synthesis complete — download your cleaned master file"
              : status.phase_label || "Processing…"}
        </p>
        <span className="text-xs tabular-nums text-slate-400">
          {percent}% · {formatElapsed(status.elapsed_seconds)}
        </span>
      </div>

      <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${
            failed ? "bg-red-500" : done ? "bg-emerald-500" : "bg-gradient-to-r from-cyan-600 to-violet-500"
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-slate-300">
        <span>
          {Math.min(status.processed, status.total || status.processed)} / {status.total || "—"} rows scanned
        </span>
        {status.output_rows > 0 && (
          <span className="text-emerald-300">{status.output_rows} in output</span>
        )}
        {status.skipped_existing > 0 && (
          <span className="text-amber-300">{status.skipped_existing} skipped (already in master)</span>
        )}
        {status.merged_duplicates > 0 && (
          <span className="text-violet-300">{status.merged_duplicates} merged</span>
        )}
      </div>

      {!done && !failed && status.current_company && (
        <p className="text-xs text-slate-500 truncate">
          Processing: <span className="text-slate-300">{status.current_company}</span>
        </p>
      )}

      {failed && status.error && (
        <p className="text-xs text-red-300">{status.error}</p>
      )}

      {status.messages.length > 0 && (
        <ul className="text-xs text-slate-400 space-y-1 list-disc pl-4">
          {status.messages.slice(-6).map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface DataSynthesisPageProps {
  onError: (message: string) => void;
}

export function DataSynthesisPage({ onError }: DataSynthesisPageProps) {
  const [sourceFiles, setSourceFiles] = useState<File[]>([]);
  const [baselineFile, setBaselineFile] = useState<File | null>(null);
  const [checkDb, setCheckDb] = useState(true);
  const [running, setRunning] = useState(false);
  const [jobStatus, setJobStatus] = useState<SynthesisJobStatus | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const sourceSummary = useMemo(() => {
    if (sourceFiles.length === 0) return "No source files selected";
    const names = sourceFiles.map((file) => file.name).slice(0, 4);
    const extra = sourceFiles.length > 4 ? ` +${sourceFiles.length - 4} more` : "";
    return `${sourceFiles.length} file(s): ${names.join(", ")}${extra}`;
  }, [sourceFiles]);

  async function pollJob(id: string): Promise<SynthesisJobStatus> {
    let failures = 0;
    for (;;) {
      try {
        const status = await client.getSynthesisJob(id);
        setJobStatus(status);
        failures = 0;
        if (status.status === "completed" || status.status === "failed") {
          return status;
        }
      } catch (e) {
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) {
          throw e;
        }
      }
      await sleep(POLL_MS);
    }
  }

  async function handleStart() {
    if (sourceFiles.length === 0) {
      onError("Select at least one XLS or CSV file to synthesize.");
      return;
    }
    setRunning(true);
    setJobStatus(null);
    setJobId(null);
    try {
      const start = await client.startDataSynthesis(sourceFiles, {
        baseline: baselineFile,
        checkDb,
      });
      setJobId(start.job_id);
      const finalStatus = await pollJob(start.job_id);
      if (finalStatus.status === "failed") {
        onError(finalStatus.error || "Data synthesis failed.");
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Data synthesis failed");
    } finally {
      setRunning(false);
    }
  }

  function handleDownload() {
    if (!jobId || jobStatus?.status !== "completed") return;
    window.open(client.synthesisDownloadUrl(jobId), "_blank", "noopener,noreferrer");
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">Data Synthesis</h2>
        <p className="mt-1 text-sm text-slate-400 max-w-3xl">
          Upload scattered Kafi spreadsheets (multiple files and sheets). Rows are cleaned,
          mapped to the Master Contacts layout, deduplicated across files, and checked against
          your baseline master file and CRM. Download one cleaned XLSX ready for import.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <label className="block rounded-lg border border-slate-700 bg-slate-900/50 p-4 space-y-2">
          <span className="text-sm font-medium text-slate-200">Source files (required)</span>
          <span className="block text-xs text-slate-500">
            Select all duplicate / partial exports — every sheet in each workbook is processed.
          </span>
          <input
            type="file"
            accept={ACCEPT}
            multiple
            disabled={running}
            className="block w-full text-sm text-slate-300 file:mr-3 file:rounded file:border-0 file:bg-violet-600 file:px-3 file:py-1.5 file:text-sm file:text-white hover:file:bg-violet-500"
            onChange={(e) => setSourceFiles(Array.from(e.target.files ?? []))}
          />
          <p className="text-xs text-slate-500">{sourceSummary}</p>
        </label>

        <label className="block rounded-lg border border-slate-700 bg-slate-900/50 p-4 space-y-2">
          <span className="text-sm font-medium text-slate-200">Baseline master (optional)</span>
          <span className="block text-xs text-slate-500">
            Current Master Contacts file — rows matching phone, email, website, or name+country
            are skipped so only net-new leads are added to the output.
          </span>
          <input
            type="file"
            accept={ACCEPT}
            disabled={running}
            className="block w-full text-sm text-slate-300 file:mr-3 file:rounded file:border-0 file:bg-slate-600 file:px-3 file:py-1.5 file:text-sm file:text-white hover:file:bg-slate-500"
            onChange={(e) => setBaselineFile(e.target.files?.[0] ?? null)}
          />
          <p className="text-xs text-slate-500">
            {baselineFile ? baselineFile.name : "Uses CRM database only if no baseline uploaded"}
          </p>
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input
          type="checkbox"
          checked={checkDb}
          disabled={running}
          onChange={(e) => setCheckDb(e.target.checked)}
          className="rounded border-slate-600 bg-slate-800 text-violet-500"
        />
        Also skip rows that already exist anywhere in the CRM (recommended)
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={running || sourceFiles.length === 0}
          onClick={() => void handleStart()}
          className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
        >
          {running ? "Synthesizing…" : "Start synthesis"}
        </button>
        {jobStatus?.status === "completed" && jobId && (
          <button
            type="button"
            onClick={handleDownload}
            className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-200 hover:bg-emerald-500/20"
          >
            Download cleaned master XLSX
          </button>
        )}
      </div>

      {jobStatus && <ProgressPanel status={jobStatus} />}

      <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-500 space-y-2">
        <p className="font-medium text-slate-400">Output columns (Master Contacts format)</p>
        <p>
          S. No · Company Name · Business Type · Companies Grading · Designation · Contact Person ·
          Primary/Secondary Mobile · Primary/Secondary Phone · Primary/Secondary Email · Country ·
          Product · City · Address · Remarks
        </p>
        <p>
          Sparse sheets (e.g. Name, Email, Company only) are mapped intelligently. Mislabeled columns
          (phone in Company Name) are detected when possible. After download, import via Master table
          → Old clients → Import.
        </p>
      </div>
    </div>
  );
}
