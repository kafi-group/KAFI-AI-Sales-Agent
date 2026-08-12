import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Call, Device } from "@twilio/voice-sdk";
import { client, type CallInitiateResult } from "../api/client";

export interface PendingCallFollowUp {
  interactionId: number;
  label: string;
  buyerId?: number | null;
  contactId?: number | null;
  dialedPhone?: string | null;
  /** Numbers already tried this session (same lead, before final remarks). */
  triedPhones?: string[];
}

/** Identifies which dialed number currently owns the live call UI. */
export interface ActiveCallTarget {
  buyerId: number | null;
  contactId: number | null;
  phone: string | null;
}

interface TwilioVoiceContextValue {
  ready: boolean;
  active: boolean;
  activeCall: ActiveCallTarget | null;
  initError: string | null;
  /** Last outbound call failure (does not mean the dialer is offline). */
  callError: string | null;
  clearCallError: () => void;
  pendingFollowUp: PendingCallFollowUp | null;
  clearPendingFollowUp: () => void;
  /** Reset multi-number retry tracking after remarks are saved or skipped. */
  clearLeadDialSession: () => void;
  /** When true the global PostCallRemarksModal is suppressed (bulk queue handles it). */
  bulkModeActive: boolean;
  setBulkModeActive: (active: boolean) => void;
  placeCall: (leadId: number, contactId?: number, phone?: string) => Promise<CallInitiateResult>;
  placeManualCall: (
    phone: string,
    options?: { contactName?: string; country?: string },
  ) => Promise<CallInitiateResult>;
  hangUp: () => void;
  retryInit: () => Promise<void>;
}

function friendlyCallError(err: unknown): string {
  let raw = "Call failed";
  if (err instanceof Error && err.message) {
    raw = err.message;
  } else if (typeof err === "string" && err.trim()) {
    raw = err;
  } else if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === "string" && msg.trim()) raw = msg;
    else if (msg != null && msg !== "") raw = String(msg);
  }
  if (/31005|gateway in HANGUP|application error/i.test(raw)) {
    return (
      "Call ended before connect (Twilio 31005). Usually the TwiML Voice URL failed, " +
      "the number/country is blocked in Twilio Geo Permissions, or Railway was busy. " +
      "Check Twilio Console → Monitor → Logs, and that the TwiML App Voice URL is " +
      "POST https://YOUR-RAILWAY-API/api/webhooks/twilio/voice/client-dial"
    );
  }
  if (/31000|31002|31003/i.test(raw)) {
    return `${raw}. Check Twilio Debugger and that Voice geo-permissions allow this country.`;
  }
  return raw;
}

const TwilioVoiceContext = createContext<TwilioVoiceContextValue | null>(null);

function normalizePhoneDigits(phone: string | null | undefined): string {
  if (!phone) return "";
  return phone.replace(/\D/g, "");
}

/** True when two phone strings refer to the same dialed number. */
export function phonesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const da = normalizePhoneDigits(a);
  const db = normalizePhoneDigits(b);
  if (!da || !db) return false;
  if (da === db) return true;
  // Match when one is a national form of the other (last 8–12 digits).
  const shorter = da.length <= db.length ? da : db;
  const longer = da.length <= db.length ? db : da;
  return shorter.length >= 8 && longer.endsWith(shorter);
}

export function TwilioVoiceProvider({ children }: { children: ReactNode }) {
  const deviceRef = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);
  const activePrepRef = useRef<CallInitiateResult | null>(null);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(false);
  const [activeCall, setActiveCall] = useState<ActiveCallTarget | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const [pendingFollowUp, setPendingFollowUp] = useState<PendingCallFollowUp | null>(null);

  const [bulkModeActive, setBulkModeActive] = useState(false);
  const leadDialSessionRef = useRef<{ buyerId: number; triedPhones: string[] } | null>(null);

  const clearPendingFollowUp = useCallback(() => {
    setPendingFollowUp(null);
  }, []);

  const clearLeadDialSession = useCallback(() => {
    leadDialSessionRef.current = null;
  }, []);

  const clearCallError = useCallback(() => {
    setCallError(null);
  }, []);

  const refreshToken = useCallback(async (device: Device) => {
    const { token } = await client.getVoiceToken();
    device.updateToken(token);
  }, []);

  const initDevice = useCallback(async () => {
    setInitError(null);
    const cfg = await client.getCallConfig();
    if (!cfg.browser_ready) {
      setReady(false);
      setInitError(cfg.setup_message ?? "Twilio browser calling is not configured");
      return;
    }

    const { token } = await client.getVoiceToken();
    const device = new Device(token, {
      codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
      logLevel: "warn",
    });

    device.on("registered", () => {
      setReady(true);
      setInitError(null);
    });
    device.on("unregistered", () => setReady(false));
    device.on("error", (err) => {
      console.error("Twilio device error:", err);
      const message = err?.message || "Twilio device error";
      // Per-call gateway hangups (31005) must not disable the whole dialer.
      if (/31005|HANGUP/i.test(message)) {
        setCallError(friendlyCallError(err));
        return;
      }
      setInitError(message);
      setReady(false);
    });
    device.on("tokenWillExpire", () => {
      void refreshToken(device);
    });

    deviceRef.current?.destroy();
    deviceRef.current = device;
    await device.register();
    setReady(true);
  }, [refreshToken]);

  // Mount once — do not re-run when callback identities change (would hang up live calls).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await initDevice();
      } catch (e) {
        if (!cancelled) {
          setReady(false);
          const message = e instanceof Error ? e.message : "Failed to initialize calling";
          if (/cannot reach the api|failed to fetch|network/i.test(message)) {
            setInitError("Calling is warming up — refresh in a few seconds if this persists.");
            window.setTimeout(() => {
              if (!cancelled) {
                void initDevice().catch(() => undefined);
              }
            }, 2500);
          } else {
            setInitError(message);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
      callRef.current?.disconnect();
      deviceRef.current?.destroy();
      deviceRef.current = null;
      callRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional mount-once init
  }, []);

  const retryInit = useCallback(async () => {
    try {
      await initDevice();
    } catch (e) {
      setReady(false);
      setInitError(e instanceof Error ? e.message : "Failed to initialize calling");
      throw e;
    }
  }, [initDevice]);

  const hangUp = useCallback(() => {
    const call = callRef.current;
    if (!call) {
      setActive(false);
      setActiveCall(null);
      return;
    }
    // Do not null callRef here — finishCall must see the same Call instance
    // so it can attribute the ended interaction correctly.
    call.disconnect();
    setActive(false);
    setActiveCall(null);
  }, []);

  const connectPreparedCall = useCallback((activeDevice: Device, prep: CallInitiateResult) => {
    activePrepRef.current = prep;
    setCallError(null);

    return activeDevice
      .connect({
        params: {
          To: prep.lead_phone!,
          interaction_id: String(prep.id),
        },
      })
      .then((call) => {
        callRef.current = call;
        setActive(true);
        setActiveCall({
          buyerId: prep.buyer_id ?? null,
          contactId: prep.contact_id ?? null,
          phone: prep.lead_phone ?? null,
        });

        // Capture prep in closure so a later dial cannot steal this call's follow-up.
        const prepForThisCall = prep;
        let finished = false;
        const finishCall = () => {
          if (finished) return;
          finished = true;
          if (callRef.current === call) {
            callRef.current = null;
            setActive(false);
            setActiveCall(null);
          }
          if (activePrepRef.current?.id === prepForThisCall.id) {
            activePrepRef.current = null;
          }
          const buyerId = prepForThisCall.buyer_id ?? null;
          const dialedPhone = prepForThisCall.lead_phone ?? null;
          let triedPhones: string[] = [];
          if (buyerId != null && dialedPhone) {
            const session = leadDialSessionRef.current;
            if (session?.buyerId === buyerId) {
              triedPhones = [...session.triedPhones];
              if (!triedPhones.some((p) => phonesMatch(p, dialedPhone))) {
                triedPhones.push(dialedPhone);
              }
            } else {
              triedPhones = [dialedPhone];
            }
            leadDialSessionRef.current = { buyerId, triedPhones };
          }
          setPendingFollowUp({
            interactionId: prepForThisCall.id,
            label:
              prepForThisCall.company_name ||
              prepForThisCall.contact_name ||
              prepForThisCall.subject?.replace(/^Call to /, "") ||
              "this call",
            buyerId,
            contactId: prepForThisCall.contact_id ?? null,
            dialedPhone,
            triedPhones,
          });
        };
        call.on("error", (err) => {
          console.error("Twilio call error:", err);
          setCallError(friendlyCallError(err));
          // Keep Device registered — a single failed dial is not "calling offline".
        });
        call.on("disconnect", finishCall);
        call.on("cancel", finishCall);

        return prep;
      });
  }, []);

  const placeCall = useCallback(
    async (leadId: number, contactId?: number, phone?: string) => {
      const device = deviceRef.current;
      if (!device) {
        await initDevice();
      }
      const activeDevice = deviceRef.current;
      if (!activeDevice) {
        throw new Error("Twilio calling is not ready. Check your Twilio setup in backend/.env");
      }

      const prep = await client.initiateLeadCall(leadId, {
        contact_id: contactId,
        phone: phone?.trim() || undefined,
      });
      if (!prep.lead_phone) {
        throw new Error("Lead phone number missing");
      }

      return connectPreparedCall(activeDevice, { ...prep, buyer_id: leadId });
    },
    [connectPreparedCall, initDevice],
  );

  const placeManualCall = useCallback(
    async (phone: string, options?: { contactName?: string; country?: string }) => {
      const device = deviceRef.current;
      if (!device) {
        await initDevice();
      }
      const activeDevice = deviceRef.current;
      if (!activeDevice) {
        throw new Error("Twilio calling is not ready. Check your Twilio setup in backend/.env");
      }

      const prep = await client.initiateManualCall({
        phone,
        contact_name: options?.contactName,
        country: options?.country,
      });
      if (!prep.lead_phone) {
        throw new Error("Phone number missing");
      }

      return connectPreparedCall(activeDevice, prep);
    },
    [connectPreparedCall, initDevice],
  );

  return (
    <TwilioVoiceContext.Provider
      value={{
        ready,
        active,
        activeCall,
        initError,
        callError,
        clearCallError,
        pendingFollowUp,
        clearPendingFollowUp,
        clearLeadDialSession,
        bulkModeActive,
        setBulkModeActive,
        placeCall,
        placeManualCall,
        hangUp,
        retryInit,
      }}
    >
      {children}
    </TwilioVoiceContext.Provider>
  );
}

export function useTwilioVoice(): TwilioVoiceContextValue {
  const ctx = useContext(TwilioVoiceContext);
  if (!ctx) {
    throw new Error("useTwilioVoice must be used within TwilioVoiceProvider");
  }
  return ctx;
}

/** Safe hook — returns null when provider is missing (e.g. tests). */
export function useTwilioVoiceOptional(): TwilioVoiceContextValue | null {
  return useContext(TwilioVoiceContext);
}
