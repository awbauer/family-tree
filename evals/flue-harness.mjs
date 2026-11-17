// Run the production agent functions and Valibot schemas without loading workerd
// or calling any model, browser, or network provider.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

export const env = {};
let rendering;
const url = import.meta.url;
const offline = () => { throw new Error("Network providers are disabled in scripted evals"); };
const modules = {
  "cloudflare:workers": `export { env } from "${url}";`,
  "agents/websearch": `export { offline as createAIWebSearch, offline as renderWebSearchResults } from "${url}";`,
  "agents/webfetch": `export { offline as fetchWeb, offline as windowWebFetchPage, offline as renderWebFetchPage } from "${url}";`,
};
export { offline };

export const runtime = {
  useTool(tool) {
    assert.ok(!rendering.tools.has(tool.name), `duplicate tool ${tool.name}`);
    rendering.tools.set(tool.name, tool);
  },
  useModel(model) { rendering.model = model; },
  useInitialData() { return rendering.data; },
  useAgentStart(fn) { rendering.starts.push(fn); },
  useAgentFinish(fn) { rendering.finishes.push(fn); },
  usePersistentState(key, initial) { return rendering.usePersistentState(key, initial); },
  observe() {},
  dispatch: offline,
};

export function hookImports() {
  return registerHooks({
    resolve(specifier, context, next) {
      if (specifier !== "@flue/runtime" && !Object.hasOwn(modules, specifier)) return next(specifier, context);
      const source = specifier === "@flue/runtime"
        ? `import { runtime } from "${url}"; export const { ${Object.keys(runtime).join(", ")} } = runtime;`
        : modules[specifier];
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
  });
}

export function scriptedAgent(Agent, data, parse) {
  const initialData = parse(Agent.initialData, data);
  const frame = { data: initialData, tools: new Map(), starts: [], finishes: [], state: new Map() };
  function render() {
    frame.tools.clear();
    frame.starts.length = frame.finishes.length = 0;
    const usedKeys = new Set();
    rendering = { ...frame, usePersistentState(key, initial) {
      assert.ok(!usedKeys.has(key), `duplicate persistent state ${key}`);
      usedKeys.add(key);
      if (!frame.state.has(key)) frame.state.set(key, initial);
      return [frame.state.get(key), (value) => frame.state.set(key, value)];
    } };
    try {
      frame.prompt = Agent({ id: data.runId || data.chatId || data.person || data.slug });
      frame.model = rendering.model;
    } finally { rendering = undefined; }
  }
  render();
  return {
    prompt: frame.prompt,
    model: frame.model,
    tools: [...frame.tools.keys()],
    async call(name, data) {
      render();
      const tool = frame.tools.get(name);
      assert.ok(tool, `${Agent.agentName} does not register ${name}`);
      const result = await tool.run({ data: parse(tool.input, data), step: { do: (_, fn) => fn() } });
      return result.output;
    },
    async start() {
      render();
      for (const start of frame.starts) await start();
    },
    async finish(toolCalls = []) {
      render();
      const signals = [];
      for (const finish of frame.finishes) {
        await finish({ response: { toolCalls, usage: {} }, append: (signal) => signals.push(signal) });
      }
      return signals;
    },
  };
}
