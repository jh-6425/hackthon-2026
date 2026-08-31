# Warrant — Security Model and Honest Limitations

This document states exactly what Warrant guarantees, and — just as importantly —
what it does **not**. It distinguishes three levels of protection and maps every
control to the right level, so nothing is over-claimed.

## The three levels

| Level | Meaning | What Warrant does here |
| --- | --- | --- |
| **A. Pre-execution block** | An unauthorized action is refused *before* it takes effect (syscall/approval gate). | **Human approval** of the compiled warrant before the run starts. **Command evaluation at `item.started`**, before the model reports the command finished — the container is killed on a violating command, which prevents *later* actions in the same run but does not guarantee the current command produced no effect. |
| **B. Post-run detection** | An unauthorized effect is *detected* after it happened. | **Reconciliation**: the workspace is digested before and after every run; any changed path outside the write scope, over-budget, or a symlink that escaped during the run is detected. **Trace/audit** of every reported action with its verdict. |
| **C. Isolate-and-recover** | The effect cannot be prevented or fully detected, so it is *contained and rolled back*, and on failure the Agent is *quarantined*. | **Snapshot + rollback** to a byte-verified pre-run state; **quarantine** (structured, sticky, 423) when recovery cannot be verified. |

## What each control actually is

- **Warrant compilation + human approval** → **A** (before execution).
- **File writes** (`file_change`) → **B/C**. Codex reports a `file_change` *after*
  applying it, so a workspace write is **detected and rolled back**, not
  prevented. The protected asset is proven unchanged by digest.
- **Commands** (`command_execution`) → **A for the run, B/C for the effect**. A
  violating command is judged at `item.started` and the container is killed, which
  blocks the *rest* of the run; a fast side effect of that one command can still
  land and is then recovered by rollback.
- **Out-of-band writes** (e.g. an npm subprocess that emits no event) → **B/C**.
  Caught only by reconciliation and rolled back; the on-disk diff yields a
  **lower bound** on write operations, not an exact count.

## Known limitations (fail-closed, not hidden)

These are real limits of a Node/JS control plane over a container Runtime. Where
we cannot guarantee prevention, we fail closed and say so here rather than
implying a stronger guarantee.

1. **No `openat()` in Node.** The replay runner verifies every path component and
   opens the final file with `O_NOFOLLOW`, but a concurrent adversarial swap of an
   *intermediate directory* between the check and the open is a residual TOCTOU we
   cannot fully close in pure Node. We minimise the window and fail closed on any
   anomaly. The real threat surface is the container Runtime, where writes are
   reconciled after the fact.
2. **Hardlinks.** A hardlink inside the workspace pointing at an external inode
   cannot be distinguished from a normal file by content digest alone, and an
   in-workspace rollback cannot restore an external inode. This is **detection +
   quarantine**, not prevention. Treat a workspace you did not create as untrusted.
3. **Transient symlinks.** A create-link → write-external → delete-link sequence
   inside one run leaves no trace for a purely post-run scan. Command-level
   evaluation and container isolation are the mitigations; the post-run symlink
   check catches links that still exist at the end.
4. **Detached background writes.** A runner that returns and then writes from a
   detached process is only covered if it implements the `settled()` lifecycle
   hook (the container and replay runners fully await their work). We cannot catch
   writes from a process we cannot observe.
5. **`maxFileWrites` budget accounting.** During execution the monitor enforces
   the budget on **reported write operations** (canonical-deduplicated). The
   post-run reconcile backstop counts **changed-path units** — the net add/
   remove/modify paths in the before/after diff — which is NOT the same as an
   operation count: a rename counts as its 2 net path changes, a create-then-
   delete nets to 0, and 100 silent overwrites of one file net to 1. The reconcile
   error message says "changed-path units" so the two measures are never
   conflated. The reconcile backstop cannot recover the exact number of hidden
   operations; it is a conservative path-change accounting, not an exact meter.
6. **Path canonicalization is POSIX-first.** Only `/` is treated as a separator;
   a literal backslash is a legal POSIX filename character and is preserved (so a
   root file `tests\evil.ts` cannot masquerade as `tests/evil.ts`). Backslash is
   converted to `/` only on Windows.
7. **Case-insensitive filesystems** (default macOS/APFS, NTFS) are not fully
   modelled: a write to `tests/foo.ts` when `tests/Foo.ts` exists on disk may be
   counted as a distinct changed path. Warrant does not lowercase paths (that
   would break case-sensitive Linux, the container Runtime). On a case-insensitive
   volume this can over-count the budget or over-report a stray; it never
   under-blocks. Treat case-only distinctions as a known limitation.

## One-line summary for judges

> Warrant is an **approve-then-contain** Kill Switch: it blocks unauthorized work
> before a run starts (approval) and stops the *rest* of a run the moment a
> violating action is observed, then **detects, rolls back, and quarantines** any
> effect it could not prevent — with an honest boundary between prevention,
> detection, and recovery.
