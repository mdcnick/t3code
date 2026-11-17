import { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  ProviderAdapterOpenSessionError,
  ProviderAdapterEnsureThreadError,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const BridgeConfig = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  command: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  args: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 180_000 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(120_000)),
  ),
});
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(BridgeConfig));

export class AgentSkillsBridgeError extends Schema.TaggedError<AgentSkillsBridgeError>()(
  "AgentSkillsBridgeError",
  {
    reason: Schema.Literals([
      "configuration",
      "filesystem",
      "spawn",
      "exit",
      "timeout",
      "interrupted",
      "manifest-changed",
    ]),
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Project skill preparation failed (${this.reason}). Check T3CODE_AGENT_SKILLS on this environment and run the manager's doctor before retrying with a fresh provider refresh.`;
  }
}

export class AgentSkillsBridge extends Context.Service<
  AgentSkillsBridge,
  {
    readonly prepare: (input: {
      readonly cwd: string | null;
      readonly driver: ProviderDriverKind;
      readonly fresh?: boolean;
    }) => Effect.Effect<string | undefined, AgentSkillsBridgeError>;
  }
>()("t3/provider/AgentSkillsBridge") {}

// These are filesystem/runtime inputs, never provider-instance credentials or arbitrary env overrides.
const ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "CODEX_HOME",
  "AGENT_SKILLS_HUB",
  "AGENT_SKILLS_STATE_HOME",
  "AGENT_SKILLS_CODEX_BIN",
] as const;

const harnessFor = (driver: ProviderDriverKind) => {
  switch (driver) {
    case "codex":
      return "codex";
    case "opencode":
    case "antigravity":
    case "pi":
      return "links";
    default:
      return undefined;
  }
};

const encodeFingerprint = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const digest = yield* Digest.Digest;
  const environment = yield* HostProcess.Environment;
  const cache = new Map<string, { fingerprint: string; error?: AgentSkillsBridgeError }>();
  const locks = new Map<string, { gate: Semaphore.Semaphore; users: number }>();

  const readOptional = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
      Effect.mapError((cause) => new AgentSkillsBridgeError({ reason: "filesystem", cause })),
    );
  const remember = (cwd: string, fingerprint: string, error?: AgentSkillsBridgeError) => {
    cache.delete(cwd);
    cache.set(cwd, { fingerprint, ...(error ? { error } : {}) });
    if (cache.size > 128) cache.delete(cache.keys().next().value!);
  };

  const prepare = Effect.fn("AgentSkillsBridge.prepare")(
    function* (input: Parameters<AgentSkillsBridge["Service"]["prepare"]>[0]) {
      const raw = environment.T3CODE_AGENT_SKILLS;
      if (!raw || input.cwd === null) return undefined;
      const configResult = yield* decodeConfig(raw).pipe(Effect.result);
      if (configResult._tag === "Success" && !configResult.success.enabled) return undefined;
      if (!path.isAbsolute(input.cwd)) {
        return yield* new AgentSkillsBridgeError({ reason: "filesystem" });
      }
      // Only an exact workspace manifest opts in; never apply a parent project's selection to a worktree.
      const manifestPath = path.join(input.cwd, ".agent-skills.json");
      if ((yield* readOptional(manifestPath)) === undefined) {
        cache.delete(input.cwd);
        const canonical = yield* fs
          .realPath(input.cwd)
          .pipe(Effect.orElseSucceed(() => input.cwd!));
        cache.delete(canonical);
        return undefined;
      }
      const harness = harnessFor(input.driver);
      if (harness === undefined) {
        yield* Effect.logWarning("Project skill bridge does not support this provider", {
          driver: input.driver,
          cwd: input.cwd,
          reason: "unsupported-provider",
        });
        return undefined;
      }
      if (configResult._tag === "Failure") {
        return yield* new AgentSkillsBridgeError({
          reason: "configuration",
          cause: configResult.failure,
        });
      }
      const config = configResult.success;
      if (
        !config.command.trim() ||
        [config.command, ...config.args].some((arg) => arg.includes("\0"))
      ) {
        return yield* new AgentSkillsBridgeError({ reason: "configuration" });
      }
      const cwd = yield* fs
        .realPath(input.cwd)
        .pipe(
          Effect.mapError((cause) => new AgentSkillsBridgeError({ reason: "filesystem", cause })),
        );
      const env = Object.fromEntries(
        ENVIRONMENT_KEYS.flatMap((key) =>
          environment[key] === undefined ? [] : [[key, environment[key]!]],
        ),
      );
      const lock = locks.get(cwd) ?? { gate: Semaphore.makeUnsafe(1), users: 0 };
      lock.users++;
      locks.set(cwd, lock);
      return yield* lock.gate
        .withPermit(
          Effect.gen(function* () {
            const manifest = yield* readOptional(path.join(cwd, ".agent-skills.json"));
            if (manifest === undefined) {
              cache.delete(cwd);
              return undefined;
            }
            const encoded = yield* encodeFingerprint([manifest, config, harness, env]).pipe(
              Effect.mapError(
                (cause) => new AgentSkillsBridgeError({ reason: "configuration", cause }),
              ),
            );
            const fingerprint = Hex.encode(
              yield* digest
                .digest(Digest.sha256, new TextEncoder().encode(encoded))
                .pipe(
                  Effect.mapError(
                    (cause) => new AgentSkillsBridgeError({ reason: "configuration", cause }),
                  ),
                ),
            );
            const previous = cache.get(cwd);
            if (!input.fresh && previous?.fingerprint === fingerprint) {
              if (previous.error) return yield* previous.error;
              return fingerprint;
            }
            // Invalidate before mutation, including interruptions: a previous success must never survive a failed apply.
            remember(cwd, fingerprint, new AgentSkillsBridgeError({ reason: "interrupted" }));
            const applied = yield* Effect.gen(function* () {
              const child = yield* spawner
                .spawn(
                  ChildProcess.make(
                    config.command,
                    [...config.args, "apply", "--project", cwd, "--harness", harness],
                    {
                      cwd,
                      env,
                      extendEnv: false,
                      shell: false,
                      stdin: "ignore",
                      stdout: "ignore",
                      stderr: "ignore",
                      forceKillAfter: "1 second",
                    },
                  ),
                )
                .pipe(
                  Effect.mapError(
                    (cause) => new AgentSkillsBridgeError({ reason: "spawn", cause }),
                  ),
                );
              const exitCode = yield* child.exitCode.pipe(
                Effect.mapError((cause) => new AgentSkillsBridgeError({ reason: "exit", cause })),
              );
              if (exitCode !== 0)
                return yield* new AgentSkillsBridgeError({ reason: "exit", exitCode });
              if ((yield* readOptional(path.join(cwd, ".agent-skills.json"))) !== manifest) {
                return yield* new AgentSkillsBridgeError({ reason: "manifest-changed" });
              }
            }).pipe(
              Effect.timeout(config.timeoutMs),
              Effect.catchTags({
                TimeoutError: (cause) =>
                  Effect.fail(new AgentSkillsBridgeError({ reason: "timeout", cause })),
              }),
              Effect.scoped,
              Effect.result,
            );
            if (applied._tag === "Failure") {
              remember(cwd, fingerprint, applied.failure);
              return yield* applied.failure;
            }
            remember(cwd, fingerprint);
            yield* Effect.logInfo("Project skill selection applied", {
              cwd,
              driver: input.driver,
              harness,
            });
            return fingerprint;
          }),
        )
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (--lock.users === 0) locks.delete(cwd);
            }),
          ),
        );
    },
    (effect, input) =>
      effect.pipe(
        Effect.tapError((error) =>
          Effect.logWarning(error.message, {
            cwd: input.cwd,
            driver: input.driver,
            reason: error.reason,
            exitCode: error.exitCode,
          }),
        ),
        // Provider failure logging must not serialize a spawn/schema cause containing command arguments.
        Effect.mapError(
          (error) =>
            new AgentSkillsBridgeError({
              reason: error.reason,
              ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
            }),
        ),
      ),
  );

  return AgentSkillsBridge.of({ prepare });
});

export const layer = Layer.effect(AgentSkillsBridge, make);

export function withAgentSkillsBridge(
  instance: ProviderInstance,
  bridge: AgentSkillsBridge["Service"],
): ProviderInstance {
  if (!instance.enabled) return instance;
  const prepareWorkspace: NonNullable<ProviderInstance["prepareWorkspace"]> = (cwd, options) =>
    bridge.prepare({ cwd, driver: instance.driverKind, ...options }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: instance.driverKind,
            instanceId: instance.instanceId,
            detail: cause.message,
            cause,
          }),
      ),
    );
  return {
    ...instance,
    prepareWorkspace,
    ...(instance.snapshotForCwd
      ? {
          snapshotForCwd: (cwd: string) =>
            prepareWorkspace(cwd).pipe(Effect.andThen(() => instance.snapshotForCwd!(cwd))),
        }
      : {}),
    orchestrationAdapter: {
      ...instance.orchestrationAdapter,
      openSession: (input) =>
        bridge.prepare({ cwd: input.runtimePolicy.cwd, driver: instance.driverKind }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterOpenSessionError({
                driver: instance.driverKind,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
          Effect.andThen(() => instance.orchestrationAdapter.openSession(input)),
          Effect.map((runtime) => ({
            ...runtime,
            // Pi updates its session snapshot after launch.
            get providerSession() {
              return runtime.providerSession;
            },
            ensureThread: (threadInput) =>
              bridge
                .prepare({
                  cwd: threadInput.runtimePolicy.cwd,
                  driver: instance.driverKind,
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterEnsureThreadError({
                        driver: instance.driverKind,
                        threadId: threadInput.threadId,
                        cause,
                      }),
                  ),
                  Effect.andThen(() => runtime.ensureThread(threadInput)),
                ),
          })),
        ),
    },
  };
}
