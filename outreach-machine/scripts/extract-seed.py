"""Read-only adapter for the existing outreach workbook. Never saves the workbook."""
import hashlib
import json
import sys
from pathlib import Path
import openpyxl

source = Path(sys.argv[1]).resolve()
book = openpyxl.load_workbook(source, read_only=True, data_only=True)
def rows(name):
    values = iter(book[name].iter_rows(values_only=True))
    headers = next(values)
    return [dict(zip(headers, row)) for row in values if row and row[0] is not None]
json.dump({"source": str(source), "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
           "leads": rows("Lead Pipeline"), "known": rows("Known & Excluded")}, sys.stdout, ensure_ascii=False, default=str)
book.close()
