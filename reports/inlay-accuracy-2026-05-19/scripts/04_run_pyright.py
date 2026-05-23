"""Run Pyright LSP textDocument/references + textDocument/implementation for each
sampled symbol. Compare against inlay-reported counts.

Strategy:
  - Spawn N parallel pyright-langserver processes, each initialised at workspace root.
  - Queue (file, line, col, ...) work items round-robin across workers.
  - Each worker opens file once (didOpen), then issues references + implementations.

Output: /tmp/inlay_accuracy/lsp_results.jsonl
"""
import concurrent.futures
import json
import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lsp_client import LspClient

WORKSPACE = "/Users/lky/project/captain"
PYRIGHT = WORKSPACE + "/.venv/bin/pyright-langserver"
SAMPLE = Path("/tmp/inlay_accuracy/sample.jsonl")
OUT = Path("/tmp/inlay_accuracy/lsp_results.jsonl")

WORKERS = int(os.environ.get("WORKERS", "6"))
PER_QUERY_TIMEOUT = 30


def worker(worker_id: int, items: list[dict], out_q: "queue"):
    client = LspClient([PYRIGHT, "--stdio"], WORKSPACE)
    client.initialize()
    # Give Pyright a moment to start initial type-checking
    time.sleep(2)

    for rec in items:
        file_path = Path(WORKSPACE) / rec["file"]
        if not file_path.exists():
            continue
        try:
            text = file_path.read_text()
        except Exception:
            continue
        file_uri = "file://" + str(file_path)
        client.open_file(file_uri, text)
        # The "definition" col for class/def is the keyword column; we want the symbol name.
        # zoek-rs returns start of the symbol token (range.startColumn is usually the name itself).
        # For methods/defs the name appears after "def "/"class " — try the recorded col first,
        # then fall back to col + len("def ")/len("class ").
        line = rec["line"]
        col = rec["col"]
        kind = (rec.get("kind") or "").lower()
        # Position adjustment: many lines start with `def NAME(...)` and col may be at `d` of def.
        # We'll attempt (col), then (col + 4) for function/method, (col + 6) for class.
        candidates = [col]
        if kind in ("function", "method", "constructor"):
            candidates.append(col + 4)
        elif kind in ("class",):
            candidates.append(col + 6)

        u_count = None
        i_count = None
        for c in candidates:
            u = client.references(file_uri, line, c)
            if u is not None:
                u_count = u
                break
        # implementations only meaningful for class / function (interface-like patterns)
        if rec.get("impl", 0) > 0 or kind in ("class", "function", "method"):
            for c in candidates:
                i = client.implementations(file_uri, line, c)
                if i is not None:
                    i_count = i
                    break

        out = {
            **rec,
            "lsp_usage": u_count,
            "lsp_impl": i_count,
        }
        out_q.put(out)
    client.shutdown()


def main():
    import queue
    items = [json.loads(line) for line in SAMPLE.open()]
    print(f"Loaded {len(items)} sampled symbols", flush=True)
    # Partition for workers
    chunks: list[list[dict]] = [[] for _ in range(WORKERS)]
    for i, rec in enumerate(items):
        chunks[i % WORKERS].append(rec)
    out_q: queue.Queue = queue.Queue()
    written = 0
    t0 = time.time()

    def writer():
        nonlocal written
        with OUT.open("w") as f:
            while True:
                try:
                    rec = out_q.get(timeout=300)
                except queue.Empty:
                    return
                if rec is None:
                    return
                f.write(json.dumps(rec) + "\n")
                f.flush()
                written += 1
                if written % 50 == 0:
                    elapsed = time.time() - t0
                    rate = written / max(elapsed, 0.01)
                    eta = (len(items) - written) / max(rate, 0.01)
                    print(
                        f"  written={written}/{len(items)} "
                        f"elapsed={elapsed:.1f}s rate={rate:.1f}/s eta={eta:.0f}s",
                        flush=True,
                    )

    writer_thread = threading.Thread(target=writer, daemon=True)
    writer_thread.start()

    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = [ex.submit(worker, wid, chunks[wid], out_q) for wid in range(WORKERS)]
        for fut in concurrent.futures.as_completed(futs):
            try:
                fut.result()
            except Exception as e:
                print(f"WORKER ERROR: {e}", flush=True)

    out_q.put(None)
    writer_thread.join(timeout=30)
    print(f"DONE: wrote {written} results in {time.time()-t0:.1f}s", flush=True)


if __name__ == "__main__":
    main()
