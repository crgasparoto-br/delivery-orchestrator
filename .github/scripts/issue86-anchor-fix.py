from pathlib import Path
p = Path('.github/scripts/issue86-final-remediation.py')
s = p.read_text()
old = '''for script in ['scripts/run-delivery-v2-controller.mjs', 'scripts/resume-delivery-v2-controller.mjs']:
    p = Path(script)
    s = p.read_text()
    marker = "function higherRisk(next, current) {\\n  return RISK_RANK[next] > RISK_RANK[current];\\n}\\n"
    if s.count(marker) != 1:
        raise SystemExit(f'{script}: higherRisk anchor mismatch')
    s = s.replace(marker, marker + "\\n" + promotion_helper, 1)
    p.write_text(s)
'''
new = '''for script in ['scripts/run-delivery-v2-controller.mjs', 'scripts/resume-delivery-v2-controller.mjs']:
    p = Path(script)
    s = p.read_text()
    markers = [
        "function higherRisk(next, current) {\\n  return RISK_RANK[next] > RISK_RANK[current];\\n}\\n",
        "function higherRisk(next, current) { return RISK_RANK[next] > RISK_RANK[current]; }\\n"
    ]
    marker = next((candidate for candidate in markers if s.count(candidate) == 1), None)
    if marker is None:
        raise SystemExit(f'{script}: higherRisk anchor mismatch')
    s = s.replace(marker, marker + "\\n" + promotion_helper, 1)
    p.write_text(s)
'''
if s.count(old) != 1:
    raise SystemExit(f'expected one staging loop, got {s.count(old)}')
p.write_text(s.replace(old, new, 1))
