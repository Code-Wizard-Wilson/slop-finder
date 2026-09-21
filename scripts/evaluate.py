#!/usr/bin/env python3
"""Run actual Laya inference against labeled examples; report misses, not just accuracy."""
import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "helper"))
from app import AnalyzeRequest, Block, MODEL_SPECS, MODEL_NAME, analyze


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, default=ROOT / "tests/fixtures/scoring_cases.json")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    cases = json.loads(args.dataset.read_text())
    started = time.perf_counter()
    rows = []
    for case in cases:
        block = Block(**{k: v for k, v in case.items() if k in Block.model_fields})
        result = analyze(AnalyzeRequest(blocks=[block]))["results"][0]
        row = {**case, **result}
        rows.append(row)
        print(case["id"], case["label"], result["decision"], result["risk"], flush=True)
    flagged = lambda row: row["decision"] == "slop" and (row["risk"] or 0) >= 0.65
    tp = sum(row["label"] == "slop" and flagged(row) for row in rows)
    fp = sum(row["label"] != "slop" and flagged(row) for row in rows)
    fn = sum(row["label"] == "slop" and not flagged(row) for row in rows)
    report = {
        "dataset": str(args.dataset), "checkpoint": MODEL_SPECS[MODEL_NAME],
        "note": "Hand-authored regression examples; not a population accuracy estimate.",
        "threshold": 0.65, "count": len(rows),
        "true_positives": tp, "false_positives": fp, "false_negatives": fn,
        "precision": tp / (tp + fp) if tp + fp else None,
        "recall": tp / (tp + fn) if tp + fn else None,
        "uncertain": sum(row["decision"] == "uncertain" for row in rows),
        "errors": sum(bool(row.get("error")) for row in rows),
        "elapsed_seconds": round(time.perf_counter() - started, 2),
        "results": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "results"}, ensure_ascii=False, indent=2))
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
