#!/usr/bin/env python3
import argparse, hashlib, json
from pathlib import Path

SKILLS = [
    'entregar-issue', 'revisar-issue', 'fluxos-conversacionais',
    'documentacao-repositorio', 'design-interface', 'corrigir-ci', 'auditar-issue'
]

def git_blob_sha(data: bytes) -> str:
    return hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()

def describe(root: Path):
    digest = hashlib.sha256(); files = []
    for file in sorted(path for path in root.rglob('*') if path.is_file()):
        rel = file.relative_to(root).as_posix(); data = file.read_bytes()
        sha256 = hashlib.sha256(data).hexdigest()
        digest.update(rel.encode()); digest.update(b'\0'); digest.update(sha256.encode()); digest.update(b'\n')
        files.append({'path': rel, 'git_blob_sha': git_blob_sha(data), 'sha256': sha256, 'size': len(data)})
    return {'digest': 'sha256:' + digest.hexdigest(), 'files': len(files), 'entries': files}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', default='/home/oai/skills')
    parser.add_argument('--output', required=True)
    parser.add_argument('--details-output')
    args = parser.parse_args()
    root = Path(args.source_root)
    manifest = {'schema_version': 1, 'source': 'chatgpt-web-installed-skills', 'skills': {}}
    details = {'skills': {}}
    for name in SKILLS:
        skill = root / name
        if not skill.is_dir(): raise SystemExit(f'missing installed skill: {skill}')
        info = describe(skill)
        manifest['skills'][name] = {'digest': info['digest'], 'files': info['files']}
        details['skills'][name] = info['entries']
    Path(args.output).write_text(json.dumps(manifest, indent=2) + '\n')
    if args.details_output:
        Path(args.details_output).write_text(json.dumps(details, indent=2) + '\n')
    print(json.dumps(manifest, indent=2))
if __name__ == '__main__': main()
