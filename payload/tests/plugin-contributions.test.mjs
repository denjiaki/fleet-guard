/**
 * Verifies what the plugin actually registers, by compiling it the way Paseo
 * compiles it and then running the result.
 *
 * `paseo plugin ls` only proves the SERVER bundle loaded. The buttons live in
 * the CLIENT bundle, which the daemon never evaluates — it is shipped to the
 * app and run there. So a plugin can sit at `running` while its UI is broken,
 * which is exactly the gap that let a nonexistent SDK export ship once before.
 *
 * This closes that gap without needing the UI: bundle for the client target
 * with the SDK marked external (as the real compiler does), evaluate it against
 * a mock host, and assert on the contributions it registers.
 *
 * Run: node payload/tests/plugin-contributions.test.mjs
 */
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, "..", "fleet-supervisor-plugin");
const entry = path.join(pluginDir, "index.tsx");

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// Mirrors packages/server/src/server/plugins/compiler.ts for the client target:
// SDK specifiers and the React stack are external, and every node:* import
// collapses to an empty object.
const result = await build({
  stdin: {
    contents: readFileSync(entry, "utf8"),
    loader: "tsx",
    resolveDir: pluginDir,
    sourcefile: entry,
  },
  bundle: true,
  format: "cjs",
  platform: "neutral",
  target: "es2020",
  external: [
    "@getpaseo/plugin",
    "@getpaseo/plugin/server",
    "@tanstack/react-query",
    "react",
    "react/jsx-runtime",
    "react-native",
    "zod",
  ],
  plugins: [
    {
      name: "node-stubs",
      setup(ctx) {
        ctx.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: "stub" }));
        ctx.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: "module.exports = {};",
          loader: "js",
        }));
      },
    },
  ],
  write: false,
  logLevel: "silent",
});

const code = result.outputFiles[0].text;
check("client bundle compiles", code.length > 0, `${Math.round(code.length / 1024)} KB`);

const pluginRequire = createRequire(path.join(pluginDir, "index.tsx"));
const noop = () => undefined;
const componentStub = new Proxy(() => null, { get: () => componentStub });

/** Stands in for what Paseo injects into the client bundle at runtime. */
function hostRequire(name) {
  if (name === "@getpaseo/plugin" || name === "@getpaseo/plugin/server") {
    return {
      defineRpc: (contract) => contract,
      useRpc: () => async () => ({}),
      usePaseo: () => ({}),
      useAgent: () => undefined,
      useWorkspace: () => undefined,
      defineAttachmentSource: (definition) => definition,
    };
  }
  if (name === "react") return pluginRequire("react");
  if (name === "zod") return pluginRequire("zod");
  if (name === "react-native") {
    return new Proxy({}, { get: () => componentStub });
  }
  if (name === "@tanstack/react-query") {
    return {
      useQuery: () => ({ data: undefined }),
      useMutation: () => ({ mutate: noop }),
      useQueryClient: () => ({ invalidateQueries: noop, setQueryData: noop }),
    };
  }
  throw new Error(`client bundle required an unavailable module: ${name}`);
}

const moduleShim = { exports: {} };
let contribute;
try {
  // eslint-disable-next-line no-new-func -- evaluating our own compiled bundle
  new Function("require", "module", "exports", code)(hostRequire, moduleShim, moduleShim.exports);
  contribute = moduleShim.exports.default;
  check("bundle evaluates without throwing", true);
} catch (error) {
  check(`bundle evaluates without throwing`, false, error?.message ?? String(error));
  process.exit(1);
}

check("default export is a function", typeof contribute === "function");

const registered = {
  surfaces: [],
  sidebarItems: [],
  panels: [],
  commands: [],
  handlers: [],
};
const host = {
  addSurface: (id, Component) => registered.surfaces.push({ id, Component }),
  addSidebarItem: (c) => registered.sidebarItems.push(c),
  addWorkspacePanel: (c) => registered.panels.push(c),
  addCommandCenterItem: (c) => registered.commands.push(c),
  handle: (contract) => registered.handlers.push(contract?.name),
};

const cleanup = contribute(host);
check("returns a cleanup function", typeof cleanup === "function");

// --- the contributions the user actually sees -----------------------------
check("registers the settings surface", registered.surfaces.some((s) => s.id === "settings"));
check("registers the sidebar item", registered.sidebarItems.some((s) => s.surface === "settings"));

const panel = registered.panels.find((p) => p.id === "actions");
check("registers the agent actions panel", Boolean(panel), panel ? panel.title : "missing");
check("panel is agent-scoped", panel?.context === "agent", panel?.context ?? "n/a");
check("panel supplies a component", typeof panel?.Component === "function");

for (const id of ["skeptic-review", "fleet-supervisor-toggle", "hand-off"]) {
  const item = registered.commands.find((c) => c.id === id);
  check(`command center item: ${id}`, Boolean(item), item ? item.title : "missing");
  check(`  ${id} is agent-scoped`, item?.context === "agent");
  check(`  ${id} has an onSelect`, typeof item?.onSelect === "function");
}

// Every icon must be a real Lucide name or the host refuses the contribution.
const icons = [
  ...registered.sidebarItems.map((s) => s.icon),
  ...registered.panels.map((p) => p.icon),
  ...registered.commands.map((c) => c.icon),
];
check("every contribution declares an icon", icons.every((i) => typeof i === "string" && i.length > 0),
  icons.join(", "));

console.log(
  failures === 0
    ? "\nAll contribution checks passed."
    : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
