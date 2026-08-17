/**
 * Type declarations for the `@paseo/plugin` SDK.
 *
 * Paseo does not publish this package to npm, so a plugin directory declares it
 * locally. Everything else the plugin imports (react, react-native, zod,
 * @tanstack/react-query) has real types from devDependencies.
 *
 * This mirrors the SDK **including the composer/message action slots** added by
 * `paseo-plugin-action-slots.patch`. Against stock Paseo 0.4.0 the
 * `addComposerAction` / `addMessageAction` declarations will typecheck but fail
 * at load, because the host has no such contribution kinds.
 */
declare module "@paseo/plugin" {
  import type { ComponentType } from "react";
  import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";

  export interface PluginRpcContract<
    InputSchema extends ZodType = ZodType,
    OutputSchema extends ZodType = ZodType,
  > {
    name: string;
    input: InputSchema;
    output: OutputSchema;
  }

  export function defineRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(definition: {
    name: string;
    input: InputSchema;
    output: OutputSchema;
  }): PluginRpcContract<InputSchema, OutputSchema>;

  export function useRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
  ): (input: ZodInput<InputSchema>) => Promise<ZodOutput<OutputSchema>>;

  /* -- surfaces & sidebar ------------------------------------------------ */

  export interface PluginSurfaceProps {
    theme: Record<string, unknown>;
    host: { id: string; label: string };
    layout: { compact: boolean; platform: "ios" | "android" | "web" };
  }

  export interface PluginSurfaceContribution {
    id: string;
    Component: ComponentType<PluginSurfaceProps>;
  }

  export interface PluginSidebarContribution {
    id: string;
    title: string;
    /** Lucide icon name, validated against lucide-react-native at load. */
    icon: string;
    /** Must match an addSurface id. */
    surface: string;
  }

  /* -- attachments ------------------------------------------------------- */

  export interface PluginAttachmentSourceContribution {
    id: string;
    title: string;
    icon: string;
    pickerTitle: string;
    searchPlaceholder: string;
    search: PluginRpcContract;
  }

  export function defineAttachmentSource<
    Definition extends PluginAttachmentSourceContribution,
  >(definition: Definition): Definition;

  export const PluginAttachmentItemSchema: ZodType;
  export const PluginAttachmentSearchPayloadSchema: ZodType;
  export type PluginAttachmentItem = {
    id: string;
    identifier: string;
    title: string;
    subtitle?: string;
    url: string;
    text: string;
    resourceType: string;
  };
  export type PluginAttachmentSearchPayload = { items: PluginAttachmentItem[] };

  /* -- action slots ------------------------------------------------------ */

  export type PluginActionScope = "latest-context" | "message";
  export type PluginActionRole = "user" | "assistant";

  export interface PluginActionMessage {
    id: string;
    messageId: string | null;
    role: PluginActionRole;
    text: string;
    /** ISO-8601, or null when the item carries no usable timestamp. */
    timestamp: string | null;
    attachments: unknown[];
    images: unknown[];
  }

  interface PluginActionTarget {
    serverId: string;
    agentId: string;
    workspaceId: string | null;
    provider: string | null;
    model: string | null;
  }

  // NOTE ON THE ACTION PAYLOAD
  //
  // The host does NOT export a schema, a type, or a reader for the action
  // payload. It builds a plain object inline at call time — see
  // `packages/app/src/plugins/actions.tsx` (`PluginComposerActions` and
  // `PluginMessageActions`). Both objects are FLAT.
  //
  // An earlier version of this file declared PluginActionPayloadSchema,
  // PluginActionResultSchema, readPluginActionMessage and friends. None of them
  // exist. Because `@paseo/plugin` is an external in the plugin build, esbuild
  // resolves such imports at runtime rather than failing the build, so the
  // value silently becomes `undefined` and the RPC dies as a 30s timeout with
  // no error anywhere. Declaring things here does not make them real — check
  // `packages/plugin/dist/index.d.ts` before adding to this file.
  //
  // The shapes below are documentation of what the host sends. The plugin
  // defines its own zod schema in index.tsx rather than importing one.

  export interface PluginComposerActionPayload {
    scope: "latest-context";
    agentId: string;
    workspaceId: string | null;
  }

  export interface PluginMessageActionPayload {
    scope: "message";
    agentId: string;
    messageId: string | null;
    role: PluginActionRole;
    text: string;
    attachments: unknown[];
    images: unknown[];
  }

  export type PluginActionPayload = PluginComposerActionPayload | PluginMessageActionPayload;

  export interface PluginComposerActionContribution {
    id: string;
    /** Rendered as the button's visible label and its accessibility label. */
    title: string;
    icon: string;
    action: PluginRpcContract;
    /**
     * Optional on/off indicator. The host calls this to tint the button —
     * active reads as enabled, inactive is muted — and re-reads it after every
     * successful press. Must resolve to `{ active: boolean }`.
     *
     * Real, unlike the entries this file used to invent: see
     * `PluginComposerActionContribution` in packages/plugin/src/contracts.ts.
     */
    state?: PluginRpcContract;
  }

  export interface PluginMessageActionContribution {
    id: string;
    title: string;
    icon: string;
    action: PluginRpcContract;
    /** Defaults to both roles. */
    roles?: ReadonlyArray<PluginActionRole>;
  }

  export function defineComposerAction<
    Definition extends PluginComposerActionContribution,
  >(definition: Definition): Definition;
  export function defineMessageAction<
    Definition extends PluginMessageActionContribution,
  >(definition: Definition): Definition;

  /* -- context ----------------------------------------------------------- */

  export interface PluginContext {
    handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
      contract: PluginRpcContract<InputSchema, OutputSchema>,
      handler: (
        input: ZodOutput<InputSchema>,
      ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
    ): void;
    addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): void;
    addSidebarItem(contribution: PluginSidebarContribution): void;
    addAttachmentSource(contribution: PluginAttachmentSourceContribution): void;
    /** Present only where the action-slot patch is applied. Guard with typeof. */
    addComposerAction?(contribution: PluginComposerActionContribution): void;
    addMessageAction?(contribution: PluginMessageActionContribution): void;
  }

  export type PluginCleanup = () => void;
  export type PluginContribution = (plugin: PluginContext) => PluginCleanup;
}
