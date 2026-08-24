import React, { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  defineRpc,
  useRpc,
  type PluginAgentPanelProps,
  type PluginContext,
  type PluginSurfaceProps,
} from "@getpaseo/plugin";

const COMPOSER_ACTION_TITLE = "Skeptic Review";
const MESSAGE_ACTION_TITLE = "Skeptic Review this message";
const SUPERVISOR_ACTION_TITLE = "Fleet Supervisor";
const HANDOFF_ACTION_TITLE = "Hand off";

function supervisorStateMessage(on: boolean): string {
  return on
    ? "Fleet Supervisor is watching for session limits again."
    : "Fleet Supervisor will not hand off automatically. Skeptic Review still works.";
}

/* ------------------------------------------------------------------ */
/* Contracts                                                           */
/* ------------------------------------------------------------------ */

/**
 * Payload sent by Paseo's composer and message action slots.
 *
 * This is defined here, not imported from `@paseo/plugin`. The SDK does not
 * export a schema for it — the host builds the object inline at call time in
 * `packages/app/src/plugins/actions.tsx`, so the shape below mirrors that
 * source exactly. Both objects are FLAT; there is no nested `message`.
 *
 * Do not "restore" an import of `PluginActionPayloadSchema`. It does not exist
 * at runtime, and because `@paseo/plugin` is an external in the plugin build,
 * esbuild will not catch it. The value lands as `undefined`, and
 * `plugin-process.ts` then calls `contract.input.parseAsync(...)`, which throws
 * synchronously outside the promise chain that would have reported the error.
 * Nothing is ever sent back and the RPC dies as an opaque 30s timeout.
 */
const PluginActionPayloadSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("latest-context"),
    agentId: z.string(),
    workspaceId: z.string().nullish(),
  }),
  z.object({
    scope: z.literal("message"),
    agentId: z.string(),
    messageId: z.string().nullish(),
    role: z.enum(["user", "assistant"]),
    text: z.string().default(""),
    // Passed through to the bridge untouched; the guard owns their meaning.
    attachments: z.array(z.unknown()).default([]),
    images: z.array(z.unknown()).default([]),
  }),
]);

type PluginActionPayload = z.infer<typeof PluginActionPayloadSchema>;

/**
 * Council review. One contract serves both entry points: the payload is a
 * discriminated union on `scope`, so the handler can tell a composer press
 * ("review the recent context") from a per-message press ("review exactly this
 * message") without a second RPC.
 */
const councilReview = defineRpc({
  name: "council.review",
  input: PluginActionPayloadSchema,
  output: z.object({ message: z.string(), reviewId: z.string().nullable() }),
});

const ModelSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().default(""),
  isDefault: z.boolean().default(false),
  /** True when this model has its own allowance (Fable) rather than sharing the plan's. */
  subscriptionCapped: z.boolean().default(false),
});

const ProviderSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().default(""),
  status: z.string().default("unknown"),
  enabled: z.boolean().default(true),
  models: z.array(ModelSchema).default([]),
});

const fetchCatalog = defineRpc({
  name: "fleet.catalog",
  input: z.object({ refresh: z.boolean().default(false) }),
  output: z.object({ providers: z.array(ProviderSchema), generatedAt: z.string().nullable() }),
});

const WorkerSchema = z
  .object({
    id: z.string(),
    kind: z.string().default("paseo"),
    /** Either "provider" or "provider/model". */
    provider: z.string().default(""),
    modeId: z.string().optional(),
    useFor: z.string().optional(),
    systemPrompt: z.string().optional(),
    lens: z.string().optional(),
  })
  .loose();

type Worker = z.infer<typeof WorkerSchema>;

const ContinuationPolicySchema = z
  .object({
    mode: z.enum(["single-pass", "cycle", "return-to-source"]).default("return-to-source"),
    sameAgentNudges: z.number().int().min(0).max(5).default(1),
    verifyCompletion: z.boolean().default(true),
    reuseSessions: z.boolean().default(true),
    retryDelayMinutes: z.number().min(0).default(15),
    maxCycles: z.number().int().min(0).default(0),
  })
  .loose();

const LocalModelSchema = z
  .object({
    endpoint: z.string().default(""),
    model: z.string().default(""),
  })
  .loose();

/**
 * Every setting Fleet Supervisor reads, so the whole of config.json is editable
 * from inside Paseo and the installer never has to be reopened. Fields are
 * optional with defaults so an older config.json still loads cleanly.
 */
const ConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    autoStart: z.boolean().default(true),
    autoHandoff: z.boolean().default(true),
    daemonUrl: z.string().default("ws://127.0.0.1:6767/ws"),
    onlyRootClaudeAgents: z.boolean().default(true),
    catchUpWindowMinutes: z.number().min(0).default(240),
    recentTimelineEntries: z.number().int().min(20).max(200).default(100),
    recentContextCharacters: z.number().int().min(1000).default(28000),
    continuationPolicy: ContinuationPolicySchema.default({
      mode: "return-to-source",
      sameAgentNudges: 1,
      verifyCompletion: true,
      reuseSessions: true,
      retryDelayMinutes: 15,
      maxCycles: 0,
    }),
    fallbackOrder: z.array(WorkerSchema).default([]),
    council: z
      .object({
        enabled: z.boolean().default(true),
        members: z.array(WorkerSchema).default([]),
        maxContextCharacters: z.number().int().min(1000).default(32000),
      })
      .loose()
      .default({ enabled: true, members: [], maxContextCharacters: 32000 }),
    localModel: LocalModelSchema.optional(),
  })
  .loose();

type FleetConfig = z.infer<typeof ConfigSchema>;

const CONTINUATION_MODES = [
  {
    id: "return-to-source",
    label: "Return to Claude",
    hint: "Hand off, then retry the original Claude task after the cooldown.",
  },
  {
    id: "cycle",
    label: "Cycle fallbacks",
    hint: "Keep moving down the list; come back around when it runs out.",
  },
  {
    id: "single-pass",
    label: "Stop after one pass",
    hint: "Try each fallback once, then stop and report.",
  },
] as const;

/** Reasonable presets so a fresh entry starts usable rather than blank. */
const NEW_FALLBACK_ENTRY: Worker = { id: "", kind: "paseo", provider: "codex", modeId: "auto-review" };
const NEW_COUNCIL_MEMBER: Worker = { id: "", kind: "paseo", provider: "codex", lens: "skepticism" };

function freshId(prefix: string, existing: readonly Worker[]): string {
  const taken = new Set(existing.map((entry) => entry.id));
  let index = existing.length + 1;
  while (taken.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

const fetchConfig = defineRpc({
  name: "fleet.config.get",
  input: z.object({}),
  output: z.object({ config: ConfigSchema }),
});

/**
 * Flip automatic handoff without opening settings. Council reviews are a manual
 * action and keep working either way, so this only governs whether Fleet
 * Supervisor reacts to a session limit on its own.
 */
/**
 * Hand the current task to the fleet on demand, without waiting for a session
 * limit. `workerId` picks which fallback entry to start from; empty means the
 * first. The current turn is stopped first so two agents never work the same
 * task at once.
 */
const manualHandoff = defineRpc({
  name: "fleet.handoff",
  input: z.object({
    agentId: z.string(),
    workerId: z.string().default(""),
    reason: z.string().default(""),
  }),
  output: z.object({ message: z.string(), worker: z.string() }),
});

/**
 * Native-slot variant: the host supplies a PluginActionPayload, from which the
 * agent id is taken. Always hands to the next entry in order.
 */
const manualHandoffFromComposer = defineRpc({
  name: "fleet.handoff.composer",
  input: PluginActionPayloadSchema,
  output: z.object({ message: z.string() }),
});

const toggleAutoHandoff = defineRpc({
  name: "fleet.auto-handoff.toggle",
  input: z.object({ enabled: z.boolean().nullable().default(null) }),
  output: z.object({ autoHandoff: z.boolean(), message: z.string() }),
});

/**
 * Read-only companion to `toggleAutoHandoff`. The host calls this to tint the
 * toolbar button green (watching) or red (not watching). Deliberately separate
 * from the toggle so that merely rendering the button can never flip the state.
 */
const supervisorState = defineRpc({
  name: "fleet.auto-handoff.state",
  input: z.object({}),
  output: z.object({ active: z.boolean() }),
});

const saveConfig = defineRpc({
  name: "fleet.config.save",
  input: z.object({ config: z.unknown() }),
  output: z.object({ config: ConfigSchema }),
});

/* ------------------------------------------------------------------ */
/* Roles                                                               */
/* ------------------------------------------------------------------ */

const ROLE_OPTIONS = [
  { id: "custom", label: "Custom system prompt" },
  { id: "reporting-progress", label: "Reporting progress" },
  { id: "bug-checking", label: "Bug checking" },
  { id: "qa", label: "QA" },
  { id: "skepticism", label: "Skepticism" },
] as const;

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

const ThemeSchema = z.object({
  colors: z
    .object({
      surface0: z.string().default("#111111"),
      foreground: z.string().default("#f5f5f5"),
      foregroundMuted: z.string().default("#9b9b9b"),
      accent: z.string().default("#4f8cff"),
      accentForeground: z.string().default("#ffffff"),
      statusDanger: z.string().default("#ff6b6b"),
    })
    .loose(),
});

/**
 * Paseo's `PluginTheme` supplies exactly six colours (see PluginTheme in the
 * SDK). It does NOT provide raised surfaces or a border, so those are derived
 * by blending the foreground into the background.
 *
 * Deriving rather than hard-coding matters: fixed dark defaults looked correct
 * in Paseo's dark theme and unreadable in its light one. Blending follows
 * whichever theme the host is actually in.
 */
type Palette = z.infer<typeof ThemeSchema>["colors"] & {
  surface1: string;
  surface2: string;
  border: string;
};

function parseHex(value: string): [number, number, number] | null {
  const hex = value.trim().replace(/^#/, "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** Blend `amount` of `over` into `base`; falls back to `base` on odd input. */
function mix(base: string, over: string, amount: number): string {
  const a = parseHex(base);
  const b = parseHex(over);
  if (!a || !b) return base;
  const channel = (i: number) => Math.round(a[i] + (b[i] - a[i]) * amount);
  return `#${[0, 1, 2].map((i) => channel(i).toString(16).padStart(2, "0")).join("")}`;
}

function readPalette(theme: unknown): Palette {
  const parsed = ThemeSchema.safeParse(theme);
  const colors = parsed.success ? parsed.data.colors : ThemeSchema.parse({ colors: {} }).colors;
  return {
    ...colors,
    surface1: mix(colors.surface0, colors.foreground, 0.05),
    surface2: mix(colors.surface0, colors.foreground, 0.1),
    border: mix(colors.surface0, colors.foreground, 0.2),
  };
}

/* ------------------------------------------------------------------ */
/* Small primitives                                                    */
/* ------------------------------------------------------------------ */

function splitProviderModel(spec: string): { provider: string; model: string | null } {
  const index = String(spec ?? "").indexOf("/");
  if (index < 0) return { provider: String(spec ?? ""), model: null };
  return { provider: spec.slice(0, index), model: spec.slice(index + 1) || null };
}

function joinProviderModel(provider: string, model: string | null): string {
  return model ? `${provider}/${model}` : provider;
}

function Chip({
  label,
  selected,
  onPress,
  colors,
  subtitle,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  colors: Palette;
  subtitle?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={{
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: selected ? colors.accent : colors.border,
        backgroundColor: selected ? colors.accent : "transparent",
      }}
    >
      <Text style={{ color: selected ? colors.accentForeground : colors.foreground, fontSize: 13 }}>
        {label}
      </Text>
      {subtitle ? (
        <Text
          style={{
            color: selected ? colors.accentForeground : colors.foregroundMuted,
            fontSize: 11,
            marginTop: 2,
          }}
        >
          {subtitle}
        </Text>
      ) : null}
    </Pressable>
  );
}

function Card({
  children,
  colors,
}: {
  children: React.ReactNode;
  colors: Palette;
}) {
  return (
    <View
      style={{
        backgroundColor: colors.surface1,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: colors.border,
        padding: 14,
        gap: 12,
      }}
    >
      {children}
    </View>
  );
}

function SectionHeader({
  title,
  hint,
  colors,
}: {
  title: string;
  hint: string;
  colors: Palette;
}) {
  return (
    <View style={{ gap: 4, marginTop: 6 }}>
      <Text style={{ color: colors.foreground, fontSize: 19, fontWeight: "600" }}>{title}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{hint}</Text>
    </View>
  );
}

/** A labelled switch row: the same shape for every boolean in the config. */
function SwitchRow({
  label,
  hint,
  value,
  onChange,
  colors,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  colors: Palette;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.foreground, fontSize: 13 }}>{label}</Text>
        {hint ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{hint}</Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * A numeric field. Keeps the raw text while the user types so an in-progress
 * value like "1" on the way to "15" is not clamped mid-keystroke; commits on
 * blur, and only if the result parses.
 */
function NumberField({
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
  colors,
}: {
  label: string;
  hint?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (next: number) => void;
  colors: Palette;
}) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  const shown = focused ? text : String(value);
  const commit = () => {
    setFocused(false);
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return;
    let next = step === 1 ? Math.round(parsed) : parsed;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    if (next !== value) onChange(next);
  };
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: colors.foreground, fontSize: 13 }}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <TextInput
          value={shown}
          onChangeText={setText}
          onFocus={() => {
            setText(String(value));
            setFocused(true);
          }}
          onBlur={commit}
          keyboardType="numeric"
          inputMode="decimal"
          accessibilityLabel={label}
          style={{
            width: 96,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface2,
            color: colors.foreground,
            paddingVertical: 6,
            paddingHorizontal: 10,
            fontSize: 13,
          }}
        />
        {unit ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{unit}</Text> : null}
      </View>
      {hint ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{hint}</Text>
      ) : null}
    </View>
  );
}

function TextField({
  label,
  hint,
  value,
  placeholder,
  onChange,
  colors,
  monospace = false,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  onChange: (next: string) => void;
  colors: Palette;
  monospace?: boolean;
}) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: colors.foreground, fontSize: 13 }}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={label}
        style={{
          borderRadius: 8,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface2,
          color: colors.foreground,
          paddingVertical: 7,
          paddingHorizontal: 10,
          fontSize: 13,
          fontFamily: monospace ? "monospace" : undefined,
        }}
      />
      {hint ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{hint}</Text>
      ) : null}
    </View>
  );
}

/** Small text button for row-level actions: move up/down, remove, add. */
function LinkButton({
  label,
  onPress,
  colors,
  disabled = false,
  destructive = false,
}: {
  label: string;
  onPress: () => void;
  colors: Palette;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ paddingVertical: 4, paddingHorizontal: 8, opacity: disabled ? 0.35 : 1 }}
    >
      <Text
        style={{
          color: destructive ? colors.statusDanger : colors.accent,
          fontSize: 12,
          fontWeight: "500",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */
/* Model tree                                                          */
/* ------------------------------------------------------------------ */

/**
 * Advisory shown beside an entry, derived from what precedes it in the chain.
 *
 * `null` = nothing worth saying. Otherwise a short note. This is guidance only:
 * it never removes a choice, because a chain can be built for many reasons and
 * the tool should not decide which handoffs are "sensible" on the user's behalf.
 */
function chainAdvice(input: {
  isFirst: boolean;
  previousProvider: string | null;
  previousCapped: boolean;
  selectedProvider: string;
  selectedCapped: boolean;
}): string | null {
  const { isFirst, previousProvider, previousCapped, selectedProvider, selectedCapped } = input;
  if (isFirst) {
    // The first entry is the source. Fable is the interesting case.
    if (selectedProvider === "claude" && selectedCapped) {
      return "Fable has its own weekly allowance. When it runs out, the rest of the plan is still usable, so another Claude model can take over next.";
    }
    if (selectedProvider === "claude") {
      return "This model shares the whole plan's allowance. When it hits a limit, other Claude models are usually limited too, so a different provider is the safer next step.";
    }
    return null;
  }
  // A later entry: only comment on Claude → Claude, since that is where the cap
  // question actually bites.
  if (selectedProvider === "claude" && previousProvider === "claude" && !previousCapped) {
    return "The previous entry is also a Claude model on the shared plan. If it hit a limit, this one likely will too. Fine as a deliberate choice; not a reliable fallback.";
  }
  return null;
}

/**
 * The model picker for one entry in the chain. Every provider and every
 * discovered model is always selectable; `chainAdvice` explains the cap
 * situation beside it without taking any option away.
 */
function ModelTree({
  providers,
  value,
  onChange,
  colors,
  advice,
}: {
  providers: z.infer<typeof ProviderSchema>[];
  value: string;
  onChange: (next: string) => void;
  colors: Palette;
  advice: string | null;
}) {
  const { provider: selectedProvider, model: selectedModel } = splitProviderModel(value);
  const shown = providers.find((provider) => provider.id === selectedProvider);
  const [picking, setPicking] = useState(false);

  // An entry whose provider is empty, or names something Paseo does not have
  // installed, cannot run at all. Those must show the picker open — a collapsed
  // row would read as "already chosen" when nothing usable is selected.
  const unusable = !selectedProvider || !shown;
  const showPicker = picking || unusable;

  return (
    <View style={{ gap: 10 }}>
      {showPicker ? (
        <View style={{ gap: 6 }}>
          {unusable ? (
            <Text style={{ color: colors.statusDanger, fontSize: 12 }}>
              {selectedProvider
                ? `This entry is set to "${selectedProvider}", which Paseo does not have installed. It will be skipped. Choose a provider below.`
                : "This entry has no provider, so it will be skipped. Choose one below."}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {providers.map((provider) => (
              <Chip
                key={provider.id}
                colors={colors}
                selected={provider.id === selectedProvider}
                label={provider.label}
                subtitle={provider.status === "ready" ? undefined : provider.status}
                onPress={() => {
                  onChange(joinProviderModel(provider.id, null));
                  setPicking(false);
                }}
              />
            ))}
          </View>
        </View>
      ) : (
        // Once a provider is chosen the full grid is just noise — the entry
        // already says what it is. Collapse to the choice plus a way back.
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Provider</Text>
          <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>
            {shown?.label ?? selectedProvider}
          </Text>
          <LinkButton label="Change provider" colors={colors} onPress={() => setPicking(true)} />
        </View>
      )}

      {shown ? (
        shown.models.length === 0 ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
            {shown.status === "ready"
              ? "This provider reports no selectable models."
              : `Sign in to ${shown.label} to see its models. Fleet Supervisor will use the provider default until then.`}
          </Text>
        ) : (
          <View style={{ gap: 8 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
              Models available from {shown.label}
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Chip
                colors={colors}
                selected={selectedModel === null}
                label="Provider default"
                onPress={() => onChange(joinProviderModel(shown.id, null))}
              />
              {shown.models.map((model) => (
                <Chip
                  key={model.id}
                  colors={colors}
                  selected={selectedModel === model.id}
                  label={model.label}
                  subtitle={model.subscriptionCapped ? "separate weekly cap" : undefined}
                  onPress={() => onChange(joinProviderModel(shown.id, model.id))}
                />
              ))}
            </View>
          </View>
        )
      ) : null}

      {advice ? (
        <View style={{ backgroundColor: colors.surface2, borderRadius: 10, padding: 12 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
            {advice}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* "Use for:" role control                                             */
/* ------------------------------------------------------------------ */

function UseForControl({
  useFor,
  systemPrompt,
  onChange,
  colors,
}: {
  useFor: string | undefined;
  systemPrompt: string | undefined;
  onChange: (next: { useFor?: string; systemPrompt?: string }) => void;
  colors: Palette;
}) {
  const enabled = Boolean(useFor);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Switch
          value={enabled}
          onValueChange={(next) =>
            onChange(next ? { useFor: "skepticism" } : { useFor: undefined, systemPrompt: undefined })
          }
          accessibilityLabel="Use for"
        />
        <Text style={{ color: colors.foreground, fontSize: 13 }}>Use for:</Text>
        {!enabled ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
            no model-specific role
          </Text>
        ) : null}
      </View>

      {enabled ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {ROLE_OPTIONS.map((option) => (
            <Chip
              key={option.id}
              colors={colors}
              selected={useFor === option.id}
              label={option.label}
              onPress={() => onChange({ useFor: option.id })}
            />
          ))}
        </View>
      ) : null}

      {enabled && useFor === "custom" ? (
        <TextInput
          multiline
          value={systemPrompt ?? ""}
          onChangeText={(text) => onChange({ useFor: "custom", systemPrompt: text })}
          placeholder="This runs as the highest-priority instruction every time Fleet Supervisor hands off to this model."
          placeholderTextColor={colors.foregroundMuted}
          style={{
            minHeight: 78,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface2,
            color: colors.foreground,
            padding: 10,
            fontSize: 13,
            textAlignVertical: "top",
          }}
        />
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Surface                                                             */
/* ------------------------------------------------------------------ */


function FleetSettingsSurface({ theme }: PluginSurfaceProps) {
  const colors = readPalette(theme);
  const callCatalog = useRpc(fetchCatalog);
  const callConfig = useRpc(fetchConfig);
  const callSave = useRpc(saveConfig);
  const queryClient = useQueryClient();

  const catalog = useQuery({
    queryKey: ["fleet", "catalog"],
    queryFn: () => callCatalog({ refresh: false }),
    staleTime: 60_000,
    // Providers report "loading" for a while after the daemon starts. Poll
    // until they settle so the model tree fills in without a manual reload.
    refetchInterval: (query) =>
      query.state.data?.providers.some((provider) => provider.status === "loading")
        ? 3_000
        : false,
  });
  const configQuery = useQuery({
    queryKey: ["fleet", "config"],
    queryFn: () => callConfig({}),
    staleTime: 5_000,
  });

  const [draft, setDraft] = useState<FleetConfig | null>(null);
  const current = draft ?? configQuery.data?.config ?? null;

  const save = useMutation({
    mutationFn: () => callSave({ config: current }),
    onSuccess: (result) => {
      setDraft(null);
      queryClient.setQueryData(["fleet", "config"], result);
    },
  });

  const providers = catalog.data?.providers ?? [];

  /** All edits go through here so the draft always derives from a real base. */
  const edit = useCallback(
    (mutate: (base: FleetConfig) => FleetConfig) => {
      setDraft((previous) => {
        const base = previous ?? configQuery.data?.config;
        return base ? mutate(base) : previous;
      });
    },
    [configQuery.data],
  );

  const setField = useCallback(
    <Key extends keyof FleetConfig>(key: Key, value: FleetConfig[Key]) =>
      edit((base) => ({ ...base, [key]: value })),
    [edit],
  );

  const setPolicy = useCallback(
    (patch: Partial<FleetConfig["continuationPolicy"]>) =>
      edit((base) => ({
        ...base,
        continuationPolicy: { ...base.continuationPolicy, ...patch },
      })),
    [edit],
  );

  const setCouncil = useCallback(
    (patch: Partial<FleetConfig["council"]>) =>
      edit((base) => ({ ...base, council: { ...base.council, ...patch } })),
    [edit],
  );

  /**
   * An empty reviewer list does NOT mean zero reviewers. The guard falls back to
   * the first three usable fallback entries — see `councilMembers()` in
   * fleet-guard.mjs. This mirrors that rule so the surface can show what will
   * actually run instead of an empty list. Keep the two in step.
   */
  const inheritedReviewers = useMemo(
    () =>
      (current?.fallbackOrder ?? [])
        .filter((worker) => (worker.kind ?? "paseo") === "paseo" && worker.provider)
        .slice(0, 3),
    [current?.fallbackOrder],
  );

  const setLocalModel = useCallback(
    (patch: Partial<NonNullable<FleetConfig["localModel"]>>) =>
      edit((base) => ({
        ...base,
        localModel: { endpoint: "", model: "", ...(base.localModel ?? {}), ...patch },
      })),
    [edit],
  );

  // --- list editing, shared by fallback entries and council members --------
  type ListKey = "fallbackOrder" | "council";
  const readList = (base: FleetConfig, key: ListKey): Worker[] =>
    key === "fallbackOrder" ? base.fallbackOrder : base.council.members;
  const writeList = (base: FleetConfig, key: ListKey, next: Worker[]): FleetConfig =>
    key === "fallbackOrder"
      ? { ...base, fallbackOrder: next }
      : { ...base, council: { ...base.council, members: next } };

  const updateWorker = useCallback(
    (key: ListKey, index: number, patch: Partial<Worker>) =>
      edit((base) =>
        writeList(
          base,
          key,
          readList(base, key).map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
        ),
      ),
    [edit],
  );
  const moveWorker = useCallback(
    (key: ListKey, index: number, delta: -1 | 1) =>
      edit((base) => {
        const list = [...readList(base, key)];
        const target = index + delta;
        if (target < 0 || target >= list.length) return base;
        [list[index], list[target]] = [list[target]!, list[index]!];
        return writeList(base, key, list);
      }),
    [edit],
  );
  const removeWorker = useCallback(
    (key: ListKey, index: number) =>
      edit((base) =>
        writeList(
          base,
          key,
          readList(base, key).filter((_, i) => i !== index),
        ),
      ),
    [edit],
  );
  const addWorker = useCallback(
    (key: ListKey) =>
      edit((base) => {
        const list = readList(base, key);
        const template = key === "fallbackOrder" ? NEW_FALLBACK_ENTRY : NEW_COUNCIL_MEMBER;
        const prefix = key === "fallbackOrder" ? "fallback" : "reviewer";
        return writeList(base, key, [...list, { ...template, id: freshId(prefix, list) }]);
      }),
    [edit],
  );

  if (catalog.isPending || configQuery.isPending) {
    return (
      <View style={{ flex: 1, padding: 24, backgroundColor: colors.surface0 }}>
        <Text style={{ color: colors.foregroundMuted }}>Loading Fleet Supervisor settings…</Text>
      </View>
    );
  }

  const loadError = catalog.error ?? configQuery.error;
  if (loadError || !current) {
    return (
      <View style={{ flex: 1, padding: 24, gap: 10, backgroundColor: colors.surface0 }}>
        <Text style={{ color: colors.statusDanger, fontSize: 15 }}>
          Fleet Supervisor is not reachable.
        </Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>
          {loadError instanceof Error ? loadError.message : "Start Paseo with Fleet Supervisor."}
        </Text>
      </View>
    );
  }

  const policy = current.continuationPolicy;
  const isPersistent = policy.mode !== "single-pass";

  const isCapped = (spec: string): boolean => {
    const { provider, model } = splitProviderModel(spec);
    return (
      providers
        .find((candidate) => candidate.id === provider)
        ?.models.find((candidate) => candidate.id === model)?.subscriptionCapped ?? false
    );
  };

  const renderWorkerCard = (
    key: ListKey,
    worker: Worker,
    index: number,
    total: number,
    previous: Worker | null,
  ) => {
    const spec = String(worker.provider ?? "");
    const { provider, model } = splitProviderModel(spec);
    const providerEntry = providers.find((candidate) => candidate.id === provider);
    const modelEntry = providerEntry?.models.find((candidate) => candidate.id === model);
    const isCouncil = key === "council";
    // Council members are peers, not a chain, so no cap advice applies there.
    const advice = isCouncil
      ? null
      : chainAdvice({
          isFirst: index === 0,
          previousProvider: previous ? splitProviderModel(String(previous.provider ?? "")).provider : null,
          previousCapped: previous ? isCapped(String(previous.provider ?? "")) : false,
          selectedProvider: provider,
          selectedCapped: modelEntry?.subscriptionCapped ?? false,
        });
    return (
      <Card key={`${key}-${index}`} colors={colors}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {!isCouncil ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{index + 1}</Text>
          ) : null}
          <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }}>
            {providerEntry?.label ?? worker.id}
          </Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, flex: 1 }}>
            {modelEntry?.label ?? "provider default"}
          </Text>
          <LinkButton
            label="Up"
            colors={colors}
            disabled={index === 0}
            onPress={() => moveWorker(key, index, -1)}
          />
          <LinkButton
            label="Down"
            colors={colors}
            disabled={index === total - 1}
            onPress={() => moveWorker(key, index, 1)}
          />
          <LinkButton
            label="Remove"
            colors={colors}
            destructive
            onPress={() => removeWorker(key, index)}
          />
        </View>
        <ModelTree
          providers={providers}
          value={spec}
          colors={colors}
          advice={advice}
          onChange={(next) => updateWorker(key, index, { provider: next })}
        />
        <UseForControl
          colors={colors}
          useFor={isCouncil ? worker.lens : worker.useFor}
          systemPrompt={worker.systemPrompt}
          onChange={(patch) =>
            updateWorker(
              key,
              index,
              isCouncil
                ? { lens: patch.useFor, systemPrompt: patch.systemPrompt }
                : patch,
            )
          }
        />
      </Card>
    );
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.surface0 }}
      contentContainerStyle={{ padding: 20, gap: 18, paddingBottom: 96 }}
    >
      {/* ---------------------------------------------------------------- */}
      <SectionHeader
        colors={colors}
        title="Fleet Supervisor"
        hint="Everything Fleet Supervisor reads lives here. Nothing needs the installer once it is set up."
      />
      <Card colors={colors}>
        <SwitchRow
          colors={colors}
          label="Enabled"
          hint="Off, and Fleet Supervisor exits at the next Paseo start instead of attaching."
          value={current.enabled}
          onChange={(next) => setField("enabled", next)}
        />
        <SwitchRow
          colors={colors}
          label="Start with Paseo"
          hint="Launch Fleet Supervisor automatically when Paseo loads this plugin."
          value={current.autoStart}
          onChange={(next) => setField("autoStart", next)}
        />
        <SwitchRow
          colors={colors}
          label="Automatic handoff"
          hint="React to session limits on your own. Same switch as the toolbar button; Council reviews work either way."
          value={current.autoHandoff}
          onChange={(next) => setField("autoHandoff", next)}
        />
        <SwitchRow
          colors={colors}
          label="Only watch root Claude tasks"
          hint="Ignore Claude subagents so a handoff never fires from inside another agent's delegated work."
          value={current.onlyRootClaudeAgents}
          onChange={(next) => setField("onlyRootClaudeAgents", next)}
        />
      </Card>

      {/* ---------------------------------------------------------------- */}
      <SectionHeader
        colors={colors}
        title="Set fallback order"
        hint="Entry 1 is the model you start with. When it runs out of session allowance, Fleet Supervisor hands the task to entry 2, then 3, and so on. Every entry can be any provider and any exact model — pick Fable, Opus, a specific OpenAI or Cursor model, whatever fits — and, optionally, what that model is for."
      />
      {current.fallbackOrder.length === 0 ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>
          No fallback entries configured yet.
        </Text>
      ) : null}
      {current.fallbackOrder.map((worker, index) =>
        renderWorkerCard(
          "fallbackOrder",
          worker,
          index,
          current.fallbackOrder.length,
          index > 0 ? (current.fallbackOrder[index - 1] ?? null) : null,
        ),
      )}
      <View style={{ alignSelf: "flex-start" }}>
        <LinkButton
          label="+ Add fallback entry"
          colors={colors}
          onPress={() => addWorker("fallbackOrder")}
        />
      </View>

      {/* ---------------------------------------------------------------- */}
      <SectionHeader
        colors={colors}
        title="What happens after a handoff"
        hint="How Fleet Supervisor behaves once the first fallback has run."
      />
      <Card colors={colors}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {CONTINUATION_MODES.map((mode) => (
            <Chip
              key={mode.id}
              colors={colors}
              selected={policy.mode === mode.id}
              label={mode.label}
              onPress={() => setPolicy({ mode: mode.id })}
            />
          ))}
        </View>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
          {CONTINUATION_MODES.find((mode) => mode.id === policy.mode)?.hint}
        </Text>
        <SwitchRow
          colors={colors}
          label="Verify completion claims"
          hint="Send one audit prompt when a fallback says it is done, before believing it."
          value={policy.verifyCompletion}
          onChange={(next) => setPolicy({ verifyCompletion: next })}
        />
        <SwitchRow
          colors={colors}
          label="Reuse fallback sessions"
          hint="On later cycles, continue the same child task instead of starting a new one."
          value={policy.reuseSessions}
          onChange={(next) => setPolicy({ reuseSessions: next })}
        />
        <NumberField
          colors={colors}
          label="Nudges before moving on"
          hint="How many times to prompt the same fallback when it reports itself blocked."
          value={policy.sameAgentNudges}
          min={0}
          max={5}
          onChange={(next) => setPolicy({ sameAgentNudges: next })}
        />
        {isPersistent ? (
          <>
            <NumberField
              colors={colors}
              label="Cooldown before retrying Claude"
              value={policy.retryDelayMinutes}
              min={0}
              unit="minutes"
              onChange={(next) => setPolicy({ retryDelayMinutes: next })}
            />
            <NumberField
              colors={colors}
              label="Maximum cycles"
              hint="0 means keep going until the task finishes or Paseo quits."
              value={policy.maxCycles}
              min={0}
              onChange={(next) => setPolicy({ maxCycles: next })}
            />
          </>
        ) : null}
      </Card>

      {/* ---------------------------------------------------------------- */}
      <SectionHeader
        colors={colors}
        title="Skeptic Review"
        hint="Reviewers used by the Skeptic Review button and the per-message consensus icon. They are review-only and never continue the task, so their roles are kept separate from the handoff roles above."
      />
      <Card colors={colors}>
        <SwitchRow
          colors={colors}
          label="Skeptic Review enabled"
          value={current.council.enabled}
          onChange={(next) => setCouncil({ enabled: next })}
        />
        <NumberField
          colors={colors}
          label="Context sent to reviewers"
          hint="Upper bound on the recent-context excerpt each reviewer receives."
          value={current.council.maxContextCharacters}
          min={1000}
          step={1000}
          unit="characters"
          onChange={(next) => setCouncil({ maxContextCharacters: next })}
        />
      </Card>

      {/* An empty list is not "no reviewers" — the guard borrows the first three
          fallback entries. Show that, rather than leaving the user guessing. */}
      {current.council.members.length === 0 ? (
        <Card colors={colors}>
          <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>
            No reviewers set — inheriting from your fallback order
          </Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
            Skeptic Review is using the first three usable entries from Set fallback order above.
            Adding a reviewer here replaces this inherited list entirely.
          </Text>
          <View style={{ gap: 6, marginTop: 6 }}>
            {inheritedReviewers.length === 0 ? (
              <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                Your fallback order has no usable entries, so Skeptic Review currently has no
                reviewers and will fail. Add one below.
              </Text>
            ) : (
              inheritedReviewers.map((worker, index) => {
                const split = splitProviderModel(worker.provider);
                const known = providers.find((entry) => entry.id === split.provider);
                return (
                  <Text
                    key={`inherited-${worker.id}-${index}`}
                    style={{ color: colors.foregroundMuted, fontSize: 12 }}
                  >
                    {`${index + 1}. ${known?.label ?? split.provider} — ${
                      split.model ?? "provider default"
                    }${known ? "" : "   ⚠ not installed; this reviewer will fail"}`}
                  </Text>
                );
              })
            )}
          </View>
          {inheritedReviewers.length > 0 ? (
            <View style={{ alignSelf: "flex-start", marginTop: 8 }}>
              <LinkButton
                label="Make these explicit so I can edit them"
                colors={colors}
                onPress={() =>
                  setCouncil({
                    members: inheritedReviewers.map((worker) => ({
                      ...worker,
                      lens: worker.lens ?? "skepticism",
                    })),
                  })
                }
              />
            </View>
          ) : null}
        </Card>
      ) : (
        current.council.members.map((member, index) =>
          renderWorkerCard("council", member, index, current.council.members.length, null),
        )
      )}
      <View style={{ alignSelf: "flex-start" }}>
        <LinkButton label="+ Add reviewer" colors={colors} onPress={() => addWorker("council")} />
      </View>

      {/* ---------------------------------------------------------------- */}
      <SectionHeader
        colors={colors}
        title="Local model"
        hint="A same-PC Ollama, LM Studio, llama.cpp or other OpenAI-compatible server, used through a Fleet-only OpenCode profile. Loopback addresses only."
      />
      <Card colors={colors}>
        <TextField
          colors={colors}
          label="Endpoint"
          placeholder="http://127.0.0.1:11434/v1"
          value={current.localModel?.endpoint ?? ""}
          onChange={(next) => setLocalModel({ endpoint: next })}
          monospace
        />
        <TextField
          colors={colors}
          label="Model"
          placeholder="qwen2.5-coder:14b"
          value={current.localModel?.model ?? ""}
          onChange={(next) => setLocalModel({ model: next })}
          monospace
        />
      </Card>

      {/* ---------------------------------------------------------------- */}
      <SectionHeader
        colors={colors}
        title="Advanced"
        hint="Defaults are right for almost everyone. Change these only if you know why."
      />
      <Card colors={colors}>
        <TextField
          colors={colors}
          label="Paseo daemon URL"
          value={current.daemonUrl}
          onChange={(next) => setField("daemonUrl", next)}
          monospace
        />
        <NumberField
          colors={colors}
          label="Catch-up window"
          hint="On start, how far back to look for a session limit that fired while Fleet Supervisor was not running."
          value={current.catchUpWindowMinutes}
          min={0}
          unit="minutes"
          onChange={(next) => setField("catchUpWindowMinutes", next)}
        />
        <NumberField
          colors={colors}
          label="Timeline entries inspected"
          value={current.recentTimelineEntries}
          min={20}
          max={200}
          onChange={(next) => setField("recentTimelineEntries", next)}
        />
        <NumberField
          colors={colors}
          label="Context passed to fallbacks"
          value={current.recentContextCharacters}
          min={1000}
          step={1000}
          unit="characters"
          onChange={(next) => setField("recentContextCharacters", next)}
        />
      </Card>

      {/* ---------------------------------------------------------------- */}
      <Pressable
        onPress={() => save.mutate()}
        disabled={save.isPending || draft === null}
        accessibilityRole="button"
        style={{
          marginTop: 8,
          padding: 14,
          borderRadius: 12,
          alignItems: "center",
          backgroundColor: draft === null ? colors.surface2 : colors.accent,
          opacity: save.isPending ? 0.6 : 1,
        }}
      >
        <Text
          style={{
            color: draft === null ? colors.foregroundMuted : colors.accentForeground,
            fontSize: 14,
            fontWeight: "600",
          }}
        >
          {save.isPending ? "Saving…" : draft === null ? "No changes" : "Save changes"}
        </Text>
      </Pressable>
      {draft !== null ? (
        <View style={{ alignSelf: "center" }}>
          <LinkButton label="Discard changes" colors={colors} onPress={() => setDraft(null)} />
        </View>
      ) : null}

      {save.error ? (
        <Text style={{ color: colors.statusDanger, fontSize: 13 }}>
          {save.error instanceof Error ? save.error.message : "Could not save."}
        </Text>
      ) : null}
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ */
/* Daemon-side handlers                                                */
/* ------------------------------------------------------------------ */

const BRIDGE_ORIGIN = "http://127.0.0.1:47641";
// Must stay comfortably BELOW Paseo's plugin RPC timeout
// (REQUEST_TIMEOUT_MS = 30_000 in packages/server/src/server/plugins/runtime.ts).
// If the bridge wait is longer, Paseo abandons the call first and the user sees
// an opaque "Plugin RPC timed out" instead of the real reason. Every bridge
// route answers immediately — /v1/council returns 202 and runs the review in the
// background — so this only ever trips when something is genuinely wrong.
const BRIDGE_TIMEOUT_MS = 20_000;

/**
 * Flatten the host payload into the shape Fleet Guard's bridge already reads.
 *
 * The bridge's `councilPrompt` reads `text` / `role` / `attachments` at the top
 * level, while the host nests them under `message`. Sending a superset keeps the
 * existing bridge working untouched and still carries the richer `context`,
 * `draftText`, `provider` and `model` fields.
 */
/**
 * The bridge wants a flat object, and the host already sends one for both
 * scopes, so this is a straight pass-through.
 *
 * It previously re-mapped `input.message.*` into flat keys, which would have
 * thrown on every message-scope press: the host has never sent a nested
 * `message` object. That came from the same fabricated `.d.ts` that invented
 * `PluginActionPayloadSchema`.
 */
function toBridgePayload(input: PluginActionPayload): Record<string, unknown> {
  return { ...input };
}

/* ------------------------------------------------------------------ */
/* Guard supervision (daemon side)                                     */
/* ------------------------------------------------------------------ */

const GUARD_READY_TIMEOUT_MS = 20_000;
const GUARD_POLL_INTERVAL_MS = 500;

/**
 * Read the bridge token without throwing. Daemon-side only: in the client
 * bundle every `node:*` import resolves to `{}`, so this returns null there.
 */
async function readBridgeTokenQuietly(): Promise<string | null> {
  try {
    const [{ readFile }, nodePath, os] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
      import("node:os"),
    ]);
    if (typeof os.homedir !== "function") return null;
    const stateHome =
      process.env.FLEET_GUARD_STATE_HOME ?? nodePath.join(os.homedir(), ".paseo-fleet-guard");
    return (await readFile(nodePath.join(stateHome, "bridge-token"), "utf8")).trim();
  } catch {
    return null;
  }
}

/**
 * Is the bridge up?
 *
 * Every bridge route is bearer-authed, so an unauthenticated probe gets 401 —
 * which this used to treat as "not running". The guard would start correctly,
 * answer on its port immediately, and still be reported as "did not report
 * ready within 20 seconds" while startup stalled for the full timeout.
 *
 * A 401 is a *positive* answer to the only question being asked: something is
 * listening on the loopback port and speaking our protocol. The token is sent
 * when it can be read, so the status body comes back too.
 */
async function bridgeStatus(timeoutMs = 1500): Promise<Record<string, unknown> | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const token = await readBridgeTokenQuietly();
    const response = await fetch(`${BRIDGE_ORIGIN}/v1/status`, {
      signal: abort.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (response.status === 401 || response.status === 403) return {};
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start Fleet Supervisor alongside Paseo if it is not already up.
 *
 * This is what makes the tool cross-platform. Previously a Windows-only C#
 * launcher and shortcut existed purely to start the guard next to Paseo; the
 * daemon already runs on macOS, Linux and Windows, so starting the guard from
 * here removes the launcher entirely. The guard is Paseo-scoped by design — it
 * exits once the daemon has been gone for 20s — so nothing is left behind.
 *
 * `guardScript` must be an absolute path in ~/.paseo-fleet-guard/config.json.
 * There is no default: the plugin bundle is evaluated from a string and has no
 * reliable notion of its own directory, and guessing a path to execute would be
 * worse than doing nothing.
 */
/**
 * Only one auto-start may be in flight per plugin process. Paseo can evaluate
 * the contribution more than once (reload, daemon reconnect) and two spawns
 * racing each other would each see "not running" and both launch. The guard
 * itself also refuses to run twice (the bridge port is its singleton lock),
 * but not spawning the duplicate is cleaner than spawning and letting it exit.
 */
let guardStartInFlight: Promise<() => void> | null = null;

function ensureGuardRunning(log: (message: string) => void): Promise<() => void> {
  if (!guardStartInFlight) {
    guardStartInFlight = ensureGuardRunningOnce(log).finally(() => {
      guardStartInFlight = null;
    });
  }
  return guardStartInFlight;
}

async function ensureGuardRunningOnce(log: (message: string) => void): Promise<() => void> {
  // A guard that was just told to exit may still hold the port for a moment.
  // Ask twice, a beat apart, before concluding nobody is home.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await bridgeStatus()) {
      log("Fleet Supervisor is already running.");
      return () => undefined;
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  const [{ readFile }, path, os, childProcess] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
    import("node:os"),
    import("node:child_process"),
  ]);
  // `contribute()` runs in BOTH bundles. In the renderer every `node:*` import
  // resolves to `{}` (Paseo's compiler stubs the unused platform's modules), so
  // this is daemon-only work — the daemon copy starts the guard. Bail quietly
  // rather than throwing "os.homedir is not a function" into the desktop log.
  if (typeof os.homedir !== "function") return () => undefined;
  const stateHome =
    process.env.FLEET_GUARD_STATE_HOME ?? path.join(os.homedir(), ".paseo-fleet-guard");

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await readFile(path.join(stateHome, "config.json"), "utf8"));
  } catch {
    log("No Fleet Supervisor configuration found; not starting it.");
    return () => undefined;
  }
  if (config.autoStart === false) return () => undefined;

  const guardScript = typeof config.guardScript === "string" ? config.guardScript.trim() : "";
  if (!guardScript || !path.isAbsolute(guardScript)) {
    log("config.guardScript is not set to an absolute path; not starting Fleet Supervisor.");
    return () => undefined;
  }

  // `process.execPath` is Electron when Paseo runs its bundled daemon, so ask it
  // to behave as plain Node rather than hunting for a system Node install.
  // `process.execPath` is Electron when Paseo runs its bundled daemon; asking
  // it to behave as Node avoids hunting for a system Node install. But if that
  // path cannot be spawned (a locked-down install, an unusual packaging), a
  // system `node` on PATH is a perfectly good fallback for a plain .mjs script.
  const launchers: Array<{ command: string; env: NodeJS.ProcessEnv }> = [
    {
      command: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", FLEET_GUARD_STATE_HOME: stateHome },
    },
    { command: "node", env: { ...process.env, FLEET_GUARD_STATE_HOME: stateHome } },
  ];

  let child: ReturnType<typeof childProcess.spawn> | null = null;
  for (const launcher of launchers) {
    try {
      const candidate = childProcess.spawn(launcher.command, [guardScript], {
        detached: true,
        stdio: "ignore",
        env: launcher.env,
        // Windows: a detached child needs its own console-less window handle,
        // otherwise it is tied to the daemon's lifetime and shows a console.
        windowsHide: true,
      });
      // spawn() failures (ENOENT, EACCES, EPERM) arrive as an 'error' EVENT, not
      // a throw. Without a listener that becomes an uncaught exception, which in
      // this forked plugin process means the whole plugin dies at startup. This
      // handler is what keeps a bad launcher from taking Fleet Supervisor's UI
      // down with it.
      const spawned = await new Promise<boolean>((resolve) => {
        candidate.once("error", (error) => {
          log(`Could not launch via ${launcher.command}: ${String((error as Error)?.message ?? error)}`);
          resolve(false);
        });
        candidate.once("spawn", () => resolve(true));
      });
      if (spawned) {
        child = candidate;
        break;
      }
    } catch (error) {
      log(`Could not launch via ${launcher.command}: ${String((error as Error)?.message ?? error)}`);
    }
  }
  if (!child) {
    log("Fleet Supervisor could not be started with any available launcher; not retrying.");
    return () => undefined;
  }
  // A late 'error' (after spawn) must also never surface as uncaught.
  child.on("error", (error) => log(`Fleet Supervisor launcher error: ${String(error?.message ?? error)}`));
  child.unref();
  log(`Started Fleet Supervisor from ${guardScript} (pid ${child.pid ?? "unknown"}).`);

  const deadline = Date.now() + GUARD_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await bridgeStatus()) return () => undefined;
    await new Promise((resolve) => setTimeout(resolve, GUARD_POLL_INTERVAL_MS));
  }
  log("Fleet Supervisor did not report ready within 20 seconds.");
  return () => undefined;
}

/**
 * Paseo runs each plugin's server bundle in a forked child with no
 * uncaughtException handler. Anything that escapes — a spawn 'error' event with
 * no listener, a rejected promise nobody awaited — kills that child, and Paseo
 * then reports the plugin as failed. Nothing this plugin does is worth taking
 * its own UI down for, so in the daemon context these are logged and swallowed.
 * The check on `process.on` keeps this inert in the renderer.
 */
function shieldDaemonProcess(): void {
  const proc = globalThis.process as
    | { on?: (event: string, handler: (error: unknown) => void) => unknown; versions?: { node?: string } }
    | undefined;
  if (!proc?.on || !proc.versions?.node || typeof document !== "undefined") return;
  const marker = "__fleetSupervisorShielded";
  if (Reflect.get(proc, marker)) return;
  Reflect.set(proc, marker, true);
  proc.on("uncaughtException", (error) => {
    console.warn("[fleet-supervisor] uncaught exception contained", error);
  });
  proc.on("unhandledRejection", (error) => {
    console.warn("[fleet-supervisor] unhandled rejection contained", error);
  });
}

/* ------------------------------------------------------------------ */
/* Agent panel — the buttons                                           */
/* ------------------------------------------------------------------ */

/**
 * Rendered by Paseo inside the agent view via `addWorkspacePanel`.
 *
 * This replaced two earlier approaches. Paseo 0.4.0 had no way for a plugin to
 * contribute a button, so the buttons were either added by patching Paseo
 * (composer/message action slots) or injected into its DOM. Since 0.5.0 the
 * host contributes panels itself, so neither is needed: this is a plain
 * component the host renders, on a stock released Paseo.
 */
function AgentActionsPanel({ theme, agentId, workspaceId }: PluginAgentPanelProps) {
  const colors = readPalette(theme);
  const callCouncil = useRpc(councilReview);
  const callHandoff = useRpc(manualHandoffFromComposer);
  const callToggle = useRpc(toggleAutoHandoff);
  const callState = useRpc(supervisorState);
  const queryClient = useQueryClient();

  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Drives the on/off tint. `null` means "not known yet", which stays neutral
  // rather than claiming a state the guard never reported.
  const state = useQuery({
    queryKey: ["fleet", "supervisor-state"],
    queryFn: () => callState({}),
    staleTime: 5_000,
    retry: false,
  });
  const active: boolean | null = state.data?.active ?? null;

  const run = useCallback(
    async (id: string, action: () => Promise<string>) => {
      setBusy(id);
      setNotice(null);
      setFailed(false);
      try {
        setNotice(await action());
      } catch (error) {
        setFailed(true);
        setNotice(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const onReview = useCallback(
    () =>
      run("review", async () => {
        const result = await callCouncil({ scope: "latest-context", agentId, workspaceId });
        return result.message;
      }),
    [agentId, callCouncil, run, workspaceId],
  );

  const onToggle = useCallback(
    () =>
      run("toggle", async () => {
        const result = await callToggle({ enabled: null });
        await queryClient.invalidateQueries({ queryKey: ["fleet", "supervisor-state"] });
        return result.message;
      }),
    [callToggle, queryClient, run],
  );

  const onHandoff = useCallback(
    () =>
      run("handoff", async () => {
        const result = await callHandoff({ scope: "latest-context", agentId, workspaceId });
        return result.message;
      }),
    [agentId, callHandoff, run, workspaceId],
  );

  const supervisorTint =
    active === true ? "#3fa66a" : active === false ? colors.statusDanger : colors.border;

  return (
    <View style={{ gap: 10, padding: 12, backgroundColor: colors.surface0 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <PanelButton
          colors={colors}
          label={COMPOSER_ACTION_TITLE}
          busy={busy === "review"}
          disabled={busy !== null}
          onPress={onReview}
        />
        <PanelButton
          colors={colors}
          label={SUPERVISOR_ACTION_TITLE}
          busy={busy === "toggle"}
          disabled={busy !== null}
          borderColor={supervisorTint}
          labelColor={active === false ? colors.foregroundMuted : colors.foreground}
          onPress={onToggle}
        />
        <PanelButton
          colors={colors}
          label={HANDOFF_ACTION_TITLE}
          busy={busy === "handoff"}
          disabled={busy !== null}
          onPress={onHandoff}
        />
      </View>

      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
        {active === true
          ? "Watching for session limits. Reviews run on the configured reviewers."
          : active === false
            ? "Automatic handoff is off. Skeptic Review still works."
            : "Fleet Supervisor state unknown — is the guard running?"}
      </Text>

      {notice ? (
        <Text style={{ color: failed ? colors.statusDanger : colors.foreground, fontSize: 12 }}>
          {notice}
        </Text>
      ) : null}
    </View>
  );
}

function PanelButton({
  colors,
  label,
  onPress,
  busy,
  disabled,
  borderColor,
  labelColor,
}: {
  colors: Palette;
  label: string;
  onPress: () => void;
  busy: boolean;
  disabled: boolean;
  borderColor?: string;
  labelColor?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: borderColor ?? colors.border,
        backgroundColor: colors.surface1,
        opacity: disabled && !busy ? 0.5 : 1,
      }}
    >
      <Text style={{ color: labelColor ?? colors.foreground, fontSize: 13, fontWeight: "500" }}>
        {busy ? `${label}…` : label}
      </Text>
    </Pressable>
  );
}

export default function contribute(plugin: PluginContext) {
  shieldDaemonProcess();

  async function bridge(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<Record<string, unknown>> {
    const [{ readFile }, nodePath, os] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
      import("node:os"),
    ]);
    const stateHome =
      process.env.FLEET_GUARD_STATE_HOME ?? nodePath.join(os.homedir(), ".paseo-fleet-guard");

    let token: string;
    try {
      token = (await readFile(nodePath.join(stateHome, "bridge-token"), "utf8")).trim();
    } catch {
      throw new Error(
        "Fleet Supervisor is not running. Start Paseo with the Fleet Supervisor shortcut and try again.",
      );
    }

    // The bridge is loopback-only and can be mid-restart, so fail fast rather
    // than leaving the caller hanging on a socket that never answers.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), BRIDGE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${BRIDGE_ORIGIN}${path}`, {
        method: init?.method ?? "GET",
        signal: abort.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "AbortError" ? "timed out" : "refused";
      throw new Error(`Fleet Supervisor ${reason} while handling ${path}.`);
    } finally {
      clearTimeout(timer);
    }

    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
        typeof result.error === "string"
          ? result.error
          : `Fleet Supervisor returned HTTP ${response.status} for ${path}.`,
      );
    }
    return result;
  }

  plugin.handle(councilReview, async (input) => {
    const result = await bridge("/v1/council", { method: "POST", body: toBridgePayload(input) });
    return {
      message:
        typeof result.message === "string" && result.message.trim().length > 0
          ? result.message
          : "Council review started. The digest will arrive in this conversation.",
      reviewId: typeof result.reviewId === "string" ? result.reviewId : null,
    };
  });

  plugin.handle(fetchCatalog, async ({ refresh }) => {
    const result = await bridge(`/v1/catalog${refresh ? "?refresh=1" : ""}`);
    return {
      providers: Array.isArray(result.providers) ? result.providers : [],
      generatedAt: typeof result.generatedAt === "string" ? result.generatedAt : null,
    };
  });

  // Parse rather than pass through: the bridge is a separate process, so its
  // response is untrusted input as far as the contract is concerned.
  plugin.handle(fetchConfig, async () => {
    const result = await bridge("/v1/config");
    return { config: ConfigSchema.parse(result.config ?? {}) };
  });

  plugin.handle(saveConfig, async ({ config }) => {
    const result = await bridge("/v1/config", { method: "PUT", body: { config } });
    return { config: ConfigSchema.parse(result.config ?? {}) };
  });

  plugin.handle(manualHandoff, async ({ agentId, workerId, reason }) => {
    const result = await bridge("/v1/handoff", {
      method: "POST",
      body: { agentId, workerId, reason },
    });
    return {
      message:
        typeof result.message === "string" && result.message.trim().length > 0
          ? result.message
          : "Handing the task to the fleet.",
      worker: typeof result.worker === "string" ? result.worker : "",
    };
  });

  plugin.handle(manualHandoffFromComposer, async (input) => {
    const result = await bridge("/v1/handoff", {
      method: "POST",
      body: {
        agentId: input.agentId,
        workerId: "",
        reason: "The user handed this task to the fleet from Paseo's toolbar.",
      },
    });
    return {
      message:
        typeof result.message === "string" && result.message.trim().length > 0
          ? result.message
          : "Handing the task to the fleet.",
    };
  });

  plugin.handle(supervisorState, async () => ({
    active: (await bridge("/v1/status")).autoHandoff === true,
  }));

  plugin.handle(toggleAutoHandoff, async ({ enabled }) => {
    // A null `enabled` means "flip whatever it is now", which is what a toolbar
    // press wants; an explicit boolean is honoured as-is.
    const next =
      enabled === null
        ? ((await bridge("/v1/status")).autoHandoff as boolean | undefined) !== true
        : enabled;
    const result = await bridge("/v1/auto-handoff", {
      method: "POST",
      body: { enabled: next },
    });
    const state = result.autoHandoff === true;
    return { autoHandoff: state, message: supervisorStateMessage(state) };
  });

  // Fire and forget: a slow or failed start must not block plugin registration,
  // and the buttons degrade to a clear "Fleet Supervisor is not running" error.
  void ensureGuardRunning((message) => console.info(`[fleet-supervisor] ${message}`)).catch(
    (error: unknown) => {
      console.warn("[fleet-supervisor] could not start Fleet Supervisor", error);
    },
  );

  plugin.addSurface("settings", FleetSettingsSurface);

  plugin.addSidebarItem({
    id: "settings",
    title: "Fleet Supervisor",
    icon: "Radar",
    surface: "settings",
  });

  // Buttons live in a native agent panel and in the command center. Both are
  // stock Paseo contributions (0.5.0+), so this needs no patched build and no
  // DOM injection — the two approaches this plugin used before the host grew
  // surfaces of its own.
  plugin.addWorkspacePanel({
    id: "actions",
    title: SUPERVISOR_ACTION_TITLE,
    icon: "Radar",
    context: "agent",
    Component: AgentActionsPanel,
  });

  plugin.addCommandCenterItem({
    id: "skeptic-review",
    title: COMPOSER_ACTION_TITLE,
    icon: "SearchCheck",
    keywords: ["council", "review", "skeptic", "fleet"],
    context: "agent",
    async onSelect({ agent, rpc }) {
      await rpc(councilReview, {
        scope: "latest-context",
        agentId: agent.id,
        workspaceId: agent.workspaceId,
      });
    },
  });

  plugin.addCommandCenterItem({
    id: "fleet-supervisor-toggle",
    title: `${SUPERVISOR_ACTION_TITLE}: turn on or off`,
    icon: "Radar",
    keywords: ["fleet", "supervisor", "handoff", "quota"],
    context: "agent",
    async onSelect({ rpc }) {
      await rpc(toggleAutoHandoff, { enabled: null });
    },
  });

  plugin.addCommandCenterItem({
    id: "hand-off",
    title: HANDOFF_ACTION_TITLE,
    icon: "SendHorizontal",
    keywords: ["handoff", "fleet", "fallback"],
    context: "agent",
    async onSelect({ agent, rpc }) {
      await rpc(manualHandoffFromComposer, {
        scope: "latest-context",
        agentId: agent.id,
        workspaceId: agent.workspaceId,
      });
    },
  });

  return () => undefined;
}
