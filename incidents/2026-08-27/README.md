# 2026-08-27: the append-only ledger forked

An append-only log should have one next event. This one had two.

At physical line 621, the recorder wrote a `publication_watermark`. Line 622
contained a different event with the same `prev_event_hash`. From there the
file followed the second branch for 430 more lines, ending at line 1051. The
watermark became a terminal orphan.

## What the bytes establish

- The retained [byte image](./forecast-events.jsonl.corrupted) has SHA-256
  `274642299ee63bf97b4b1bb28b181beba8960961afec0af532a5006a3d894475`.
- Both branches share line 620 as their parent. Only the branch beginning at
  line 622 has descendants.
- The bytes prove the fork, not which process-level action started the second
  writer. I do not invent a cause.

## What I changed

The reader now validates every `event_hash` and builds the chain as a graph. It
reports a terminal losing tip as an orphan and follows the sole continuing
branch. If both branches continue, or any hash is invalid, it fails closed.

The writer now takes an atomic sidecar lock with its PID, a random token and the
Linux process-start token. It refuses a live second writer and safely recovers
a lock left by `SIGKILL` without trusting PID reuse.

I kept the original file unchanged. No line was deleted, rewritten or
backfilled, and the public snapshot still reports `orphan_count: 1`.
