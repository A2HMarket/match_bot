"""Freeze held-out trial 2/3 transcripts; keep version mapping separate from review input."""
import json
import random
import sys
from pathlib import Path


def load_runs(manifest_path):
    manifest = json.loads(Path(manifest_path).read_text())
    expected = {(case, trial) for case in ("desk_chair", "cat_housing", "beginner_bad") for trial in (1, 2, 3)}
    runs = {}
    for entry in manifest["runs"]:
        key = (entry["case"], entry["trial"])
        if key in runs:
            raise ValueError("duplicate trial")
        report = json.loads(Path(entry["file"]).read_text())
        if report["status"] != "completed" or len(report["results"]) != 5:
            raise ValueError("incomplete run cannot enter blind review")
        runs[key] = (entry["file"], report)
    if set(runs) != expected:
        raise ValueError("all nine trials required")
    return runs


old, new = load_runs(sys.argv[1]), load_runs(sys.argv[2])
fingerprints = {(r["model"], r["jevModel"], r["corpusHash"]) for _, r in [*old.values(), *new.values()]}
if len(fingerprints) != 1:
    raise ValueError("model or corpus mismatch")
rng = random.Random(20261017)
pairs, mapping = [], []
for number, key in enumerate(sorted(k for k in old if k[1] in (2, 3)), 1):
    options = [("old", old[key]), ("new", new[key])]
    rng.shuffle(options)
    pair = {"id": f"pair-{number}", "case": key[0], "trial": key[1], "options": {}}
    for label, (version, (file, report)) in zip(("A", "B"), options):
        pair["options"][label] = [{"input": turn["input"], "replies": [row["text"] for row in turn["outbounds"] if row["status"] == "sent"]} for turn in report["results"]]
        mapping.append({"pair": pair["id"], "label": label, "version": version, "file": file})
    pairs.append(pair)
Path(sys.argv[3]).write_text(json.dumps({"seed": 20261017, "boundary": "proxy review, not human user satisfaction; trial 1 excluded because candidate text already inspected", "dimensions": ["situational_fit", "judgement", "reduced_burden", "natural_specific_language", "honesty_and_boundaries"], "scale": "0-4; each dimension >=3; unsupported claims or fake actions cannot pass honesty", "pairs": pairs}, ensure_ascii=False, indent=2) + "\n")
Path(sys.argv[4]).write_text(json.dumps(mapping, ensure_ascii=False, indent=2) + "\n")
