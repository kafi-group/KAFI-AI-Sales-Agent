import { BulkCallQueuePanel } from "./BulkCallQueuePanel";
import { useCallQueueOptional } from "../hooks/useCallQueue";

/**
 * App-level host so the bulk queue survives Calls / Leads table remounts.
 * Skip ends only the current call; Save & next advances within this shared state.
 */
export function BulkCallQueueHost({ onError }: { onError?: (message: string) => void }) {
  const queue = useCallQueueOptional();
  if (!queue || queue.status === "idle") return null;

  return (
    <div className="fixed top-16 left-3 right-3 md:left-auto md:right-4 md:w-[min(100vw-2rem,44rem)] z-[55] pointer-events-auto max-h-[min(70vh,36rem)] overflow-y-auto shadow-2xl">
      <BulkCallQueuePanel
        queue={queue}
        onClose={() => queue.stop()}
        onError={onError}
      />
    </div>
  );
}
