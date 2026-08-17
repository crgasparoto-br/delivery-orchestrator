from __future__ import annotations
import hashlib, json, subprocess, sys, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]; HEAD="a"*40; EVIDENCE_SHA=hashlib.sha256(b"specificity-evidence").hexdigest()

def run(closure:Path,matrix:Path):
    return subprocess.run([sys.executable,str(ROOT/"scripts"/"validate_requirement_attack_matrix.py"),"--requirement-closure",str(closure),"--attack-matrix",str(matrix)],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)

def semantic():
    return {
        "mechanism":{"surface":"handoff-control-evidence","dimension":"reproducible-procedure","target":"handoff evidence validator metadata record for reproducible procedure"},
        "procedure":{"operation":"validate","stimulus":"validate handoff evidence metadata record containing adversarial procedure","observable":"handoff evidence validator reads metadata record and returns rejection decision"},
        "outcome":{"expected_signal":"handoff evidence validator rejects semantically unbound metadata record","observed_signal":"handoff evidence validator rejected the unbound metadata record","evidence_sha256":EVIDENCE_SHA},
    }

def valid_matrix():
    return {"schema_version":1,"head_sha":HEAD,"requirements":[{
        "requirement_id":"REQ-001","obligation_ids":["OBL-001"],"risk_families":["structural-contract"],
        "risk_surfaces":[{"risk_family":"structural-contract","surface":"handoff-control-evidence","reason":"Handoff evidence must bind procedures and observable outcomes to the declared control boundary."}],
        "plausible_wrong_implementation":"Record generic handoff evidence while omitting the concrete procedure boundary and discriminant behavior.",
        "positive_control":{"id":"POS-1","status":"passed","head_sha":HEAD,"evidence":"evidence.log"},
        "negative_controls":[{"id":"SPECIFICITY-001","status":"passed","head_sha":HEAD,"evidence":"evidence.log","evidence_sha256":EVIDENCE_SHA,
            "risk_family":"structural-contract","surface":"handoff-control-evidence","dimension":"reproducible-procedure",
            "failure_mode":"Generic handoff evidence can claim a passed validator procedure without identifying the metadata record that was exercised.",
            "plausible_wrong_implementation":"Accept handoff evidence that describes a passing validator procedure but omits the concrete failing metadata record.",
            "control_type":"gate","procedure":"Validate a handoff evidence metadata record containing generic attack prose and require the validator to reject it.",
            "expected":"The handoff evidence validator rejects semantically unbound metadata record.",
            "observed":"The handoff evidence validator rejected the unbound metadata record.","semantic_evidence":semantic(),
            "sibling_cases":[{"id":"S1","surface":"handoff-control-evidence","dimension":"concrete-outcome","status":"passed"}]}],
        "regression_controls":[{"id":"REG-1","status":"passed","head_sha":HEAD,"evidence":"evidence.log"}]}],"uncovered_requirements":[]}

def paths(tmp):
    base=Path(tmp); c=base/"closure.json"; m=base/"matrix.json"; c.write_text(json.dumps({"obligations":[{"id":"OBL-001","disposition":"covered","requirement_ids":["REQ-001"]}]})); return c,m

def echo_matrix(surface,dimension):
    data=valid_matrix(); item=data["requirements"][0]; ctrl=item["negative_controls"][0]
    item["risk_surfaces"]=[{"risk_family":"structural-contract","surface":surface,"reason":f"{surface} must exercise the declared {dimension} decision."}]
    item["plausible_wrong_implementation"]=f"Make {surface} {dimension} boundary accept unsafe case"
    ctrl.update({"surface":surface,"dimension":dimension,"failure_mode":f"{surface} {dimension} accepts unsafe case during validation","plausible_wrong_implementation":f"Make {surface} {dimension} accept unsafe case during validation","procedure":f"validate {surface} {dimension} unsafe case and observe result","expected":f"{surface} {dimension} validator rejects unsafe case","observed":f"{surface} {dimension} validator rejected unsafe case"})
    ctrl["sibling_cases"]=[{"id":"S1","surface":surface,"dimension":f"{dimension}-alternate","status":"passed"}]
    ctrl["semantic_evidence"]={"mechanism":{"surface":surface,"dimension":dimension,"target":f"{surface} {dimension} validation target"},"procedure":{"operation":"validate","stimulus":f"validate {surface} {dimension} unsafe case","observable":f"observe {surface} {dimension} validation result"},"outcome":{"expected_signal":f"{surface} {dimension} validator rejects unsafe case","observed_signal":f"{surface} {dimension} validator rejected unsafe case","evidence_sha256":EVIDENCE_SHA}}
    return data

def test_specific_adversarial_metadata_passes():
    with tempfile.TemporaryDirectory() as tmp:
        c,m=paths(tmp); m.write_text(json.dumps(valid_matrix())); p=run(c,m); assert p.returncode==0,p.stdout

def test_obvious_generic_placeholder_metadata_is_rejected():
    with tempfile.TemporaryDirectory() as tmp:
        c,m=paths(tmp); data=valid_matrix(); item=data["requirements"][0]; item["plausible_wrong_implementation"]="wrong implementation passes tests"; ctrl=item["negative_controls"][0]; ctrl.update({"failure_mode":"unsafe remains","plausible_wrong_implementation":"wrong behavior still passes","procedure":"run negative test","expected":"rejected.","observed":"it passed."}); m.write_text(json.dumps(data)); p=run(c,m); assert p.returncode==2

def test_lexically_rich_word_salad_is_rejected():
    with tempfile.TemporaryDirectory() as tmp:
        c,m=paths(tmp); data=valid_matrix(); item=data["requirements"][0]; item["plausible_wrong_implementation"]="alpha beta gamma delta epsilon zeta"; ctrl=item["negative_controls"][0]; ctrl.update({"failure_mode":"alpha beta gamma delta epsilon zeta","plausible_wrong_implementation":"alpha beta gamma delta epsilon zeta","procedure":"validate alpha beta gamma delta epsilon zeta","expected":"alpha beta gamma delta epsilon","observed":"alpha beta gamma delta epsilon"}); m.write_text(json.dumps(data)); p=run(c,m); assert p.returncode==2; assert "not semantically bound" in p.stdout or "not bound" in p.stdout,p.stdout

def test_unrelated_structured_decoration_cannot_rescue_word_salad():
    with tempfile.TemporaryDirectory() as tmp:
        c,m=paths(tmp); data=valid_matrix(); ctrl=data["requirements"][0]["negative_controls"][0]; ctrl["procedure"]="validate alpha beta gamma delta epsilon zeta"; ctrl["expected"]="alpha beta gamma delta epsilon"; ctrl["observed"]="alpha beta gamma delta epsilon"; m.write_text(json.dumps(data)); p=run(c,m); assert p.returncode==2; assert "procedure" in p.stdout or "expected" in p.stdout,p.stdout

def test_semantic_evidence_hash_must_bind_to_control_evidence():
    with tempfile.TemporaryDirectory() as tmp:
        c,m=paths(tmp); data=valid_matrix(); data["requirements"][0]["negative_controls"][0]["semantic_evidence"]["outcome"]["evidence_sha256"]="0"*64; m.write_text(json.dumps(data)); p=run(c,m); assert p.returncode==2; assert "evidence_sha256 does not match" in p.stdout,p.stdout

def test_surface_dimension_echo_is_rejected_on_transfer_surfaces():
    for surface,dimension in (("canonical-adapter","authorization-check"),("public-entrypoint","tenant-scope")):
        with tempfile.TemporaryDirectory() as tmp:
            c,m=paths(tmp); m.write_text(json.dumps(echo_matrix(surface,dimension))); p=run(c,m); assert p.returncode==2,p.stdout; assert "only echoes declared surface/dimension" in p.stdout,p.stdout
