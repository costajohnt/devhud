#!/usr/bin/env python3
"""One-off: drop the foreign entries issue #45 verified out of doneCelebrated.

Before the assignee filter in buildJql was fixed (2026-08-05), the board
fetched other people's cards and the refresh loop appended every Done one it
saw to state.doneCelebrated. 25 of the 32 entries were never ours. The ledger
is append-only, so nothing removes them on its own; #46 guards the writer but
cannot unlearn what is already written.

Run from the simon-dash checkout WITH THE SERVER STOPPED -- it rewrites
state.json on every refresh and would clobber this. Writes a .pre-purge.bak
next to the file first.

    python3 scripts/purge-done-ledger.py [path/to/state.json]

Safe to delete once it has been run wherever it needed running. Keys not
present in the ledger are reported and skipped, so a second run is a no-op.
"""
import json, shutil, sys

FOREIGN = {f"MORPH-{n}" for n in (
    15210, 15213, 14134, 13155, 204, 506, 15093, 10795, 11291, 11256,
    14199, 13833, 13673, 7829, 13500, 13769, 14203, 14090, 14603, 15103,
    12568, 3525, 12113, 15243, 14427,
)}

path = sys.argv[1] if len(sys.argv) > 1 else "data/state.json"
state = json.load(open(path))
ledger = state.get("doneCelebrated", [])
kept = [e for e in ledger if e.get("id") not in FOREIGN]
removed = [e["id"] for e in ledger if e.get("id") in FOREIGN]
missing = FOREIGN - {e.get("id") for e in ledger}

shutil.copy(path, path + ".pre-purge.bak")
state["doneCelebrated"] = kept
json.dump(state, open(path, "w"), indent=2)

print(f"{len(ledger)} -> {len(kept)}  (removed {len(removed)})")
if missing:
    print(f"not present, skipped: {', '.join(sorted(missing))}")
print(f"backup: {path}.pre-purge.bak")
