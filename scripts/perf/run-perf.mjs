/**
 * Browser benchmark and regression check: `npm run perf:bench -- [url] [flags]`.
 *
 *   npm run build && npx vite preview --port 5191 --strictPort
 *   npm run perf:bench -- http://127.0.0.1:5191/ --mbps=20 --rtt=40 --json=perf-result.json
 *
 * Drives a real Chrome through the DevTools Protocol (no dependencies; Node 22+ has a
 * WebSocket). Each phase reports numbers and checks them against performance-budget.json:
 *
 *   boot      cold cache, throttled network: bytes before the menu and until the match is
 *             prepared, time to the menu, long tasks
 *   match     a running shift of the official level: draw calls, meshes, synthetic frame
 *             times (CPU submission, and CPU+GPU synchronised with a 1-pixel readback)
 *   memory    the kitchen rebuilt N times: JS heap and texture memory must not keep growing
 *   quality   every profile: resolution, glow, frame time
 *   warm      a reload with the HTTP cache off: models must come from the persistent store
 *   failure   a cook's download blocked, then unblocked and retried from the error screen
 *
 * Frame times depend on the machine and are reported, failing only past a generous ceiling;
 * counts and bytes are hardware-independent and are the real regression gates.
 *
 * Flags: --mbps --rtt (network), --gpu (use the real GPU instead of SwiftShader),
 * --cycles=N (memory phase), --skip=phase,phase, --json=path, --chrome=path.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const baseUrl = args.find((arg) => !arg.startsWith("--")) ?? "http://127.0.0.1:5191/";
const MBPS = Number(flag("mbps", 20));
const RTT = Number(flag("rtt", 40));
const CYCLES = Number(flag("cycles", 3));
const SKIP = new Set(flag("skip", "").split(",").filter(Boolean));
const GPU = args.includes("--gpu");
const CHROME = flag("chrome", process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe");
const budget = JSON.parse(readFileSync(new URL("../../performance-budget.json", import.meta.url), "utf8"));
const PORT = 9334;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const profile = mkdtempSync(join(tmpdir(), "bb-perf-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-extensions", "--window-size=1280,800", "--js-flags=--expose-gc",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  ...(GPU ? ["--ignore-gpu-blocklist", "--use-angle=d3d11"] : ["--disable-gpu", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"]),
  "about:blank",
], { stdio: "ignore" });

const target = async () => {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((entry) => entry.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* starting */ }
    await sleep(200);
  }
  throw new Error("Chrome did not start");
};

const socket = new WebSocket(await target());
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
let nextId = 1;
const pending = new Map();
const listeners = new Set();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  else if (message.method) for (const listener of listeners) listener(message);
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.exception?.description ?? "evaluation failed");
  return result.result?.result?.value;
};
const waitFor = async (expression, timeoutMs, stepMs = 200) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(expression)) return Date.now() - start;
    await sleep(stepMs);
  }
  return null;
};

// --- network bookkeeping -----------------------------------------------------------------
let requests = [];
listeners.add(({ method, params }) => {
  if (method === "Network.requestWillBeSent") requests.push({ id: params.requestId, url: params.request.url, bytes: 0, fromCache: false });
  else if (method === "Network.loadingFinished") {
    const entry = requests.find((request) => request.id === params.requestId);
    if (entry) { entry.bytes = params.encodedDataLength; entry.done = true; }
  } else if (method === "Network.requestServedFromCache") {
    const entry = requests.find((request) => request.id === params.requestId);
    if (entry) entry.fromCache = true;
  }
});
// Page errors: a run that throws is a failed run, whatever its numbers say.
const pageErrors = [];
listeners.add(({ method, params }) => {
  if (method === "Runtime.exceptionThrown") pageErrors.push(params.exceptionDetails?.exception?.description?.split("\n")[0] ?? params.exceptionDetails?.text);
  else if (method === "Runtime.consoleAPICalled" && params.type === "error") {
    pageErrors.push(params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ").split("\n")[0].slice(0, 200));
  }
});
await send("Network.enable");
await send("Page.enable");
await send("Runtime.enable");
const throttle = (mbps, rtt) => send("Network.emulateNetworkConditions", {
  offline: false, latency: rtt, downloadThroughput: (mbps * 1024 * 1024) / 8, uploadThroughput: (10 * 1024 * 1024) / 8,
});

const MB = 1048576;
const results = { url: baseUrl, network: { mbps: MBPS, rtt: RTT }, gpu: GPU, phases: {} };
const failures = [];
const gate = (phase, name, value, limit, unit = "") => {
  const ok = value !== null && value !== undefined && value <= limit;
  if (!ok) failures.push(`${phase}: ${name} = ${value}${unit} (limit ${limit}${unit})`);
  return { value, limit, ok };
};
/** --query=renderer=webgpu adds query parameters to every page load (renderer, assets). */
const EXTRA_QUERY = flag("query", "");
const pageUrl = (extra) => `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}dev&${extra}${EXTRA_QUERY ? `&${EXTRA_QUERY}` : ""}`;
const sum = (list) => list.reduce((total, request) => total + (request.bytes || 0), 0);

/** In-page synthetic frame benchmark of the running kitchen (see PERFORMANCE_AUDIT.md). */
const BENCH = `(frames) => {
  const k = window.__bbGame.kitchenScene; const scene = k.scene; const engine = scene.getEngine();
  const gl = engine._gl; const px = new Uint8Array(4);
  const run = (sync) => { const times = []; for (let i = 0; i < frames; i++) { const t = performance.now();
    engine.beginFrame(); k.update(1 / 60); scene.render(); engine.endFrame();
    if (sync && gl) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); times.push(performance.now() - t); }
    times.sort((a, b) => a - b); const at = (q) => +times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(2);
    return { mean: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2), p50: at(0.5), p95: at(0.95) }; };
  run(true);
  return { cpu: run(false), cpuGpu: run(true), drawCalls: engine._drawCalls.current,
    activeMeshes: scene.getActiveMeshes().length, sceneMeshes: scene.meshes.length, materials: scene.materials.length };
}`;

const startShift = async () => {
  const startedAt = Date.now();
  await evaluate(`(async () => { const g = window.__bbGame; await g.startShift(g.selectedCharacters); g.ui.showSplash(false); })()`);
  return Date.now() - startedAt;
};

try {
  // --- boot -----------------------------------------------------------------------------
  if (!SKIP.has("boot")) {
    await send("Network.setCacheDisabled", { cacheDisabled: true });
    await throttle(MBPS, RTT);
    requests = [];
    const navigatedAt = Date.now();
    await send("Page.navigate", { url: pageUrl("perf&cache=off") });
    const menuMs = await waitFor("performance.getEntriesByName('bb:menu-ready').length > 0", 180_000);
    const menuBytes = sum(requests.filter((request) => request.done));
    const prepared = await waitFor("performance.getEntriesByName('bb:gameplay-ready').length > 0", 240_000, 500);
    const marks = await evaluate("Object.fromEntries(performance.getEntriesByType('mark').filter((m) => m.name.startsWith('bb:')).map((m) => [m.name.slice(3), Math.round(m.startTime)]))");
    const preparedBytes = sum(requests.filter((request) => request.done));
    // Models only: the asset cache guarantees one download per model file. Images a DOM
    // <img> also shows (HUD icons) are fetched by both when the HTTP cache is off, as here.
    const duplicates = Object.entries(requests.filter((request) => /\.(glb|gltf|bin|ktx2)(\?|$)/i.test(request.url))
      .reduce((count, request) => ({ ...count, [request.url]: (count[request.url] ?? 0) + 1 }), {}))
      .filter(([, count]) => count > 1).map(([url]) => url);
    results.phases.boot = {
      menuReadyMs: menuMs, gameplayPreparedAfterMs: prepared === null ? null : prepared + (menuMs ?? 0), wallClockMs: Date.now() - navigatedAt,
      marks, requests: requests.length, duplicates,
      bytesBeforeMenuMb: +(menuBytes / MB).toFixed(2), bytesUntilPreparedMb: +(preparedBytes / MB).toFixed(2),
      checks: {
        bytesBeforeMenu: gate("boot", "bytes before menu", +(menuBytes / MB).toFixed(2), budget.network.maxBytesBeforeMenuMb, " MB"),
        bytesUntilPrepared: gate("boot", "bytes until match prepared", +(preparedBytes / MB).toFixed(2), budget.network.maxBytesUntilGameplayReadyMb, " MB"),
        menuReady: gate("boot", "menu ready", menuMs, budget.network.maxMenuReadyMs, " ms"),
        duplicates: gate("boot", "duplicate downloads", duplicates.length, 0),
      },
    };
    await throttle(1000, 0);
  }

  // --- match ----------------------------------------------------------------------------
  if (!SKIP.has("match")) {
    if (SKIP.has("boot")) {
      await send("Page.navigate", { url: pageUrl("perf&cache=off") });
      await waitFor("performance.getEntriesByName('bb:gameplay-ready').length > 0", 240_000, 500);
    }
    const startMs = await startShift();
    await sleep(1500);
    const bench = await evaluate(`(${BENCH})(60)`);
    const snapshot = await evaluate("window.__bbPerf.snapshot()");
    const renderer = await evaluate("(() => { const e = window.__bbGame.kitchenScene.scene.getEngine(); return { api: e.isWebGPU ? 'WebGPU' : `WebGL${e.webGLVersion}`, renderer: e.getGlInfo?.().renderer, webgpuAvailable: !!navigator.gpu }; })()");
    results.phases.match = {
      startShiftMs: startMs, renderer, bench,
      textureMb: snapshot.engines.map((engine) => [engine.engine, +engine.estimatedMb.toFixed(1)]),
      heapMb: snapshot.jsHeapMb === null ? null : +snapshot.jsHeapMb.toFixed(1),
      checks: {
        drawCalls: gate("match", "draw calls", bench.drawCalls, budget.runtime.maxDrawCalls),
        activeMeshes: gate("match", "active meshes", bench.activeMeshes, budget.runtime.maxActiveMeshes),
        sceneMeshes: gate("match", "scene meshes", bench.sceneMeshes, budget.runtime.maxSceneMeshes),
        frameP95: gate("match", "frame p95 (CPU+GPU)", bench.cpuGpu.p95, budget.runtime.maxBenchFrameP95Ms, " ms"),
        textures: gate("match", "largest engine texture estimate", Math.max(...snapshot.engines.map((engine) => Math.round(engine.estimatedMb))), budget.runtime.maxTextureMbPerEngine, " MB"),
      },
    };

    // --- quality ------------------------------------------------------------------------
    if (!SKIP.has("quality")) {
      const profiles = {};
      for (const mode of ["high", "medium", "low", "auto"]) {
        await evaluate(`document.querySelector('[data-quality="${mode}"]')?.click()`);
        await sleep(300);
        profiles[mode] = await evaluate(`(() => { const k = window.__bbGame.kitchenScene; const e = k.scene.getEngine();
          return { pixelsPerCssPixel: +(1 / e.getHardwareScalingLevel()).toFixed(2), glow: k.glow.isEnabled, blurKernel: k.glow.blurKernelSize,
            bench: (${BENCH})(30), quality: window.__bbPerf.snapshot().quality }; })()`);
      }
      results.phases.quality = profiles;
      if (profiles.low.glow) failures.push("quality: glow still on in the low profile");
      if (profiles.low.pixelsPerCssPixel > profiles.high.pixelsPerCssPixel) failures.push("quality: low draws more pixels than high");
    }

    // --- memory ---------------------------------------------------------------------------
    if (!SKIP.has("memory")) {
      const measure = () => evaluate(`(async () => { for (let i = 0; i < 3; i++) { window.gc?.(); await new Promise((r) => setTimeout(r, 100)); }
        const s = window.__bbPerf.snapshot(); return { heapMb: s.jsHeapMb, textureMb: s.engines.reduce((t, e) => t + e.estimatedMb, 0),
          meshes: window.__bbGame.kitchenScene.scene.meshes.length, containers: s.streaming?.containers ?? null }; })()`);
      const rebuild = `(async () => { const g = window.__bbGame; g.quitToMenu(); g.installKitchen(g.pendingLevel, undefined);
        await g.preloadGameplay(); })()`;
      await evaluate(rebuild);
      const first = await measure();
      const samples = [first];
      for (let cycle = 0; cycle < CYCLES; cycle++) { await evaluate(rebuild); samples.push(await measure()); }
      const last = samples.at(-1);
      results.phases.memory = { cycles: CYCLES, samples,
        checks: {
          heapGrowth: gate("memory", "heap growth after kitchen rebuilds", last.heapMb === null ? 0 : +(last.heapMb - first.heapMb).toFixed(1), budget.runtime.maxHeapGrowthMbAfterLevelCycles, " MB"),
          meshesStable: gate("memory", "mesh count drift", Math.abs(last.meshes - first.meshes), 50),
        },
      };
    }
  }

  // --- warm reload: persistent store ------------------------------------------------------
  if (!SKIP.has("warm")) {
    await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Page.navigate", { url: pageUrl("perf") });
    await waitFor("performance.getEntriesByName('bb:gameplay-ready').length > 0", 240_000, 500);
    await sleep(6000); // the store writes in idle time
    requests = [];
    await send("Page.navigate", { url: pageUrl("perf") });
    const menuMs = await waitFor("performance.getEntriesByName('bb:menu-ready').length > 0", 180_000);
    await waitFor("performance.getEntriesByName('bb:gameplay-ready').length > 0", 240_000, 500);
    const store = await evaluate("window.__bbPerf.snapshot().streaming");
    // Geometry files: what the persistent store is for. Images may be DOM ones (HUD icons,
    // CSS backgrounds), which the browser's HTTP cache handles.
    const fromNetwork = requests.filter((request) => request.done && /\.(glb|gltf|bin|ktx2)(\?|$)/i.test(request.url));
    const modelBytes = sum(fromNetwork);
    results.phases.warm = { menuReadyMs: menuMs, networkModelMb: +(modelBytes / MB).toFixed(2), persistent: store.persistent, bytes: store.bytes,
      largestFromNetwork: fromNetwork.sort((a, b) => b.bytes - a.bytes).slice(0, 12).map((request) => `${Math.round(request.bytes / 1024)} kB ${decodeURIComponent(request.url.replace(/^https?:\/\/[^/]+/, ""))}`),
      checks: { networkModels: gate("warm", "model bytes from the network on reload", +(modelBytes / MB).toFixed(2), budget.network.warmReloadMaxNetworkModelMb, " MB") } };
  }

  // --- failure and retry ------------------------------------------------------------------
  if (!SKIP.has("failure")) {
    await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Network.setBlockedURLs", { urls: ["*Sandy*"] });
    await send("Page.navigate", { url: pageUrl("cache=off") });
    const errorShown = await waitFor("document.querySelector('[data-ui=\"boot-loader\"]')?.dataset.state === 'error'", 120_000);
    await send("Network.setBlockedURLs", { urls: [] });
    await evaluate("document.querySelector(\"[data-action='boot-retry']\")?.click()");
    const recovered = await waitFor("performance.getEntriesByName('bb:menu-ready').length > 0", 120_000);
    results.phases.failure = { errorShownAfterMs: errorShown, recoveredAfterRetryMs: recovered };
    if (errorShown === null) failures.push("failure: a blocked cook never produced the error screen");
    if (recovered === null) failures.push("failure: retry after unblocking did not reach the menu");
  }
} catch (error) {
  failures.push(`benchmark crashed: ${error.message}`);
} finally {
  socket.close();
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
}

// The failure phase provokes errors on purpose (a blocked download is reported as one).
results.pageErrors = pageErrors;
const unexpected = pageErrors.filter((message) => !/Sandy|ERR_BLOCKED|Falha ao carregar|could not be (loaded|prepared)|não pôde/i.test(message ?? ""));
if (unexpected.length) failures.push(`page errors: ${unexpected.length} (${unexpected.slice(0, 3).join(" | ")})`);
results.failures = failures;
const out = flag("json", null);
if (out) writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
if (failures.length) {
  console.error(`\nPerformance budget: ${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nPerformance budget: all checks passed.");
process.exit(0);
