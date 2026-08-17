#!/usr/bin/env python3
"""Cheap independent preflight for a delivery packet."""
from __future__ import annotations
import argparse, json, re
from pathlib import Path

CANONICAL={"authorization","tenant-isolation","public-boundary","reference-liveness","temporal-consistency","temporal-destination","concurrency-atomicity","idempotency","rollback","historical-immutability","structural-contract","documentation"}
OPS={"execute","validate","inspect","probe","compare","inject","configure","dispatch","observe","create","read","write","exercise","scan","rebuild","evaluate","materialize","prepare","classify","run"}
WORD_RE=re.compile(r"[a-z0-9]+",re.I); SHA256_RE=re.compile(r"^[0-9a-f]{64}$",re.I)
NOISE={"a","an","and","are","as","at","be","behavior","boundary","boundaries","candidate","case","cases","check","control","correct","detail","details","dimension","every","expected","generic","implementation","invalid","is","it","make","mechanism","negative","observed","pass","passed","passes","placeholder","positive","reject","rejected","rejects","result","results","run","scenario","should","still","surface","target","targets","test","tests","the","thing","things","this","unsafe","validation","value","values","wrong","with","without","from","into","for","that","only","while","before","after","during","when","then","than","through","accept","accepted","accepts"}

def load(path:Path)->dict:
    if not path.is_file(): raise FileNotFoundError(path)
    value=json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value,dict): raise ValueError(f"expected object: {path}")
    return value

def terms(value:object)->set[str]: return {w.lower() for w in WORD_RE.findall(str(value or "")) if len(w)>=3 and w.lower() not in NOISE}
def token_count(value:object)->int: return len(WORD_RE.findall(str(value or "")))
def ok_text(value:object,chars:int,count:int)->bool:
    text=str(value or "").strip(); return len(text)>=chars and token_count(text)>=count and len(terms(text))>=2
def overlap(value:object,context:set[str])->bool: return bool(terms(value)&context) if context else False

def require_novel_detail(value:object, anchors:set[str], label:str, errors:list[str], minimum:int=2)->set[str]:
    detail=terms(value)-anchors
    if len(detail)<minimum:
        errors.append(f"{label} only echoes declared surface/dimension without concrete operational detail")
    return detail

def require_detail_overlap(detail:set[str], anchors:set[str], label:str, errors:list[str])->None:
    if anchors and not (detail & anchors):
        errors.append(f"{label} concrete operational detail is not coupled to the exercised mechanism")

def surface_terms(item:dict)->set[str]:
    out:set[str]=set()
    for entry in item.get("risk_surfaces") or []:
        if isinstance(entry,dict): out |= terms(entry.get("surface")); out |= terms(entry.get("reason"))
        elif isinstance(entry,str): out |= terms(entry)
    return out

def surface_identity_terms(item:dict)->set[str]:
    out:set[str]=set()
    for entry in item.get("risk_surfaces") or []:
        if isinstance(entry,dict): out |= terms(entry.get("surface"))
        elif isinstance(entry,str): out |= terms(entry)
    return out

def semantic_errors(control:dict,label:str)->list[str]:
    errors=[]; sem=control.get("semantic_evidence")
    if not isinstance(sem,dict): return [f"{label} lacks semantic_evidence"]
    mech=sem.get("mechanism") if isinstance(sem.get("mechanism"),dict) else {}; proc=sem.get("procedure") if isinstance(sem.get("procedure"),dict) else {}; outcome=sem.get("outcome") if isinstance(sem.get("outcome"),dict) else {}
    surface=str(control.get("surface") or ""); dimension=str(control.get("dimension") or "")
    if mech.get("surface")!=surface: errors.append(f"{label} semantic mechanism surface mismatch")
    if mech.get("dimension")!=dimension: errors.append(f"{label} semantic mechanism dimension mismatch")
    base=terms(surface)|terms(dimension); target=mech.get("target")
    if not ok_text(target,12,4) or not overlap(target,base): errors.append(f"{label} semantic mechanism target is not bound to surface/dimension")
    target_detail=require_novel_detail(target,base,f"{label} semantic mechanism target",errors)
    context=base|terms(target); op=str(proc.get("operation") or "").lower()
    if op not in OPS: errors.append(f"{label} semantic procedure operation invalid")
    stimulus=proc.get("stimulus"); observable=proc.get("observable")
    if not ok_text(stimulus,12,4) or not overlap(stimulus,context): errors.append(f"{label} semantic procedure stimulus not bound")
    stimulus_detail=require_novel_detail(stimulus,base,f"{label} semantic procedure stimulus",errors)
    require_detail_overlap(stimulus_detail,target_detail,f"{label} semantic procedure stimulus",errors)
    if not ok_text(observable,12,4) or not overlap(observable,context|terms(stimulus)): errors.append(f"{label} semantic procedure observable not bound")
    observable_detail=require_novel_detail(observable,base,f"{label} semantic procedure observable",errors)
    require_detail_overlap(observable_detail,target_detail|stimulus_detail,f"{label} semantic procedure observable",errors)
    signal_context=context|terms(observable); expected=outcome.get("expected_signal"); observed=outcome.get("observed_signal")
    if not ok_text(expected,12,4) or not overlap(expected,signal_context): errors.append(f"{label} semantic expected signal not bound")
    expected_detail=require_novel_detail(expected,base,f"{label} semantic expected signal",errors)
    require_detail_overlap(expected_detail,observable_detail|target_detail,f"{label} semantic expected signal",errors)
    if not ok_text(observed,12,4) or not overlap(observed,signal_context|terms(expected)): errors.append(f"{label} semantic observed signal not bound")
    observed_detail=require_novel_detail(observed,base,f"{label} semantic observed signal",errors)
    require_detail_overlap(observed_detail,expected_detail|observable_detail,f"{label} semantic observed signal",errors)
    if outcome.get("evidence_sha256")!=control.get("evidence_sha256"): errors.append(f"{label} semantic evidence hash mismatch")
    narrative=context|terms(stimulus)|terms(observable)
    for key in ("failure_mode","plausible_wrong_implementation"):
        if not overlap(control.get(key),narrative): errors.append(f"{label} {key} not bound to semantic mechanism")
        require_novel_detail(control.get(key),base,f"{label} {key}",errors)
    free_proc=str(control.get("procedure") or "")
    if op and op not in [w.lower() for w in WORD_RE.findall(free_proc)]: errors.append(f"{label} procedure does not name semantic operation")
    if not overlap(free_proc,narrative): errors.append(f"{label} procedure not bound to semantic mechanism")
    free_detail=require_novel_detail(free_proc,base,f"{label} procedure",errors)
    require_detail_overlap(free_detail,stimulus_detail|observable_detail,f"{label} procedure",errors)
    if not overlap(control.get("expected"),terms(expected)): errors.append(f"{label} expected not bound to semantic expected signal")
    expected_free_detail=require_novel_detail(control.get("expected"),base,f"{label} expected",errors)
    require_detail_overlap(expected_free_detail,expected_detail,f"{label} expected",errors)
    if not overlap(control.get("observed"),terms(observed)): errors.append(f"{label} observed not bound to semantic observed signal")
    observed_free_detail=require_novel_detail(control.get("observed"),base,f"{label} observed",errors)
    require_detail_overlap(observed_free_detail,observed_detail,f"{label} observed",errors)
    return errors

def main()->int:
    p=argparse.ArgumentParser(); p.add_argument("--attack-matrix",required=True); p.add_argument("--risk-saturation",required=True); p.add_argument("--inherited-controls",required=True); p.add_argument("--head-sha",required=True); a=p.parse_args(); errors=[]
    try: matrix=load(Path(a.attack_matrix)); risk=load(Path(a.risk_saturation)); inherited=load(Path(a.inherited_controls))
    except Exception as exc: print(f"BLOCK: {exc}"); return 2
    if matrix.get("head_sha")!=a.head_sha: errors.append("attack matrix head_sha differs from candidate")
    if risk.get("head_sha")!=a.head_sha: errors.append("risk saturation head_sha differs from candidate")
    if inherited.get("head_sha")!=a.head_sha: errors.append("inherited controls head_sha differs from candidate")
    if matrix.get("uncovered_requirements"): errors.append("attack matrix has uncovered requirements")
    for item in matrix.get("requirements") or []:
        rid=item.get("requirement_id") if isinstance(item,dict) else "?"
        if not isinstance(item,dict): errors.append("invalid attack matrix entry"); continue
        wrong=item.get("plausible_wrong_implementation")
        if not ok_text(wrong,20,6): errors.append(f"requirement {rid} lacks specific plausible wrong implementation")
        if not overlap(wrong,surface_terms(item)): errors.append(f"requirement {rid} plausible wrong implementation is not bound to declared risk surfaces")
        require_novel_detail(wrong,surface_identity_terms(item),f"requirement {rid} plausible wrong implementation",errors)
        pc=item.get("positive_control")
        if not isinstance(pc,dict) or pc.get("status")!="passed" or pc.get("head_sha")!=a.head_sha: errors.append(f"requirement {rid} positive control not passed on candidate")
        neg=item.get("negative_controls") or []
        if not neg: errors.append(f"requirement {rid} lacks negative controls")
        if any(not isinstance(c,dict) or c.get("status")!="passed" or c.get("head_sha")!=a.head_sha for c in neg): errors.append(f"requirement {rid} has negative control not passed on candidate")
        for index,control in enumerate(neg):
            if not isinstance(control,dict): continue
            label=f"requirement {rid} negative control {index}"
            for key,chars,count in (("failure_mode",12,6),("plausible_wrong_implementation",20,6),("procedure",12,6),("expected",8,5),("observed",8,5)):
                if not ok_text(control.get(key),chars,count): errors.append(f"{label} lacks specific {key}")
            for key in ("id","risk_family","surface","dimension"):
                if not str(control.get(key) or "").strip(): errors.append(f"{label} lacks {key}")
            if not SHA256_RE.match(str(control.get("evidence_sha256") or "")): errors.append(f"{label} lacks valid evidence_sha256")
            errors.extend(semantic_errors(control,label))
        reg=item.get("regression_controls") or []
        if not reg: errors.append(f"requirement {rid} lacks regression controls")
        if any(not isinstance(c,dict) or c.get("status")!="passed" or c.get("head_sha")!=a.head_sha for c in reg): errors.append(f"requirement {rid} has regression control not passed on candidate")
    families={str(i.get("family")):i for i in risk.get("families") or [] if isinstance(i,dict)}; missing=sorted(CANONICAL-set(families))
    if missing: errors.append(f"risk saturation omits canonical families: {missing}")
    for family,item in families.items():
        if item.get("applicable") is True and (item.get("status")!="passed" or not item.get("control_ids")): errors.append(f"risk family {family} is applicable but unsaturated")
    if risk.get("material_families_missing_controls"): errors.append("risk saturation reports missing material controls")
    if inherited.get("unresolved_controls"): errors.append("inherited controls unresolved")
    for item in inherited.get("controls") or []:
        cid=item.get("id") if isinstance(item,dict) else "?"
        if not isinstance(item,dict) or item.get("status")!="passed" or item.get("head_sha")!=a.head_sha: errors.append(f"inherited control {cid} not passed on candidate")
    if errors:
        for e in errors: print(f"BLOCK: {e}")
        return 2
    print("READY: delivery packet has semantically bound adversarial evidence")
    return 0
if __name__=="__main__": raise SystemExit(main())
