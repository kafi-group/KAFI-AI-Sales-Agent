import { useCallback, useEffect, useState } from "react";
import { client, type CallConfig, type CallInitiateResult } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { phonesMatch, useTwilioVoiceOptional } from "../hooks/useTwilioVoice";
import {
  confirmAssignmentCallProceed,
  getAssignmentCallWarning,
} from "../utils/assignmentCallGuard";
import { IconPhone, IconX } from "./icons/AppIcons";

interface CallLeadButtonProps {
  leadId: number;
  phone: string | null | undefined;
  contactId?: number;
  assignedToUserId?: number | null;
  assignedTo?: string | null;
  onError: (message: string) => void;
  onSuccess?: (result: CallInitiateResult) => void;
  compact?: boolean;
}

function normalizeTelHref(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.startsWith("+")) return `tel:${trimmed}`;
  return `tel:${trimmed.replace(/[^\d+]/g, "")}`;
}

export function CallLeadButton({
  leadId,
  phone,
  contactId,
  assignedToUserId,
  assignedTo,
  onError,
  onSuccess,
  compact = false,
}: CallLeadButtonProps) {
  const { user } = useAuth();
  const voice = useTwilioVoiceOptional();
  const [config, setConfig] = useState<CallConfig | null>(null);
  const [calling, setCalling] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await client.getCallConfig());
    } catch {
      setConfig(null);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  if (!phone?.trim()) {
    return null;
  }

  const twilioVoice = config?.browser_ready && voice ? voice : null;
  const callBlockedReason =
    twilioVoice?.initError ??
    config?.setup_message ??
    (!twilioVoice?.ready ? "Initializing calling…" : null);

  async function handleTwilioCall() {
    if (!twilioVoice) return;
    const assignmentWarning = getAssignmentCallWarning(
      assignedToUserId,
      assignedTo,
      user?.id,
    );
    if (assignmentWarning && !confirmAssignmentCallProceed(assignmentWarning)) {
      return;
    }

    setCalling(true);
    // Safety auto-reset timeout so button is NEVER stuck in "Connecting…"
    const safetyTimer = window.setTimeout(() => {
      setCalling(false);
    }, 16000);

    try {
      if (!twilioVoice.ready) {
        await twilioVoice.retryInit();
      }
      const result = await twilioVoice.placeCall(leadId, contactId, phone ?? undefined);
      onSuccess?.(result);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Call failed");
    } finally {
      window.clearTimeout(safetyTimer);
      setCalling(false);
    }
  }

  const btnClass = compact
    ? "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-50"
    : "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-sky-600 hover:bg-sky-500 text-white font-medium disabled:opacity-50";

  const activeCall = twilioVoice?.activeCall ?? null;
  const inCall = Boolean(twilioVoice?.active);
  const isThisCall =
    inCall &&
    (phonesMatch(phone, activeCall?.phone) ||
      (activeCall?.buyerId != null && activeCall.buyerId === leadId));
  const showInitError = twilioVoice && !twilioVoice.ready && twilioVoice.initError;

  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap" onClick={(e) => e.stopPropagation()}>
      {showInitError && !compact && (
        <span className="text-xs text-red-300" title={twilioVoice.initError ?? undefined}>
          Calling unavailable
        </span>
      )}
      {twilioVoice ? (
        <>
          {isThisCall ? (
            <button
              type="button"
              onClick={() => twilioVoice.hangUp()}
              className={
                compact
                  ? "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-red-600 hover:bg-red-500 text-white"
                  : "inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-red-600 hover:bg-red-500 text-white"
              }
              title="End this call"
            >
              <IconX size="xs" />
              End
            </button>
          ) : (
            <button
              type="button"
              onClick={handleTwilioCall}
              disabled={calling || inCall || !twilioVoice.ready}
              className={btnClass}
              title={
                inCall
                  ? "Another call is already in progress"
                  : twilioVoice.ready
                    ? "Call client directly from your browser (allow microphone)"
                    : callBlockedReason ?? "Calling is not ready yet"
              }
            >
              <IconPhone size={compact ? "xs" : "sm"} />
              {calling ? "Connecting…" : inCall ? "In call" : compact ? "Call" : "Call now"}
            </button>
          )}
        </>
      ) : (
        <a
          href={normalizeTelHref(phone)}
          className={btnClass + " text-center no-underline"}
          title={
            config?.configured
              ? "Complete Twilio browser setup (API key + TwiML App) for in-app calling"
              : "Call via your phone"
          }
        >
          <IconPhone size={compact ? "xs" : "sm"} />
          Call
        </a>
      )}
    </span>
  );
}
