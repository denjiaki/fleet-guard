/**
 * Local declarations for Paseo's plugin SDK.
 *
 * TRANSCRIBED FROM REAL SOURCE — do not invent entries here. Every type below
 * is copied from `packages/plugin/src/contracts.ts` and `src/index.ts` at the
 * released tag v0.5.2. Earlier versions of this file declared exports that did
 * not exist (`PluginActionPayloadSchema`, `readPluginActionMessage`, a composer
 * payload with `draftText`/`context[]`), and because the SDK is an esbuild
 * *external*, nothing caught it until the value showed up as `undefined` at
 * runtime and the RPC died as an opaque 30s timeout.
 *
 * If you need something that is not here, read the real file first:
 *   upstream: packages/plugin/src/contracts.ts
 *   installed: <Paseo>/resources/app.asar → @getpaseo/plugin/dist/index.d.ts
 *
 * The daemon marks these specifiers external and injects its own runtime, so a
 * plugin typechecks without installing the SDK.
 */

declare module "@getpaseo/plugin" {
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

  export function defineRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
  ): PluginRpcContract<InputSchema, OutputSchema>;

  /** Client-side hook returning a caller for one contract. */
  export function useRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
  ): (input: ZodInput<InputSchema>) => Promise<ZodOutput<OutputSchema>>;

  export interface PluginTheme {
    readonly colors: {
      readonly surface0: string;
      readonly foreground: string;
      readonly foregroundMuted: string;
      readonly accent: string;
      readonly accentForeground: string;
      readonly statusDanger: string;
    };
  }

  export interface PluginHostProps {
    theme: PluginTheme;
    host: { id: string; label: string };
    layout: { compact: boolean; platform: "ios" | "android" | "web" };
  }

  export interface PluginSurfaceProps extends PluginHostProps {}

  export interface PluginWorkspacePanelProps extends PluginHostProps {
    context: "workspace";
    workspaceId: string;
  }

  export interface PluginAgentPanelProps extends PluginHostProps {
    context: "agent";
    workspaceId: string;
    agentId: string;
  }

  export interface PluginWorkspaceSnapshot {
    readonly id: string;
    readonly projectId: string;
    readonly projectDisplayName: string;
    readonly projectRootPath: string;
    readonly directory: string;
    readonly projectKind: "git" | "non_git" | "directory";
    readonly kind: "directory" | "local_checkout" | "checkout" | "worktree";
    readonly name: string;
    readonly title: string | null;
    readonly status: "needs_input" | "failed" | "running" | "attention" | "done";
    readonly statusEnteredAt: string | null;
    readonly archivingAt: string | null;
    readonly diffStat: { readonly additions: number; readonly deletions: number } | null;
  }

  export interface PluginAgentSnapshot {
    readonly id: string;
    readonly workspaceId: string;
    readonly provider: string;
    readonly status: "initializing" | "idle" | "running" | "error" | "closed";
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly lastActivityAt: string;
    readonly title: string | null;
    readonly cwd: string;
    readonly model: string | null;
    readonly currentModeId: string | null;
    readonly thinkingOptionId: string | null;
    readonly requiresAttention: boolean;
    readonly attentionReason: "finished" | "error" | "permission" | null;
    readonly parentAgentId: string | null;
    readonly labels: Readonly<Record<string, string>>;
  }

  interface PluginWorkspacePanelBase {
    id: string;
    title: string;
    icon: string;
  }

  export type PluginWorkspacePanelContribution =
    | (PluginWorkspacePanelBase & {
        context: "workspace";
        Component: ComponentType<PluginWorkspacePanelProps>;
      })
    | (PluginWorkspacePanelBase & {
        context: "agent";
        Component: ComponentType<PluginAgentPanelProps>;
      });

  export interface PluginSidebarContribution {
    id: string;
    title: string;
    icon: string;
    surface: string;
  }

  export interface PluginCommandCapabilities {
    rpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
      contract: PluginRpcContract<InputSchema, OutputSchema>,
      input: ZodInput<InputSchema>,
    ): Promise<ZodOutput<OutputSchema>>;
    openSurface(id: string): void;
  }

  export interface PluginAgentCommandContext extends PluginCommandCapabilities {
    context: "agent";
    workspace: PluginWorkspaceSnapshot;
    agent: PluginAgentSnapshot;
    openPanel(id: string): void;
  }

  interface PluginCommandCenterItemBase {
    id: string;
    title: string;
    icon: string;
    keywords?: readonly string[];
  }

  export type PluginCommandCenterItemContribution = PluginCommandCenterItemBase & {
    context: "agent";
    onSelect(context: PluginAgentCommandContext): void | Promise<void>;
  };

  export interface PluginHandlerContext {}

  export interface PluginContext {
    handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
      contract: PluginRpcContract<InputSchema, OutputSchema>,
      handler: (
        input: ZodOutput<InputSchema>,
        context: PluginHandlerContext,
      ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
    ): void;
    addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): void;
    addSidebarItem(contribution: PluginSidebarContribution): void;
    addWorkspacePanel(contribution: PluginWorkspacePanelContribution): void;
    addCommandCenterItem(contribution: PluginCommandCenterItemContribution): void;
  }

  export type PluginCleanup = () => void | Promise<void>;
}

declare module "@getpaseo/plugin/server" {
  export { defineRpc, type PluginRpcContract } from "@getpaseo/plugin";
}
