# Optional project skill manager bridge

This fork can run an existing `agent-skills` manager before workspace skill discovery
and before opening a provider session or loading a task's native thread. It is disabled by default. It does not install
the manager, select skills, or change global skill installations.

Set `T3CODE_AGENT_SKILLS` in the environment of the **T3 server that owns the project**,
then restart that server. For example:

```sh
export T3CODE_AGENT_SKILLS='{"enabled":true,"command":"/absolute/path/to/agent-skills","args":[],"timeoutMs":120000}'
```

`command` is an executable path or a name on the server's PATH, not a shell command.
For a Python script, use `"command":"/absolute/path/to/python3"` and
`"args":["/absolute/path/to/agent_skills.py"]`. Arguments are literal argv entries.
The timeout defaults to 120 seconds and accepts 1–180,000 milliseconds; process cleanup
can take up to two additional seconds. Unset the variable or set `enabled` to `false`
to disable the bridge. Configuration contains no credentials and is never read from
a project file or the connecting browser. Linked environments need their own setup.

Only a `.agent-skills.json` directly in the provider's working directory opts in.
Worktrees need their own manifest; the bridge does not search parent directories or
copy a selection from the original checkout. The manager receives
`apply --project <canonical-working-directory> --harness <mode>`, with that same cwd.
It alone owns inventory resolution, collision checks, managed links, Codex rules,
transaction records, and rollback.

| Provider                                                  | Manager mode | Availability and limits                                                                                                                                                     |
| --------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex                                                     | `codex`      | Project links plus the manager's `.codex/config.toml` allowlist. The project must be trusted.                                                                               |
| Antigravity                                               | `links`      | Its existing loader reads project `.agents/skills`; other native sources remain available.                                                                                  |
| OpenCode                                                  | `links`      | Native discovery supports project `.agents/skills`. Other sources and permissions still apply. External servers must share the project's filesystem and may need a restart. |
| Pi                                                        | `links`      | Native Agent Skills discovery, subject to project trust. **Not strict Pi scope**: no `--no-skills`/explicit `--skill` launch wrapper is installed.                          |
| Claude Code                                               | Unsupported  | T3's current loader uses `.claude/skills`, not the manager's `.agents/skills`.                                                                                              |
| Cursor, Grok, Kiro, Muse, fx, ACP Registry, other drivers | Unsupported  | The bridge skips activation and logs an unsupported-provider diagnostic.                                                                                                    |

Discovery evidence: T3's `ClaudeSkills.ts`, `AntigravitySkills.ts`, Codex skills probe,
OpenCode's native skill APIs and [discovery documentation](https://opencode.ai/docs/skills/#discovery),
and Pi's [native loader](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/skills.ts)
and installed `docs/skills.md`. The bridge leaves those loaders and permission rules intact.

Successful applications are cached in memory by canonical directory, manifest contents,
manager configuration, harness mode, and the allowed manager environment. Manifest contents
are checked before T3's workspace snapshot TTL, including after launch has populated the
bridge cache. Changing the manifest during apply fails preparation rather than launching
against an uncertain selection. Concurrent applies in this server are serialized per directory.
Do not run another T3 server or the manager manually against the same project concurrently.

Use a fresh provider refresh after changing the installed manager, skill inventory, managed
links, or native provider configuration. Those files are not recursively watched or hashed.
Use an empty selection to deactivate managed skills; deleting the manifest or disabling the
bridge does **not** undo previous applications. Use the manager's rollback command explicitly.
Already-running/reused sessions are not restarted or rescoping-enforced by this bridge.

A failed apply blocks that project's new session and preserves T3's previous discovery
snapshot. Server logs include the reason and exit code, without argv, stdout, stderr, or
underlying errors that could contain secrets. The same failed input is not retried until a
fresh refresh, changed input, cache eviction, or server restart. Run the configured manager's
`doctor` and inspect its transaction state before retrying. The current manager can mutate
links before a later collision, Codex probe, or filesystem error; it does **not** guarantee
automatic rollback on failure or termination. The bridge neither attempts unsafe restoration
nor adds a second transaction implementation. Strong failure atomicity requires manager work.

The manager receives a limited filesystem/runtime environment (PATH, home/temp/locale/XDG
paths, `CODEX_HOME`, `AGENT_SKILLS_HUB`, `AGENT_SKILLS_STATE_HOME`, `AGENT_SKILLS_CODEX_BIN`),
not provider-instance secrets. Codex inventory uses the manager's own CLI/home configuration;
custom T3 instance homes, launch overrides, plugins, and injected resources can differ. This
is project availability preparation, not an assertion of strict per-instance or filesystem isolation.
