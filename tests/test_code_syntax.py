"""BuyWise Code-node syntax gate — every Code node in every workflow must parse.
Run: python3 tests/test_code_syntax.py
Catches unbalanced-brace insertion bugs before they reach n8n (where they surface
only as runtime 'Unexpected token' failures). Also asserts all sub-workflow
triggers accept passthrough input (inputSource), required by n8n >= 1.100."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path('D:/flexi')
fails = []
count = 0
triggers = 0
for f in sorted((ROOT / 'n8n' / 'workflows').glob('*.json')):
    d = json.loads(f.read_text(encoding='utf-8'))
    for n in d['nodes']:
        if n.get('type') == 'n8n-nodes-base.code' and isinstance(n.get('parameters', {}).get('jsCode'), str):
            count += 1
            code = n['parameters']['jsCode']
            with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as tf:
                tf.write('async function __run($input, $, $env) {\n' + code + '\n}\n')
                tmp = tf.name
            r = subprocess.run(['node', '--check', tmp], capture_output=True, text=True)
            if r.returncode != 0:
                fails.append((f.name, n.get('name'), r.stderr.strip().splitlines()[:3]))
        if n.get('type') == 'n8n-nodes-base.executeWorkflowTrigger':
            triggers += 1
            if not (n.get('parameters') or {}).get('inputSource'):
                fails.append((f.name, n.get('name'), ['trigger missing inputSource=passthrough']))
        if n.get('type') == 'n8n-nodes-base.code' and isinstance(n.get('parameters', {}).get('jsCode'), str):
            if 'new URL(' in n['parameters']['jsCode']:
                fails.append((f.name, n.get('name'), ['new URL() is unavailable in the n8n sandbox; use regex host parsing']))
print('code nodes checked:', count, '| triggers checked:', triggers)
for fname, nname, err in fails:
    print('FAIL:', fname, '::', nname)
    print('\n'.join(err))
print('FAILURES:', len(fails))
sys.exit(1 if fails else 0)
