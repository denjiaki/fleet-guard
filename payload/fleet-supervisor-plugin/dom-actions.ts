/**
 * Fallback button injection for stock Paseo.
 *
 * Paseo 0.4.0 has no composer or message action slot, so on an unmodified
 * install the two Fleet Supervisor buttons are injected into the DOM instead.
 * This runs only in the renderer; the daemon-side bundle no-ops because
 * `document` is undefined there.
 *
 * When the host does expose the action slots (see
 * `paseo-plugin-action-slots.patch`), `index.tsx` registers them natively and
 * never calls into this module. That path is strictly better — real components,
 * real theming, real accessibility — so this exists purely so users are not
 * forced onto a rebuilt Paseo.
 *
 * Everything here depends on Paseo internals: `testID`s, which react-native-web
 * emits as `data-testid`, and React fiber props for identity. Both are stable in
 * 0.4.0 but neither is a public contract, so every lookup fails soft.
 */

/** Anchors, all confirmed present in Paseo 0.4.0's rendered output. */
const COMPOSER_ANCHOR = '[data-testid="message-input-attach-button"]';
const USER_MESSAGE_ROW = '[data-testid="user-message-trailing-row"]';
const ASSISTANT_FORK_ANCHOR = '[data-testid="assistant-fork-menu-trigger"]';
const RUNNING_TURN_FOOTER = '[data-testid="turn-working-indicator"]';

const MARK = "data-fleet-supervisor-action";
const MAX_FIBER_DEPTH = 60;

export interface DomActionMessage {
  messageId: string | null;
  role: "user" | "assistant";
  text: string;
  attachments: unknown[];
  images: unknown[];
}

export interface DomActionTarget {
  serverId: string | null;
  agentId: string | null;
  workspaceId: string | null;
}

export interface DomActionsConfig {
  composerLabel: string;
  messageLabel: string;
  supervisorLabel: string;
  /** Resolves when the review has been accepted by Fleet Supervisor. */
  onComposerAction: (target: DomActionTarget) => Promise<string>;
  onMessageAction: (target: DomActionTarget, message: DomActionMessage) => Promise<string>;
  /** Current automatic-handoff state, or null when Fleet Supervisor is unreachable. */
  readSupervisorState: () => Promise<boolean | null>;
  /** Flips automatic handoff and resolves to the new state. */
  toggleSupervisor: () => Promise<boolean>;
  handoffLabel: string;
  /** Configured fallback entries, for the hand-off picker. */
  listFallbacks: () => Promise<Array<{ id: string; provider: string }>>;
  /** Hand the task to the fleet, starting at `workerId` ("" = first entry). */
  onHandoff: (target: DomActionTarget, workerId: string) => Promise<string>;
  onNotice: (text: string, kind: "info" | "error") => void;
}

/* ------------------------------------------------------------------ */
/* React fiber access                                                  */
/* ------------------------------------------------------------------ */

function fiberFromNode(node: Element): unknown {
  for (const key of Object.keys(node)) {
    if (key.startsWith("__reactFiber$")) return Reflect.get(node, key);
  }
  return null;
}

/**
 * Walk from a DOM node up the fiber tree collecting the first value seen for
 * each requested prop name. This is how identity is recovered: Paseo passes
 * `serverId` / `agentId` down through the panel, and `UserMessage` carries the
 * message text and attachments as props, so nothing has to be scraped out of
 * rendered text.
 */
function collectFiberProps(node: Element, wanted: readonly string[]): Record<string, unknown> {
  const found: Record<string, unknown> = {};
  let fiber = fiberFromNode(node);
  let depth = 0;
  while (fiber && depth < MAX_FIBER_DEPTH) {
    const props = Reflect.get(fiber as object, "memoizedProps");
    if (props && typeof props === "object") {
      for (const key of wanted) {
        if (found[key] === undefined) {
          const value = Reflect.get(props as object, key);
          if (value !== undefined) found[key] = value;
        }
      }
      if (wanted.every((key) => found[key] !== undefined)) return found;
    }
    fiber = Reflect.get(fiber as object, "return");
    depth += 1;
  }
  return found;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resolveTarget(node: Element): DomActionTarget {
  const props = collectFiberProps(node, ["serverId", "agentId", "workspaceId"]);
  return {
    serverId: asString(props.serverId),
    agentId: asString(props.agentId),
    workspaceId: asString(props.workspaceId),
  };
}

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

const SEARCH_CHECK_PATHS = [
  '<path d="m8 11 2 2 4-4"/>',
  '<circle cx="11" cy="11" r="8"/>',
  '<path d="m21 21-4.3-4.3"/>',
].join("");

const RADAR_PATHS = [
  '<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/>',
  '<path d="M4 6h.01"/>',
  '<path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/>',
  '<path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/>',
  '<path d="M12 18h.01"/>',
  '<path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/>',
  '<circle cx="12" cy="12" r="2"/>',
  '<path d="m13.41 10.59 5.66-5.66"/>',
].join("");

/** Lucide "send-horizontal": a hand-off arrow. */
const HANDOFF_PATHS = [
  '<path d="M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z"/>',
  '<path d="M6 12h16"/>',
].join("");

const USERS_PATHS = [
  '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>',
  '<circle cx="9" cy="7" r="4"/>',
  '<path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
  '<path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
].join("");

function iconSvg(paths: string, size: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
  );
}

/**
 * Borrow the rendered colour of a neighbouring control so the injected button
 * tracks Paseo's theme, including light/dark switches, without reimplementing
 * its palette.
 */
function inheritedColor(anchor: Element, fallback: string): string {
  const sibling = anchor.querySelector("svg") ?? anchor;
  const color = getComputedStyle(sibling as Element).color;
  return color && color !== "rgba(0, 0, 0, 0)" ? color : fallback;
}

/* ------------------------------------------------------------------ */
/* Injection                                                           */
/* ------------------------------------------------------------------ */

function buildButton(options: {
  id: string;
  label: string;
  icon: string;
  showLabel: boolean;
  color: string;
  onPress: (button: HTMLButtonElement) => void;
}): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute(MARK, options.id);
  button.setAttribute("data-testid", `fleet-supervisor-${options.id}`);
  button.setAttribute("aria-label", options.label);
  button.title = options.label;
  button.style.cssText = [
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    options.showLabel ? "gap:4px" : "gap:0",
    options.showLabel ? "height:28px" : "height:22px",
    options.showLabel ? "padding:0 8px" : "padding:0",
    options.showLabel ? "" : "width:22px",
    "border:0",
    "border-radius:9999px",
    "background:transparent",
    `color:${options.color}`,
    "font:inherit",
    "font-size:13px",
    "line-height:1",
    "white-space:nowrap",
    "flex-shrink:0",
    "cursor:pointer",
    "opacity:0.85",
  ]
    .filter(Boolean)
    .join(";");
  button.innerHTML = options.icon + (options.showLabel ? `<span>${options.label}</span>` : "");
  // Resting opacity is state-dependent for the supervisor toggle, so hover and
  // pending both restore to whatever the current resting value is rather than a
  // hardcoded one.
  button.dataset.restOpacity = "0.85";
  button.addEventListener("mouseenter", () => {
    button.style.opacity = "1";
  });
  button.addEventListener("mouseleave", () => {
    button.style.opacity = button.dataset.restOpacity ?? "0.85";
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    options.onPress(button);
  });
  return button;
}

/**
 * Find the node to insert beside so the button lands in a horizontal row.
 *
 * Paseo wraps some controls in their own column container — the assistant fork
 * menu is one — so inserting directly after the anchor would stack the button
 * underneath instead of beside it. Climb until the parent lays out as a row.
 */
function rowSiblingFor(anchor: Element): Element | null {
  let node: Element | null = anchor;
  let depth = 0;
  while (node?.parentElement && depth < 5) {
    if (getComputedStyle(node.parentElement).flexDirection === "row") return node;
    node = node.parentElement;
    depth += 1;
  }
  return null;
}

/**
 * Reflect automatic-handoff state on the toolbar toggle. `null` means Fleet
 * Supervisor could not be reached, which reads the same as off but says so in
 * the tooltip rather than implying the user switched it.
 */
function applySupervisorState(
  button: HTMLElement,
  state: boolean | null,
  label: string,
): void {
  const on = state === true;
  button.dataset.state = state === null ? "unknown" : on ? "on" : "off";
  button.dataset.restOpacity = on ? "0.85" : "0.4";
  button.style.opacity = button.dataset.restOpacity;
  button.title =
    state === null
      ? `${label} is not running`
      : on
        ? `${label} is watching for session limits — click to disable`
        : `${label} will not hand off automatically — click to enable`;
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.setAttribute("aria-label", button.title);
}

function runAction(
  button: HTMLButtonElement,
  config: DomActionsConfig,
  action: () => Promise<string>,
): void {
  if (button.dataset.busy === "1") return;
  button.dataset.busy = "1";
  button.style.opacity = "0.45";
  action()
    .then((message) => config.onNotice(message, "info"))
    .catch((error: unknown) => {
      config.onNotice(error instanceof Error ? error.message : String(error), "error");
    })
    .finally(() => {
      delete button.dataset.busy;
      button.style.opacity = button.dataset.restOpacity ?? "0.85";
    });
}

/**
 * Reconstruct the assistant turn's text from the timeline items the footer
 * already holds, rather than reading it back out of rendered markdown.
 */
function assistantTurnText(node: Element): { text: string; messageId: string | null } {
  const props = collectFiberProps(node, ["items", "startIndex"]);
  const items = Array.isArray(props.items) ? (props.items as Record<string, unknown>[]) : [];
  const startIndex = typeof props.startIndex === "number" ? props.startIndex : 0;
  const parts: string[] = [];
  let messageId: string | null = null;
  for (let index = startIndex; index < items.length; index += 1) {
    const item = items[index];
    if (item?.kind !== "assistant_message") continue;
    const text = asString(item.text);
    if (text) parts.push(text);
    messageId = asString(item.messageId) ?? messageId;
  }
  return { text: parts.join("\n\n"), messageId };
}

/**
 * A small anchored menu listing the configured fallback entries. Choosing one
 * hands the task off starting there; the first row is the plain "next in
 * order" case. Closes on outside click or Escape.
 */
function openHandoffPicker(
  anchor: HTMLElement,
  entries: Array<{ id: string; provider: string }>,
  color: string,
  onPick: (workerId: string) => void,
): void {
  document.querySelector("[data-fleet-supervisor-picker]")?.remove();
  const menu = document.createElement("div");
  menu.setAttribute("data-fleet-supervisor-picker", "1");
  menu.setAttribute("role", "menu");
  const rect = anchor.getBoundingClientRect();
  menu.style.cssText = [
    "position:fixed",
    `left:${Math.round(rect.left)}px`,
    `bottom:${Math.round(window.innerHeight - rect.top + 6)}px`,
    "z-index:2147483646",
    "min-width:240px",
    "padding:6px",
    "border-radius:12px",
    "background:var(--fleet-menu-bg, #1f2937)",
    "box-shadow:0 8px 28px rgba(0,0,0,0.35)",
    "font:inherit",
    "font-size:13px",
    "color:#fff",
  ].join(";");

  const heading = document.createElement("div");
  heading.textContent = "Hand off to";
  heading.style.cssText = "padding:6px 10px 4px;opacity:0.7;font-size:11px;letter-spacing:0.02em;text-transform:uppercase";
  menu.appendChild(heading);

  const rows: Array<{ id: string; label: string; hint?: string }> = [
    { id: "", label: "Next in fallback order", hint: entries[0] ? entries[0].id : undefined },
    ...entries.map((entry) => ({ id: entry.id, label: entry.id, hint: entry.provider })),
  ];
  for (const row of rows) {
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.setAttribute("data-fleet-supervisor-pick", row.id);
    item.style.cssText = [
      "display:flex",
      "width:100%",
      "align-items:center",
      "justify-content:space-between",
      "gap:12px",
      "padding:8px 10px",
      "border:0",
      "border-radius:8px",
      "background:transparent",
      "color:inherit",
      "font:inherit",
      "text-align:left",
      "cursor:pointer",
    ].join(";");
    item.innerHTML =
      `<span>${row.label}</span>` +
      (row.hint ? `<span style="opacity:0.6;font-size:12px">${row.hint}</span>` : "");
    item.addEventListener("mouseenter", () => { item.style.background = "rgba(255,255,255,0.08)"; });
    item.addEventListener("mouseleave", () => { item.style.background = "transparent"; });
    item.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      close();
      onPick(row.id);
    });
    menu.appendChild(item);
  }

  const close = () => {
    menu.remove();
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onOutside = (event: Event) => {
    if (!menu.contains(event.target as Node)) close();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  // Defer so the click that opened the menu is not the one that closes it.
  setTimeout(() => {
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
  void color;
  document.body.appendChild(menu);
}

/**
 * A transient notice. Paseo's toast API is only reachable from inside a plugin
 * surface, and injected buttons live outside one, so this is a minimal
 * stand-in rather than a reimplementation of Paseo's toast.
 */
export function showDomNotice(text: string, kind: "info" | "error"): void {
  if (typeof document === "undefined") return;
  const existing = document.querySelector("[data-fleet-supervisor-notice]");
  if (existing) existing.remove();
  const notice = document.createElement("div");
  notice.setAttribute("data-fleet-supervisor-notice", kind);
  notice.setAttribute("role", "status");
  notice.textContent = text;
  notice.style.cssText = [
    "position:fixed",
    "left:50%",
    "bottom:28px",
    "transform:translateX(-50%)",
    "z-index:2147483647",
    "max-width:min(560px,86vw)",
    "padding:10px 14px",
    "border-radius:10px",
    "font:inherit",
    "font-size:13px",
    "line-height:1.4",
    "color:#fff",
    kind === "error" ? "background:#b4232b" : "background:#1f2937",
    "box-shadow:0 6px 22px rgba(0,0,0,0.32)",
    "pointer-events:none",
  ].join(";");
  document.body.appendChild(notice);
  setTimeout(() => notice.remove(), kind === "error" ? 6000 : 4000);
}

export function mountDomActions(config: DomActionsConfig): () => void {
  if (typeof document === "undefined") return () => undefined;

  const applyCompactLabels = (rowEl: Element) => {
    const rect = rowEl.getBoundingClientRect();
    const compact = rect.width > 0 && rect.width < 640;
    for (const node of Array.from(rowEl.querySelectorAll(`[${MARK}] > span`))) {
      (node as HTMLElement).style.display = compact ? "none" : "";
    }
    for (const node of Array.from(rowEl.querySelectorAll(`[${MARK}]`))) {
      const el = node as HTMLElement;
      if (el.querySelector("span")) el.style.padding = compact ? "0" : "0 8px";
      if (el.querySelector("span")) el.style.width = compact ? "28px" : "";
    }
  };

  const paint = () => {
    // Composer: sit immediately after the attach button, inside its row.
    for (const anchor of Array.from(document.querySelectorAll(COMPOSER_ANCHOR))) {
      const slot = rowSiblingFor(anchor);
      const row = slot?.parentElement;
      if (!slot || !row || row.querySelector(`[${MARK}="skeptic-review"]`)) continue;
      const button = buildButton({
        id: "skeptic-review",
        label: config.composerLabel,
        icon: iconSvg(SEARCH_CHECK_PATHS, 16),
        showLabel: true,
        color: inheritedColor(anchor, "currentColor"),
        onPress: (element) =>
          runAction(element, config, async () => {
            const target = resolveTarget(anchor);
            if (!target.agentId) throw new Error("Open a conversation before starting a review.");
            return config.onComposerAction(target);
          }),
      });
      slot.insertAdjacentElement("afterend", button);

      // Supervisor toggle, immediately after Skeptic Review. Reflects live
      // state: dimmed when automatic handoff is off, so the toolbar answers
      // "is Fleet Supervisor watching right now?" at a glance.
      if (!row.querySelector(`[${MARK}="fleet-supervisor"]`)) {
        const toggle = buildButton({
          id: "fleet-supervisor",
          label: config.supervisorLabel,
          icon: iconSvg(RADAR_PATHS, 16),
          showLabel: true,
          color: inheritedColor(anchor, "currentColor"),
          onPress: (element) =>
            runAction(element, config, async () => {
              const next = await config.toggleSupervisor();
              applySupervisorState(element, next, config.supervisorLabel);
              return next
                ? "Fleet Supervisor is watching for session limits again."
                : "Fleet Supervisor will not hand off automatically. Council reviews still work.";
            }),
        });
        button.insertAdjacentElement("afterend", toggle);
        void config
          .readSupervisorState()
          .then((state) => applySupervisorState(toggle, state, config.supervisorLabel))
          .catch(() => applySupervisorState(toggle, null, config.supervisorLabel));
      }

      // Manual hand-off. Opens a picker of the configured fallback entries;
      // the top row is "next in order". Distinct from the toggle: that decides
      // whether limits are *watched*, this hands the task over right now.
      if (!row.querySelector(`[${MARK}="hand-off"]`)) {
        const handoff = buildButton({
          id: "hand-off",
          label: config.handoffLabel,
          icon: iconSvg(HANDOFF_PATHS, 16),
          showLabel: true,
          color: inheritedColor(anchor, "currentColor"),
          onPress: (element) => {
            const target = resolveTarget(anchor);
            if (!target.agentId) {
              config.onNotice("Open a conversation before handing off.", "error");
              return;
            }
            void config
              .listFallbacks()
              .then((entries) => {
                if (entries.length === 0) {
                  config.onNotice(
                    "No fallback entries are configured. Add one in Fleet Supervisor settings.",
                    "error",
                  );
                  return;
                }
                openHandoffPicker(element, entries, inheritedColor(anchor, "currentColor"), (workerId) =>
                  runAction(element, config, () => config.onHandoff(target, workerId)),
                );
              })
              .catch((error: unknown) =>
                config.onNotice(error instanceof Error ? error.message : String(error), "error"),
              );
          },
        });
        const last = row.querySelector(`[${MARK}="fleet-supervisor"]`) ?? button;
        last.insertAdjacentElement("afterend", handoff);
      }
      applyCompactLabels(row);
    }

    // User messages: append to the existing timestamp/copy row.
    for (const row of Array.from(document.querySelectorAll(USER_MESSAGE_ROW))) {
      if (row.querySelector(`[${MARK}="council-review"]`)) continue;
      const button = buildButton({
        id: "council-review",
        label: config.messageLabel,
        icon: iconSvg(USERS_PATHS, 14),
        showLabel: false,
        color: inheritedColor(row, "currentColor"),
        onPress: (element) =>
          runAction(element, config, async () => {
            const target = resolveTarget(row);
            const props = collectFiberProps(row, [
              "messageId",
              "message",
              "images",
              "attachments",
            ]);
            const text = asString(props.message);
            if (!target.agentId || !text) throw new Error("This message has no reviewable text.");
            return config.onMessageAction(target, {
              messageId: asString(props.messageId),
              role: "user",
              text,
              attachments: Array.isArray(props.attachments) ? props.attachments : [],
              images: Array.isArray(props.images) ? props.images : [],
            });
          }),
      });
      row.appendChild(button);
    }

    // Assistant turns: sit beside the fork control in the turn footer. The
    // in-flight turn renders the same fork control but has no completed text to
    // review yet, so it is skipped until the turn lands.
    for (const anchor of Array.from(document.querySelectorAll(ASSISTANT_FORK_ANCHOR))) {
      if (anchor.closest(RUNNING_TURN_FOOTER)) continue;
      const slot = rowSiblingFor(anchor);
      const row = slot?.parentElement;
      if (!slot || !row || row.querySelector(`[${MARK}="council-review"]`)) continue;
      const button = buildButton({
        id: "council-review",
        label: config.messageLabel,
        icon: iconSvg(USERS_PATHS, 14),
        showLabel: false,
        color: inheritedColor(anchor, "currentColor"),
        onPress: (element) =>
          runAction(element, config, async () => {
            const target = resolveTarget(anchor);
            const { text, messageId } = assistantTurnText(anchor);
            if (!target.agentId || !text) throw new Error("This turn has no reviewable text.");
            return config.onMessageAction(target, {
              messageId,
              role: "assistant",
              text,
              attachments: [],
              images: [],
            });
          }),
      });
      slot.insertAdjacentElement("afterend", button);
    }
  };

  let scheduled = 0;
  const schedule = () => {
    if (scheduled) return;
    scheduled = requestAnimationFrame(() => {
      scheduled = 0;
      try {
        paint();
      } catch {
        // A single failed pass must not tear down the observer; the next
        // mutation retries.
      }
    });
  };

  schedule();
  window.addEventListener("resize", schedule);
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });

  return () => {
    window.removeEventListener("resize", schedule);
    observer.disconnect();
    if (scheduled) cancelAnimationFrame(scheduled);
    for (const node of Array.from(document.querySelectorAll(`[${MARK}]`))) node.remove();
  };
}
