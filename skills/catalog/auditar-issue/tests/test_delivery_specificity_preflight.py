from __future__ import annotations
import hashlib, json, subprocess, sys, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]; HEAD="b"*40; EVIDENCE_SHA=hashlib.sha256(b"audit-evidence").hexdigest()
CANONICAL=["authorization","tenant-isolation","public-boundary","reference-liveness","temporal-consistency","temporal-destination","concurrency-atomicity","idempotency","rollback","historical-immutability","structural-contract","documentation"]

def run(matrix,risk,inherited): return subprocess.run([sys.executable,str(ROOT/"scripts"/"check_delivery_saturation.py"),"--attack-matrix",str(matrix),"--risk-saturation",str(risk),"--inherited-controls",str(inherited),"--head-sha",HEAD],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)

def semantic(): return {"mechanism":{"surface":"handoff-control-evidence","dimension":"reproducible-procedure","target":"handoff evidence validator metadata record for reproducible procedure"},"procedure":{"operation":"validate","stimulus":"validate handoff evidence metadata record containing adversarial procedure","observable":"handoff evidence validator reads metadata record and returns rejection decision"},"outcome":{"expected_signal":"handoff evidence validator rejects semantically unbound metadata record","observed_signal":"handoff evidence validator rejected the unbound metadata record","evidence_sha256":EVIDENCE_SHA}}

def base_packet():
    matrix={"head_sha":HEAD,"requirements":[{"requirement_id":"REQ-1","risk_families":["structural-contract"],"risk_surfaces":[{"risk_family":"structural-contract","surface":"handoff-control-evidence","reason":"Handoff evidence binds procedures and outcomes to the declared mechanism."}],"plausible_wrong_implementation":"Record generic handoff evidence while omitting the concrete boundary and discriminant behavior.","positive_control":{"status":"passed","head_sha":HEAD},"negative_controls":[{"id":"SPECIFICITY-001","status":"passed","head_sha":HEAD,"evidence_sha256":EVIDENCE_SHA,"risk_family":"structural-contract","surface":"handoff-control-evidence","dimension":"reproducible-procedure","failure_mode":"Generic handoff evidence can claim validator success without identifying the metadata record that was exercised.","plausible_wrong_implementation":"Accept handoff evidence describing a passing validator procedure while omitting the concrete failing metadata record.","procedure":"Validate a concrete handoff evidence metadata record and inspect the validator rejection decision.","expected":"The handoff evidence validator rejects semantically unbound metadata record.","observed":"The handoff evidence validator rejected the unbound metadata record.","semantic_evidence":semantic()}],"regression_controls":[{"status":"passed","head_sha":HEAD}]}],"uncovered_requirements":[]}
    risk={"head_sha":HEAD,"families":[{"family":f,"applicable":f=="structural-contract","status":"passed" if f=="structural-contract" else "not-applicable","control_ids":["SPECIFICITY-001"] if f=="structural-contract" else []} for f in CANONICAL],"material_families_missing_controls":[]}; inherited={"head_sha":HEAD,"controls":[],"unresolved_controls":[]}; return matrix,risk,inherited

def paths(tmp):
    b=Path(tmp); return b/"matrix.json",b/"risk.json",b/"inherited.json"
def write(paths_,packet):
    for path,data in zip(paths_,packet): path.write_text(json.dumps(data))

def echo_packet(surface,dimension):
    packet=base_packet(); item=packet[0]["requirements"][0]; ctrl=item["negative_controls"][0]
    item["risk_surfaces"]=[{"risk_family":"structural-contract","surface":surface,"reason":f"{surface} must exercise the declared {dimension} decision."}]
    item["plausible_wrong_implementation"]=f"Make {surface} {dimension} boundary accept unsafe case"
    ctrl.update({"surface":surface,"dimension":dimension,"failure_mode":f"{surface} {dimension} accepts unsafe case during validation","plausible_wrong_implementation":f"Make {surface} {dimension} accept unsafe case during validation","procedure":f"validate {surface} {dimension} unsafe case and observe result","expected":f"{surface} {dimension} validator rejects unsafe case","observed":f"{surface} {dimension} validator rejected unsafe case"})
    ctrl["semantic_evidence"]={"mechanism":{"surface":surface,"dimension":dimension,"target":f"{surface} {dimension} validation target"},"procedure":{"operation":"validate","stimulus":f"validate {surface} {dimension} unsafe case","observable":f"observe {surface} {dimension} validation result"},"outcome":{"expected_signal":f"{surface} {dimension} validator rejects unsafe case","observed_signal":f"{surface} {dimension} validator rejected unsafe case","evidence_sha256":EVIDENCE_SHA}}
    return packet

def test_preflight_accepts_semantically_bound_attack_metadata():
    with tempfile.TemporaryDirectory() as tmp:
        ps=paths(tmp); packet=base_packet(); write(ps,packet); p=run(*ps); assert p.returncode==0,p.stdout

def test_preflight_rejects_lexically_rich_word_salad():
    with tempfile.TemporaryDirectory() as tmp:
        ps=paths(tmp); packet=base_packet(); item=packet[0]["requirements"][0]; item["plausible_wrong_implementation"]="alpha beta gamma delta epsilon zeta"; c=item["negative_controls"][0]; c.update({"failure_mode":"alpha beta gamma delta epsilon zeta","plausible_wrong_implementation":"alpha beta gamma delta epsilon zeta","procedure":"validate alpha beta gamma delta epsilon zeta","expected":"alpha beta gamma delta epsilon","observed":"alpha beta gamma delta epsilon"}); write(ps,packet); p=run(*ps); assert p.returncode==2; assert "not bound" in p.stdout or "not bound to declared" in p.stdout,p.stdout

def test_preflight_rejects_missing_semantic_evidence_even_when_prose_is_long():
    with tempfile.TemporaryDirectory() as tmp:
        ps=paths(tmp); packet=base_packet(); del packet[0]["requirements"][0]["negative_controls"][0]["semantic_evidence"]; write(ps,packet); p=run(*ps); assert p.returncode==2; assert "lacks semantic_evidence" in p.stdout,p.stdout

def test_preflight_rejects_unrelated_semantic_evidence_hash():
    with tempfile.TemporaryDirectory() as tmp:
        ps=paths(tmp); packet=base_packet(); packet[0]["requirements"][0]["negative_controls"][0]["semantic_evidence"]["outcome"]["evidence_sha256"]="0"*64; write(ps,packet); p=run(*ps); assert p.returncode==2; assert "semantic evidence hash mismatch" in p.stdout,p.stdout

def test_preflight_rejects_surface_dimension_echo_on_transfer_surfaces():
    for surface,dimension in (("canonical-adapter","authorization-check"),("public-entrypoint","tenant-scope")):
        with tempfile.TemporaryDirectory() as tmp:
            ps=paths(tmp); packet=echo_packet(surface,dimension); write(ps,packet); p=run(*ps); assert p.returncode==2,p.stdout; assert "only echoes declared surface/dimension" in p.stdout,p.stdout
