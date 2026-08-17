import json
import subprocess
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]


def test_merge_preserves_required_attack_dimensions(tmp_path):
    closure=tmp_path/'closure.json'; catalog=tmp_path/'catalog.json'
    closure.write_text(json.dumps({'escapes':[{
        'escape_id':'A-1','escape_class':'role-secret-boundary-leak','status':'passed',
        'required_risk_families':['authorization'],
        'required_attack_dimensions':[
            {'risk_family':'authorization','surface':'environment','dimension':'cross-role-secret'},
            {'risk_family':'authorization','surface':'filesystem','dimension':'cross-role-secret'},
        ]
    }]}))
    proc=subprocess.run([sys.executable,str(ROOT/'scripts'/'merge_audit_escape_patterns.py'),'--closure',str(closure),'--catalog',str(catalog)],text=True,stdout=subprocess.PIPE)
    assert proc.returncode==0
    data=json.loads(catalog.read_text())
    dims=data['patterns'][0]['required_attack_dimensions']
    assert {d['surface'] for d in dims}=={'environment','filesystem'}
