import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AgentSkillsBridge from "./AgentSkillsBridge.ts";

const codex = ProviderDriverKind.make("codex");
const nodeLayer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const configured = (overrides = {}) =>
  JSON.stringify({
    enabled: true,
    command: "/tools/agent-skills",
    ...overrides,
  });

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-" });
  const manifest = path.join(cwd, ".agent-skills.json");
  yield* fs.writeFileString(manifest, '{"schemaVersion":1,"skills":[]}');
  const env: NodeJS.ProcessEnv = {
    T3CODE_AGENT_SKILLS: configured(),
    HOME: cwd,
    AGENT_SKILLS_HUB: "/skill hub",
    OPENAI_API_KEY: "must-not-reach-the-manager",
  };
  const calls: Array<ChildProcess.StandardCommand> = [];
  const started = yield* Queue.unbounded<void>();
  let exit: Effect.Effect<number> = Effect.succeed(0);
  let releases = 0;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      assert.strictEqual(command._tag, "StandardCommand");
      calls.push(command as ChildProcess.StandardCommand);
      yield* Queue.offer(started, undefined);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          releases++;
        }),
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: exit.pipe(Effect.map(ChildProcessSpawner.ExitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const services = yield* Layer.build(
    AgentSkillsBridge.layer.pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      Layer.provide(Layer.succeed(HostProcess.Environment, env)),
    ),
  );
  const bridge = Context.get(services, AgentSkillsBridge.AgentSkillsBridge);
  return {
    fs,
    path,
    cwd,
    manifest,
    env,
    calls,
    bridge,
    prepare: (driver = codex, fresh = false) => bridge.prepare({ cwd, driver, fresh }),
    setExit: (effect: Effect.Effect<number>) => {
      exit = effect;
    },
    started: Queue.take(started),
    releases: () => releases,
  };
});

describe("AgentSkillsBridge", () => {
  it.effect("is opt-in and ignores projects without their own manifest", () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      delete h.env.T3CODE_AGENT_SKILLS;
      assert.strictEqual(yield* h.prepare(), undefined);
      h.env.T3CODE_AGENT_SKILLS = "{}";
      assert.strictEqual(yield* h.prepare(), undefined);
      h.env.T3CODE_AGENT_SKILLS = configured({ enabled: false });
      assert.strictEqual(yield* h.prepare(), undefined);
      h.env.T3CODE_AGENT_SKILLS = configured();
      assert.strictEqual(yield* h.bridge.prepare({ cwd: null, driver: codex }), undefined);
      const child = h.path.join(h.cwd, "child");
      yield* h.fs.makeDirectory(child);
      assert.strictEqual(yield* h.bridge.prepare({ cwd: child, driver: codex }), undefined);
      yield* h.fs.remove(h.manifest);
      assert.strictEqual(yield* h.prepare(), undefined);
      assert.strictEqual(h.calls.length, 0);
    }).pipe(Effect.provide(nodeLayer)),
  );

  it.effect.each([
    ["codex", "codex"],
    ["antigravity", "links"],
    ["opencode", "links"],
    ["pi", "links"],
    ["claudeCode", undefined],
    ["cursor", undefined],
    ["grok", undefined],
    ["kiro", undefined],
    ["muse", undefined],
    ["fx", undefined],
    ["acpRegistry", undefined],
  ] as const)("maps %s only to its supported manager mode", ([driver, harness]) =>
    Effect.gen(function* () {
      const h = yield* fixture;
      h.env.T3CODE_AGENT_SKILLS = configured({ args: ["literal argument; $(echo nope)"] });
      const result = yield* h.prepare(ProviderDriverKind.make(driver));
      assert.strictEqual(result !== undefined, harness !== undefined);
      assert.strictEqual(h.calls.length, harness === undefined ? 0 : 1);
      if (harness === undefined) return;
      const command = h.calls[0]!;
      assert.strictEqual(command.command, "/tools/agent-skills");
      assert.deepStrictEqual(command.args, [
        "literal argument; $(echo nope)",
        "apply",
        "--project",
        h.cwd,
        "--harness",
        harness,
      ]);
      assert.strictEqual(command.options.cwd, h.cwd);
      assert.strictEqual(command.options.shell, false);
      assert.strictEqual(command.options.extendEnv, false);
      assert.deepStrictEqual(command.options.env, { HOME: h.cwd, AGENT_SKILLS_HUB: "/skill hub" });
    }).pipe(Effect.provide(nodeLayer)),
  );

  it.effect("invalidates by content, configuration and mode, and forgets removed manifests", () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      const first = yield* h.prepare();
      assert.strictEqual(yield* h.prepare(), first);
      assert.strictEqual(h.calls.length, 1);
      yield* h.fs.writeFileString(h.manifest, '{"schemaVersion":1,"skills":["hub:sample"]}');
      assert.notStrictEqual(yield* h.prepare(), first);
      assert.strictEqual(h.calls.length, 2);
      h.env.T3CODE_AGENT_SKILLS = configured({ args: ["new config"] });
      yield* h.prepare();
      assert.strictEqual(h.calls.length, 3);
      h.env.AGENT_SKILLS_HUB = "/other-hub";
      yield* h.prepare();
      assert.strictEqual(h.calls.length, 4);
      yield* h.prepare(ProviderDriverKind.make("pi"));
      yield* h.prepare(codex);
      assert.strictEqual(h.calls.length, 6);
      yield* h.prepare(codex, true);
      assert.strictEqual(h.calls.length, 7);
      const content = yield* h.fs.readFileString(h.manifest);
      yield* h.fs.remove(h.manifest);
      yield* h.prepare();
      yield* h.fs.writeFileString(h.manifest, content);
      yield* h.prepare();
      assert.strictEqual(h.calls.length, 8);
    }).pipe(Effect.provide(nodeLayer)),
  );

  it.effect("serializes applies across provider instances and rereads a queued manifest", () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      const release = yield* Deferred.make<number>();
      h.setExit(Deferred.await(release));
      const first = yield* h.prepare().pipe(Effect.result, Effect.forkChild);
      yield* h.started;
      const second = yield* h.prepare().pipe(Effect.forkChild({ startImmediately: true }));
      yield* h.fs.writeFileString(h.manifest, '{"schemaVersion":1,"skills":["hub:updated"]}');
      h.setExit(Effect.succeed(0));
      yield* Deferred.succeed(release, 0);
      const firstResult = yield* Fiber.join(first);
      assert.strictEqual(firstResult._tag, "Failure");
      if (firstResult._tag === "Failure")
        assert.strictEqual(firstResult.failure.reason, "manifest-changed");
      assert.ok(yield* Fiber.join(second));
      assert.strictEqual(h.calls.length, 2);
    }).pipe(Effect.provide(nodeLayer)),
  );

  it.effect("caches a failure until explicit retry and does not block a different project", () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      h.setExit(Effect.succeed(2));
      const error = yield* h.prepare().pipe(Effect.flip);
      assert.strictEqual(error.reason, "exit");
      assert.strictEqual(error.exitCode, 2);
      assert.strictEqual((yield* h.prepare().pipe(Effect.flip)).reason, "exit");
      assert.strictEqual(h.calls.length, 1);
      h.setExit(Effect.succeed(0));
      const other = yield* h.fs.makeTempDirectoryScoped();
      yield* h.fs.writeFileString(h.path.join(other, ".agent-skills.json"), "{}");
      assert.ok(yield* h.bridge.prepare({ cwd: other, driver: codex }));
      assert.ok(yield* h.prepare(codex, true));
      assert.strictEqual(h.calls.length, 3);
    }).pipe(Effect.provide(nodeLayer)),
  );

  it.effect("bounds manager execution and releases its process on timeout or cancellation", () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      h.env.T3CODE_AGENT_SKILLS = configured({ timeoutMs: 10 });
      h.setExit(Effect.never);
      const timed = yield* h.prepare().pipe(Effect.flip, Effect.forkChild);
      yield* h.started;
      yield* TestClock.adjust(10);
      assert.strictEqual((yield* Fiber.join(timed)).reason, "timeout");
      assert.strictEqual(h.releases(), 1);
      const cancelled = yield* h.prepare(codex, true).pipe(Effect.forkChild);
      yield* h.started;
      yield* Fiber.interrupt(cancelled);
      assert.strictEqual(h.releases(), 2);
      assert.strictEqual((yield* h.prepare().pipe(Effect.flip)).reason, "interrupted");
      assert.strictEqual(h.calls.length, 2);
    }).pipe(Effect.provide(nodeLayer)),
  );

  it.effect.each([
    "not-json",
    configured({ command: "" }),
    configured({ timeoutMs: 0 }),
    configured({ timeoutMs: 180_001 }),
    configured({ args: [5] }),
    configured({ command: "nul\0byte" }),
  ])("rejects invalid configuration without invoking the manager (%s)", (config) =>
    Effect.gen(function* () {
      const h = yield* fixture;
      h.env.T3CODE_AGENT_SKILLS = config;
      assert.strictEqual((yield* h.prepare().pipe(Effect.flip)).reason, "configuration");
      assert.strictEqual(yield* h.prepare(ProviderDriverKind.make("claudeCode")), undefined);
      assert.strictEqual(h.calls.length, 0);
      yield* h.fs.remove(h.manifest);
      assert.strictEqual(yield* h.prepare(), undefined);
    }).pipe(Effect.provide(nodeLayer)),
  );

  it.effect(
    "prepares before discovery and launch, and blocks only the affected launch on failure",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture;
        const observed: Array<number> = [];
        let sessionSnapshot = { revision: 1 };
        const nativeRuntime = {
          get providerSession() {
            return sessionSnapshot;
          },
          ensureThread: () =>
            Effect.sync(() => {
              observed.push(h.calls.length);
              return {} as never;
            }),
        };
        const original = {
          instanceId: ProviderInstanceId.make("codex_test"),
          driverKind: codex,
          enabled: true,
          snapshotForCwd: () =>
            Effect.sync(() => {
              observed.push(h.calls.length);
              return {} as never;
            }),
          orchestrationAdapter: {
            openSession: () =>
              Effect.sync(() => {
                observed.push(h.calls.length);
                return nativeRuntime;
              }),
          },
        } as unknown as ProviderInstance;
        const instance = AgentSkillsBridge.withAgentSkillsBridge(original, h.bridge);
        const input = {
          threadId: ThreadId.make("thread"),
          providerSessionId: ProviderSessionId.make("session"),
          modelSelection: { instanceId: original.instanceId, model: "test" },
          runtimePolicy: { cwd: h.cwd, runtimeMode: "full-access", interactionMode: "default" },
        } as const;
        yield* instance.snapshotForCwd!(h.cwd);
        const runtime = yield* instance.orchestrationAdapter.openSession(input);
        assert.deepStrictEqual(observed, [1, 1]);
        sessionSnapshot = { revision: 2 };
        assert.strictEqual(runtime.providerSession as unknown, sessionSnapshot);
        yield* runtime.ensureThread(input);
        const worktree = yield* h.fs.makeTempDirectoryScoped();
        yield* h.fs.writeFileString(h.path.join(worktree, ".agent-skills.json"), "{}");
        yield* runtime.ensureThread({
          ...input,
          runtimePolicy: { ...input.runtimePolicy, cwd: worktree },
        });
        assert.deepStrictEqual(observed, [1, 1, 1, 2]);
        h.setExit(Effect.succeed(2));
        yield* h.fs.writeFileString(h.manifest, "changed");
        const error = yield* instance.orchestrationAdapter.openSession(input).pipe(Effect.flip);
        assert.strictEqual(error._tag, "ProviderAdapterOpenSessionError");
        assert.strictEqual(
          (yield* runtime.ensureThread(input).pipe(Effect.flip))._tag,
          "ProviderAdapterEnsureThreadError",
        );
        assert.deepStrictEqual(observed, [1, 1, 1, 2]);
      }).pipe(Effect.provide(nodeLayer)),
  );

  it.live(
    "executes argv without a shell in the project's directory and reports a missing executable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills argv-" });
        const script = path.join(cwd, "fake manager.cjs");
        yield* fs.writeFileString(path.join(cwd, ".agent-skills.json"), "{}");
        yield* fs.writeFileString(
          script,
          `require('node:fs').writeFileSync('invocation.json', JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), secret: process.env.OPENAI_API_KEY ?? null}));`,
        );
        const literal = "$(echo never); * &";
        const env: NodeJS.ProcessEnv = {
          T3CODE_AGENT_SKILLS: configured({ command: process.execPath, args: [script, literal] }),
          OPENAI_API_KEY: "not-forwarded",
        };
        const services = yield* Layer.build(
          AgentSkillsBridge.layer.pipe(Layer.provide(Layer.succeed(HostProcess.Environment, env))),
        );
        const bridge = Context.get(services, AgentSkillsBridge.AgentSkillsBridge);
        yield* bridge.prepare({ cwd, driver: codex });
        assert.deepStrictEqual(
          JSON.parse(yield* fs.readFileString(path.join(cwd, "invocation.json"))),
          {
            args: [literal, "apply", "--project", cwd, "--harness", "codex"],
            cwd,
            secret: null,
          },
        );
        env.T3CODE_AGENT_SKILLS = configured({ command: path.join(cwd, "missing-executable") });
        const error = yield* bridge.prepare({ cwd, driver: codex }).pipe(Effect.flip);
        assert.strictEqual(error.reason, "spawn");
        assert.strictEqual(error.cause, undefined);
        assert.ok(!error.message.includes(env.OPENAI_API_KEY!));
      }).pipe(Effect.scoped, Effect.provide(nodeLayer)),
  );
});
