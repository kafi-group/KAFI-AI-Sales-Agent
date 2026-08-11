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
          {failed ? "Something went wrong" : done ? "Ready to download" : status.phase_label || "Working…"}
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

      {!done && !failed && status.current_company && (
        <p className="text-xs text-slate-500 truncate">
          Row: <span className="text-slate-300">{status.current_company}</span>
        </p>
      )}

      {done && status.output_rows > 0 && (
        <p className="text-xs text-emerald-300">{status.output_rows} row(s) in your cleaned file.</p>
      )}

      {failed && status.error && <p className="text-xs text-red-300">{status.error}</p>}
    </div>
  );
}

interface DataSynthesisPageProps {
  onError: (message: string) => void;
}

export function DataSynthesisPage({ onError }: DataSynthesisPageProps) {
  const [sourceFiles, setSourceFiles] = useState<File[]>([]);
  const [running, setRunning] = useState(false);
  const [jobStatus, setJobStatus] = useState<SynthesisJobStatus | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const sourceSummary = useMemo(() => {
    if (sourceFiles.length === 0) return null;
    const names = sourceFiles.map((file) => file.name).slice(0, 3);
    const extra = sourceFiles.length > 3 ? ` +${sourceFiles.length - 3} more` : "";
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
      onError("Select at least one Excel file.");
      return;
    }
    setRunning(true);
    setJobStatus(null);
    setJobId(null);
    try {
      const start = await client.startDataSynthesis(sourceFiles);
      setJobId(start.job_id);
      const finalStatus = await pollJob(start.job_id);
      if (finalStatus.status === "failed") {
        onError(finalStatus.error || "Could not clean the file. Try again.");
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not clean the file. Try again.");
    } finally {
      setRunning(false);
    }
  }

  function handleDownload() {
    if (!jobId || jobStatus?.status !== "completed") return;
    window.open(client.synthesisDownloadUrl(jobId), "_blank", "noopener,noreferrer");
  }

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">Data Synthesis</h2>
        <p className="mt-1 text-sm text-slate-400">
          Upload excel file(s) and download updated and sorted excel file.
        </p>
      </div>

      <label className="block rounded-lg border border-slate-700 bg-slate-900/50 p-4 space-y-3">
        <span className="text-sm font-medium text-slate-200">Select 1 or more excel file(s).</span>
        <input
          type="file"
          accept={ACCEPT}
          multiple
          disabled={running}
          className="block w-full text-sm text-slate-300 file:mr-3 file:rounded file:border-0 file:bg-violet-600 file:px-3 file:py-1.5 file:text-sm file:text-white hover:file:bg-violet-500"
          onChange={(e) => setSourceFiles(Array.from(e.target.files ?? []))}
        />
        {sourceSummary && <p className="text-xs text-slate-500">{sourceSummary}</p>}
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={running || sourceFiles.length === 0}
          onClick={() => void handleStart()}
          className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
        >
          {running ? "Please wait…" : "Start"}
        </button>
        {jobStatus?.status === "completed" && jobId && (
          <button
            type="button"
            onClick={handleDownload}
            className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-200 hover:bg-emerald-500/20"
          >
            Download Excel file
          </button>
        )}
      </div>

      {jobStatus && <ProgressPanel status={jobStatus} />}
    </div>
  );
}
