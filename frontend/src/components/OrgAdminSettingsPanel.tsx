import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  client,
  type OrgAdminAiSalesAgent,
  type OrgAdminMasterList,
  type OrgAdminUserRow,
} from "../api/client";
import { ActionButton } from "./ui/ActionButton";
import { IconList, IconPlus, IconRobot } from "./icons/AppIcons";

interface OrgAdminSettingsPanelProps {
  onError: (message: string) => void;
}

const ORG_PIN_HINT = "07860";

export function OrgAdminSettingsPanel({ onError }: OrgAdminSettingsPanelProps) {
  const [pin, setPin] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [masterLists, setMasterLists] = useState<OrgAdminMasterList[]>([]);
  const [users, setUsers] = useState<OrgAdminUserRow[]>([]);
  const [userAccess, setUserAccess] = useState<Record<string, string[]>>({});
  const [agents, setAgents] = useState<OrgAdminAiSalesAgent[]>([]);

  const [newListLabel, setNewListLabel] = useState("");
  const [editListKey, setEditListKey] = useState<string | null>(null);
  const [editListLabel, setEditListLabel] = useState("");

  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentFocus, setNewAgentFocus] = useState("");
  const [editAgentId, setEditAgentId] = useState<string | null>(null);
  const [editAgentName, setEditAgentName] = useState("");
  const [editAgentFocus, setEditAgentFocus] = useState("");

  const loadAdmin = useCallback(
    async (accessPin: string) => {
      const data = await client.getOrgAdminMasterListsAdmin(accessPin);
      setMasterLists(data.master_lists || []);
      setUsers(data.users || []);
      setUserAccess(data.user_master_access || {});
      const ag = await client.listOrgAiSalesAgents(false);
      setAgents(ag.agents || []);
    },
    [],
  );

  useEffect(() => {
    if (!unlocked || !pin) return;
    let cancelled = false;
    void loadAdmin(pin).catch((err) => {
      if (!cancelled) onError(err instanceof Error ? err.message : "Failed to load org admin");
    });
    return () => {
      cancelled = true;
    };
  }, [unlocked, pin, loadAdmin, onError]);

  async function handleUnlock(e: FormEvent) {
    e.preventDefault();
    setPinError(null);
    setUnlocking(true);
    try {
      await client.unlockOrgAdmin(pin.trim());
      setUnlocked(true);
      await loadAdmin(pin.trim());
    } catch (err) {
      setPinError(err instanceof Error ? err.message : "Invalid access code");
      setUnlocked(false);
    } finally {
      setUnlocking(false);
    }
  }

  async function saveMasterList(opts: {
    key?: string | null;
    label: string;
    enabled?: boolean;
  }) {
    if (!pin) return;
    setBusy(true);
    try {
      await client.upsertOrgMasterList({
        pin,
        key: opts.key ?? null,
        label: opts.label,
        enabled: opts.enabled ?? true,
      });
      await loadAdmin(pin);
      setNewListLabel("");
      setEditListKey(null);
      setEditListLabel("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save master list");
    } finally {
      setBusy(false);
    }
  }

  async function removeMasterList(key: string) {
    if (!pin) return;
    if (!window.confirm(`Remove master list “${key}”? Built-in lists cannot be deleted.`)) return;
    setBusy(true);
    try {
      await client.deleteOrgMasterList(pin, key);
      await loadAdmin(pin);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not delete master list");
    } finally {
      setBusy(false);
    }
  }

  async function toggleListEnabled(row: OrgAdminMasterList) {
    await saveMasterList({ key: row.key, label: row.label, enabled: !row.enabled });
  }

  async function toggleUserAccess(userId: number, listKey: string, checked: boolean) {
    if (!pin) return;
    const uid = String(userId);
    const current =
      userAccess[uid] ??
      masterLists.filter((m) => m.enabled).map((m) => m.key);
    const next = checked
      ? Array.from(new Set([...current, listKey]))
      : current.filter((k) => k !== listKey);
    setBusy(true);
    try {
      await client.setOrgUserMasterAccess(pin, userId, next);
      setUserAccess((prev) => ({ ...prev, [uid]: next }));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not update user access");
    } finally {
      setBusy(false);
    }
  }

  async function saveAgent(opts: {
    id?: string | null;
    name: string;
    active?: boolean;
    product_focus?: string;
  }) {
    if (!pin) return;
    setBusy(true);
    try {
      await client.upsertOrgAiSalesAgent({
        pin,
        id: opts.id ?? null,
        name: opts.name,
        active: opts.active ?? true,
        product_focus: opts.product_focus ?? "",
      });
      await loadAdmin(pin);
      setNewAgentName("");
      setNewAgentFocus("");
      setEditAgentId(null);
      setEditAgentName("");
      setEditAgentFocus("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save AI Sales Agent");
    } finally {
      setBusy(false);
    }
  }

  async function removeAgent(id: string) {
    if (!pin) return;
    if (!window.confirm("Remove this AI Sales Agent? Sara and Rayan cannot be deleted.")) return;
    setBusy(true);
    try {
      await client.deleteOrgAiSalesAgent(pin, id);
      await loadAdmin(pin);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not remove agent");
    } finally {
      setBusy(false);
    }
  }

  if (!unlocked) {
    return (
      <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-emerald-200">
            Active Master Lists &amp; AI Sales Agents
          </h3>
          <p className="mt-1 text-xs text-slate-400 leading-relaxed">
            Add or edit sidebar master lists, choose which users can open each list, and manage AI
            Sales Agents (Sara, Rayan, and product specialists). Unlock with access code {ORG_PIN_HINT}.
          </p>
        </div>
        <form onSubmit={(e) => void handleUnlock(e)} className="flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1">
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Access code</label>
            <input
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="Enter code…"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 font-mono tracking-widest focus:border-emerald-500 focus:outline-none"
            />
          </div>
          <ActionButton type="submit" icon={IconList} disabled={unlocking || !pin.trim()}>
            {unlocking ? "Unlocking…" : "Unlock"}
          </ActionButton>
        </form>
        {pinError && (
          <p className="text-xs text-red-400 bg-red-950/40 border border-red-900/60 rounded-md px-3 py-1.5">
            {pinError}
          </p>
        )}
      </section>
    );
  }

  const enabledKeys = masterLists.filter((m) => m.enabled).map((m) => m.key);

  return (
    <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5 space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-emerald-200">
            Active Master Lists &amp; AI Sales Agents
          </h3>
          <p className="mt-1 text-xs text-slate-400">
            Unlocked for this session. Changes apply immediately — queues, WhatsApp, email, and Twilio
            are untouched.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setUnlocked(false);
            setPin("");
          }}
          className="text-xs text-slate-400 hover:text-slate-200"
        >
          Lock
        </button>
      </div>

      {/* Master lists */}
      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Active Master List
        </h4>
        <ul className="space-y-2">
          {masterLists.map((row) => (
            <li
              key={row.key}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2"
            >
              {editListKey === row.key ? (
                <>
                  <input
                    value={editListLabel}
                    onChange={(e) => setEditListLabel(e.target.value)}
                    className="flex-1 min-w-[8rem] rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                  />
                  <button
                    type="button"
                    disabled={busy || !editListLabel.trim()}
                    onClick={() =>
                      void saveMasterList({
                        key: row.key,
                        label: editListLabel.trim(),
                        enabled: row.enabled,
                      })
                    }
                    className="text-xs text-emerald-300 hover:text-emerald-200"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditListKey(null)}
                    className="text-xs text-slate-500"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span className="flex-1 min-w-[8rem] text-sm text-slate-100">{row.label}</span>
                  <span className="text-[10px] font-mono text-slate-500">{row.key}</span>
                  <label className="flex items-center gap-1.5 text-xs text-slate-400">
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      disabled={busy}
                      onChange={() => void toggleListEnabled(row)}
                    />
                    Enabled
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setEditListKey(row.key);
                      setEditListLabel(row.label);
                    }}
                    className="text-xs text-sky-300 hover:text-sky-200"
                  >
                    Edit
                  </button>
                  {!["fmcg", "minerals_ores", "other_items"].includes(row.key) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void removeMasterList(row.key)}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      Remove
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <input
            value={newListLabel}
            onChange={(e) => setNewListLabel(e.target.value)}
            placeholder="New list label (e.g. Rice Master)"
            className="flex-1 min-w-[12rem] rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
          />
          <ActionButton
            type="button"
            icon={IconPlus}
            disabled={busy || !newListLabel.trim()}
            onClick={() => void saveMasterList({ label: newListLabel.trim(), enabled: true })}
          >
            Add list
          </ActionButton>
        </div>
      </div>

      {/* User access */}
      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          User access to master lists
        </h4>
        <p className="text-xs text-slate-500">
          Unticked lists are hidden from that user&apos;s sidebar. Admins always see all enabled lists.
          Leave a user unset (all checked by default) to grant every enabled list.
        </p>
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-950/80 text-slate-400">
              <tr>
                <th className="text-left px-3 py-2 font-medium">User</th>
                {masterLists.map((m) => (
                  <th key={m.key} className="text-left px-2 py-2 font-medium whitespace-nowrap">
                    {m.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const uid = String(u.id);
                const assigned = userAccess[uid];
                const effective = assigned ?? enabledKeys;
                const isAdminUser = u.role === "admin";
                return (
                  <tr key={u.id} className="border-t border-slate-800/80">
                    <td className="px-3 py-2 text-slate-200">
                      {u.display_name || u.username}
                      {isAdminUser && (
                        <span className="ml-1 text-[10px] text-slate-500">(admin)</span>
                      )}
                    </td>
                    {masterLists.map((m) => (
                      <td key={m.key} className="px-2 py-2">
                        <input
                          type="checkbox"
                          disabled={busy || isAdminUser || !m.enabled}
                          checked={isAdminUser || effective.includes(m.key)}
                          onChange={(e) =>
                            void toggleUserAccess(u.id, m.key, e.target.checked)
                          }
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* AI Sales Agents */}
      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          AI Sales Agents
        </h4>
        <p className="text-xs text-slate-500">
          Assign product focus (e.g. rice → Rayan, Himalayan salt → a new agent). Inactive agents stay
          in the registry but are not dialable.
        </p>
        <ul className="space-y-2">
          {agents.map((ag) => (
            <li
              key={ag.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2"
            >
              {editAgentId === ag.id ? (
                <>
                  <input
                    value={editAgentName}
                    onChange={(e) => setEditAgentName(e.target.value)}
                    className="min-w-[8rem] flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                    placeholder="Name"
                  />
                  <input
                    value={editAgentFocus}
                    onChange={(e) => setEditAgentFocus(e.target.value)}
                    className="min-w-[8rem] flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                    placeholder="Product focus"
                  />
                  <button
                    type="button"
                    disabled={busy || !editAgentName.trim()}
                    onClick={() =>
                      void saveAgent({
                        id: ag.id,
                        name: editAgentName.trim(),
                        active: ag.active,
                        product_focus: editAgentFocus.trim(),
                      })
                    }
                    className="text-xs text-emerald-300"
                  >
                    Save
                  </button>
                  <button type="button" onClick={() => setEditAgentId(null)} className="text-xs text-slate-500">
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span className="text-sm text-slate-100 font-medium">{ag.name}</span>
                  <span className="text-[10px] font-mono text-slate-500">{ag.id}</span>
                  {ag.product_focus ? (
                    <span className="text-xs text-amber-200/80">Focus: {ag.product_focus}</span>
                  ) : null}
                  <label className="flex items-center gap-1.5 text-xs text-slate-400 ml-auto">
                    <input
                      type="checkbox"
                      checked={ag.active}
                      disabled={busy}
                      onChange={() =>
                        void saveAgent({
                          id: ag.id,
                          name: ag.name,
                          active: !ag.active,
                          product_focus: ag.product_focus,
                        })
                      }
                    />
                    Active
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setEditAgentId(ag.id);
                      setEditAgentName(ag.name);
                      setEditAgentFocus(ag.product_focus || "");
                    }}
                    className="text-xs text-sky-300"
                  >
                    Edit
                  </button>
                  {!ag.protected && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void removeAgent(ag.id)}
                      className="text-xs text-red-400"
                    >
                      Remove
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <input
            value={newAgentName}
            onChange={(e) => setNewAgentName(e.target.value)}
            placeholder="Agent name (e.g. Ayesha)"
            className="min-w-[10rem] flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs"
          />
          <input
            value={newAgentFocus}
            onChange={(e) => setNewAgentFocus(e.target.value)}
            placeholder="Product focus (e.g. Himalayan salt)"
            className="min-w-[10rem] flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs"
          />
          <ActionButton
            type="button"
            icon={IconRobot}
            disabled={busy || !newAgentName.trim()}
            onClick={() =>
              void saveAgent({
                name: newAgentName.trim(),
                product_focus: newAgentFocus.trim(),
                active: true,
              })
            }
          >
            Add agent
          </ActionButton>
        </div>
      </div>
    </section>
  );
}
