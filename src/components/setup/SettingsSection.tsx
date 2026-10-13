"use client";
// Trip settings: names, tees, ghost beer base size, roasts, long drive GPS limits, AI judge,
// push throttle, drink cap. Edited as a draft and saved in one trip.update (only changed fields).
// The commissioner PIN change goes through PUT /api/t/<code>/commissioner (needs signal).
import { useState, type FormEvent } from "react";
import { useClientState } from "@/lib/client/react";
import type { TeeSet } from "@/lib/types";
import { Button, Card, SectionHeader, SegmentedControl, TextField, Toggle, useToast } from "@/components/ui";
import { pinChangeError, sameDraft, settingsDraft, settingsPatch, type SettingsDraft } from "./model";
import { Group, NumberRow, useSetupDispatch } from "./shared";

const TEE_OPTIONS: { value: TeeSet; label: string }[] = [
  { value: "advanced", label: "Advanced" },
  { value: "membership", label: "Membership" },
  { value: "forward", label: "Forward" },
];

/** Height of the floating save bar (without safe area). */
const SAVE_BAR_H = 76;

export function SettingsSection() {
  const view = useClientState((s) => s.view);
  const aiEnabled = useClientState((s) => s.snapshot?.meta.ai_enabled ?? false);
  const pushEnabled = useClientState((s) => s.snapshot?.meta.push_enabled ?? false);
  const dispatch = useSetupDispatch();
  const toast = useToast();
  // Only the fields being edited live here; everything else shows the live saved value, so a
  // change from another phone (or a sync) never gets clobbered by a stale draft.
  const [edits, setEdits] = useState<Partial<SettingsDraft>>({});
  const [showErrors, setShowErrors] = useState(false);
  if (!view) return null;

  const trip = view.trip;
  const current = settingsDraft(trip);
  const draft: SettingsDraft = { ...current, ...edits };
  const { errors, patch } = settingsPatch(trip, draft);
  const dirty = !sameDraft(draft, current);
  const shown = showErrors ? errors : {};
  const errorCount = Object.keys(errors).length;
  const set = <K extends keyof SettingsDraft>(k: K, v: SettingsDraft[K]) => setEdits((e) => ({ ...e, [k]: v }));

  const save = () => {
    setShowErrors(true);
    if (!patch) {
      toast.error(`Fix ${errorCount} thing${errorCount === 1 ? "" : "s"} first.`, { title: "Not saved" });
      return;
    }
    if (Object.keys(patch).length === 0) {
      toast.info("Nothing changed.");
      return;
    }
    if (dispatch({ type: "trip.update", patch }, "Settings bounced")) {
      toast.success("Settings saved. The rules are the rules.", { emoji: "⚙️", id: "settings-saved" });
      setEdits({});
      setShowErrors(false);
    }
  };
  const discard = () => {
    setEdits({});
    setShowErrors(false);
  };

  return (
    <div className="space-y-4" data-testid="setup-settings">
      <SectionHeader title="Settings" subtitle="All of it changeable any time, no redeploy." />

      <Group title="Names">
        <TextField label="App name" value={draft.app_name} onChange={(e) => set("app_name", e.target.value)} error={shown.app_name} maxLength={80} hint="On the Join screen, header and recap card." data-testid="setting-app-name" />
        <TextField label="Trip name" value={draft.name} onChange={(e) => set("name", e.target.value)} error={shown.name} maxLength={80} data-testid="setting-trip-name" />
        <TextField label="Course" value={draft.course_name} onChange={(e) => set("course_name", e.target.value)} error={shown.course_name} maxLength={120} />
        <div className="space-y-1.5">
          <p className="text-sm font-extrabold tracking-wider uppercase">Tees (yardage shown)</p>
          <SegmentedControl options={TEE_OPTIONS} value={draft.tee_set} onChange={(v) => set("tee_set", v)} ariaLabel="Tee set" />
        </div>
      </Group>

      <Group title="Ghost beer">
        <NumberRow
          label="Base team size"
          description={
            draft.base_team_size === 4
              ? "Teams of 3 drink like 4: every 3rd drink counts double."
              : `credit = floor(${draft.base_team_size} × drinks ÷ team size)`
          }
          value={draft.base_team_size}
          min={2}
          max={4}
          onChange={(v) => set("base_team_size", v)}
          error={shown.base_team_size}
          testId="setting-base-size"
        />
        <TextField
          label="Drink cap per player"
          inputMode="numeric"
          placeholder="No cap"
          value={draft.drink_cap}
          onChange={(e) => set("drink_cap", e.target.value.replace(/[^\d]/g, ""))}
          error={shown.drink_cap}
          hint="Blank = no cap (the spec's official position)."
          data-testid="setting-drink-cap"
        />
      </Group>

      <Group title="AI roasts">
        {!aiEnabled && <p className="text-sm font-bold text-muted">AI is off on this server, so only the templated feed lines run. Settings still save.</p>}
        <Toggle checked={draft.roasts_enabled} onChange={(v) => set("roasts_enabled", v)} label="Roasts" description="Fully unhinged. Golf, drinking and decisions only." />
        <NumberRow
          label="Hole gap"
          description={`At most 1 roast per team every ${draft.roast_min_hole_gap} hole${draft.roast_min_hole_gap === 1 ? "" : "s"} (big moments exempt).`}
          value={draft.roast_min_hole_gap}
          min={0}
          max={18}
          onChange={(v) => set("roast_min_hole_gap", v)}
          error={shown.roast_min_hole_gap}
          disabled={!draft.roasts_enabled}
        />
        <NumberRow
          label="Round cap"
          description="Max AI roasts per round (cost control)."
          value={draft.roast_cap}
          min={0}
          max={500}
          step={5}
          onChange={(v) => set("roast_cap", v)}
          error={shown.roast_cap}
          disabled={!draft.roasts_enabled}
        />
      </Group>

      <Group title="Long drive">
        <NumberRow
          label="GPS accuracy limit"
          description="Weaker fixes go to commissioner review."
          value={draft.ld_accuracy_limit_m}
          min={1}
          max={100}
          format={(v) => `${v} m`}
          onChange={(v) => set("ld_accuracy_limit_m", v)}
          error={shown.ld_accuracy_limit_m}
        />
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Min yd"
            inputMode="numeric"
            value={draft.ld_min_yd}
            onChange={(e) => set("ld_min_yd", e.target.value.replace(/[^\d]/g, ""))}
            error={shown.ld_min_yd}
          />
          <TextField
            label="Max yd"
            inputMode="numeric"
            value={draft.ld_max_yd}
            onChange={(e) => set("ld_max_yd", e.target.value.replace(/[^\d]/g, ""))}
            error={shown.ld_max_yd}
          />
        </div>
        <p className="-mt-1 text-sm font-bold text-muted">Drives outside the range get flagged for review.</p>
      </Group>

      <Group title="AI judge (closest to pin)">
        <NumberRow
          label="Suspicious below"
          description={`Claimed distance under ${draft.judge_pct}% of the AI's estimate gets a red flag (ignored when the AI isn't confident).`}
          value={draft.judge_pct}
          min={10}
          max={100}
          step={5}
          format={(v) => `${v}%`}
          onChange={(v) => set("judge_pct", v)}
          error={shown.judge_pct}
        />
      </Group>

      <Group title="Push notifications">
        {!pushEnabled && <p className="text-sm font-bold text-muted">Push isn&apos;t configured on this server. The feed still has everything.</p>}
        <NumberRow
          label="Throttle"
          description="At most 1 push per player every…"
          value={draft.push_throttle_min}
          min={0}
          max={60}
          step={0.5}
          format={(v) => `${v} min`}
          onChange={(v) => set("push_throttle_min", v)}
          error={shown.push_throttle_min}
        />
      </Group>

      <PinChange />

      {dirty && (
        <>
          <div aria-hidden="true" style={{ height: SAVE_BAR_H }} />
          <style>{`:root{--toast-bottom:calc(var(--tabbar-h) + ${SAVE_BAR_H + 10}px) !important}`}</style>
          <div
            className="fixed inset-x-0 z-[35] border-t-2 border-ink bg-paper/95 pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] backdrop-blur"
            style={{ bottom: "calc(var(--tabbar-h) + env(safe-area-inset-bottom, 0px))" }}
            data-testid="settings-save-bar"
          >
            <div className="mx-auto flex max-w-xl items-center gap-2 px-4 py-2" style={{ minHeight: SAVE_BAR_H - 2 }}>
              <Button variant="secondary" size="lg" className="shrink-0" onClick={discard}>
                Discard
              </Button>
              <Button size="lg" full onClick={save} data-testid="settings-save">
                {showErrors && errorCount > 0 ? `Fix ${errorCount} first` : "Save settings"}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function PinChange() {
  const code = useClientState((s) => s.code);
  const online = useClientState((s) => s.online);
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const digits = (v: string) => v.replace(/\D/g, "").slice(0, 12);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = pinChangeError(current, next, again);
    if (problem) {
      setError(problem);
      return;
    }
    if (!online) {
      setError("No signal. Changing the PIN needs one bar.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/t/${encodeURIComponent(code)}/commissioner`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: current, new_pin: next }),
      });
      let body: { error?: unknown } | null = null;
      try {
        body = (await res.json()) as { error?: unknown };
      } catch {
        body = null;
      }
      if (!res.ok) {
        setError(typeof body?.error === "string" ? body.error : `That didn't work (HTTP ${res.status}).`);
        return;
      }
      setCurrent("");
      setNext("");
      setAgain("");
      toast.success("New PIN is live. Don't put it in the group chat.", { emoji: "🔐" });
    } catch {
      setError("Couldn't reach the server. Try again with signal.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3">
      <h3 className="border-b-2 border-ink pb-1 text-sm font-black tracking-[0.12em] uppercase">Commissioner PIN</h3>
      <form onSubmit={submit} className="space-y-3" noValidate>
        <TextField label="Current PIN" type="password" inputMode="numeric" autoComplete="off" value={current} onChange={(e) => setCurrent(digits(e.target.value))} />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="New PIN" type="password" inputMode="numeric" autoComplete="off" value={next} onChange={(e) => setNext(digits(e.target.value))} />
          <TextField label="Again" type="password" inputMode="numeric" autoComplete="off" value={again} onChange={(e) => setAgain(digits(e.target.value))} />
        </div>
        {error && (
          <p role="alert" className="rounded-xl border-2 border-flag bg-flag-soft px-3 py-2 text-base font-extrabold text-ink">
            🚫 {error}
          </p>
        )}
        <Button type="submit" variant="ink" size="lg" full loading={busy} disabled={!current || !next || !again}>
          Change PIN
        </Button>
      </form>
    </Card>
  );
}
