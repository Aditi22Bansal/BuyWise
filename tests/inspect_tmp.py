"""Show gateway envelopes compactly (temp)."""
import json
import subprocess

out = subprocess.run(
    ['docker', 'exec', 'buywise-postgres', 'psql', '-U', 'buywise', '-d', 'buywise',
     '-t', '-A', '-c', 'SELECT ed.data FROM execution_data ed WHERE ed."executionId" = 167;'],
    capture_output=True, text=True, encoding='utf-8', errors='replace')
d = json.loads(out.stdout)
s = json.dumps(d)
import re
for m in re.finditer(r'\{[^{}]*"source"[^{}]*\}', s):
    print(m.group(0)[:400])
    print('---')
    break
print('total envelopes?', len(re.findall(r'"data_status"', s)))
