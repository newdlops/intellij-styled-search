"""Smoke test: drive pyright-langserver on one symbol, get references count."""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from lsp_client import LspClient

WORKSPACE = "/Users/lky/project/captain"
PYRIGHT = WORKSPACE + "/.venv/bin/pyright-langserver"
FILE = WORKSPACE + "/zuzu/db/models/company/payroll/wht/wht_receipt.py"

client = LspClient([PYRIGHT, "--stdio"], WORKSPACE)
r = client.initialize()
print("init result keys:", list((r or {}).get("result", {}).keys())[:8])
time.sleep(2)

text = Path(FILE).read_text()
file_uri = "file://" + FILE
client.open_file(file_uri, text)
time.sleep(2)

# WhtReceiptQuerySet on line 26 (1-indexed) — col where 'W' is.
# zoek-rs reports startLine=25 (0-indexed), startColumn likely 6 (after "class ")
import json

# Probe a few positions
targets = [
    ("WhtReceiptQuerySet", 25, 6),  # after "class "
    ("annotate_employee_number", 26, 8),  # after "    def "
    ("get_latest_versions", 46, 8),
]
for name, line, col in targets:
    u = client.references(file_uri, line, col)
    i = client.implementations(file_uri, line, col)
    print(f"{name} line={line} col={col} -> refs={u} impl={i}")

client.shutdown()
