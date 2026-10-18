"""Pass procurement mode through n8n intake -> create_case (repo + live DB)."""
import json
import psycopg2

ROOT = 'D:/flexi'
env = {}
with open(ROOT + '/.env', encoding='utf-8') as f:
    for line in f:
        if '=' in line and not line.strip().startswith('#'):
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()

OLD_OUT = "requested_by: b.requested_by ?? null, auto_close_on_proceed: b.auto_close_on_proceed === true } }];"
NEW_OUT = ("requested_by: b.requested_by ?? null, auto_close_on_proceed: b.auto_close_on_proceed === true, "
           "mode: (b.mode === 'DEMO' ? 'DEMO' : 'REAL'), demo_reason: (b.mode === 'DEMO' ? String(b.demo_reason || '') : null) } }];")

OLD_INS = ("INSERT INTO procurement_cases (procurement_id,status,requirement,quantity,budget,currency,delivery_requirement,mandatory_specs,preferred_specs,weights_json,created_by) "
           "VALUES ($1,'created',$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING procurement_id,status")
NEW_INS = ("INSERT INTO procurement_cases (procurement_id,status,requirement,quantity,budget,currency,delivery_requirement,mandatory_specs,preferred_specs,weights_json,created_by,mode) "
           "VALUES ($1,'created',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING procurement_id,status,mode")
OLD_VALS = "op.payload.requested_by ?? null] });"
NEW_VALS = "op.payload.requested_by ?? null, (op.payload.mode === 'DEMO' ? 'DEMO' : 'REAL')] });"


def fix_doc(d):
    n = 0
    for node in d['nodes']:
        js = (node.get('parameters') or {}).get('jsCode', '')
        if not isinstance(js, str):
            continue
        orig = js
        if node.get('name') == 'Validate Intake' and OLD_OUT in js:
            js = js.replace(OLD_OUT, NEW_OUT)
        if 'create_case' in js and OLD_INS in js:
            js = js.replace(OLD_INS, NEW_INS).replace(OLD_VALS, NEW_VALS)
        if js != orig:
            node['parameters']['jsCode'] = js
            n += 1
    return n


for f in [ROOT + '/n8n/workflows/00-orchestrator-buywise.json',
          ROOT + '/n8n/workflows/90-util-state-manager.json']:
    d = json.load(open(f, encoding='utf-8'))
    print('repo', f.split('/')[-1], 'patched nodes:', fix_doc(d))
    json.dump(d, open(f, 'w', encoding='utf-8'), indent=2)

conn = psycopg2.connect(host='localhost', port=5432, dbname='buywise',
                        user='buywise', password=env['POSTGRES_PASSWORD'])
conn.autocommit = True
cur = conn.cursor()
cur.execute("SELECT id, name, nodes FROM workflow_entity WHERE name IN ('00-orchestrator-buywise','90-util-state-manager')")
for wid, name, nodes in cur.fetchall():
    if isinstance(nodes, str):
        nodes = json.loads(nodes)
    d = {'nodes': nodes}
    if fix_doc(d):
        cur.execute('UPDATE workflow_entity SET nodes=%s, "updatedAt"=now() WHERE id=%s',
                    (json.dumps(d['nodes']), wid))
        print('live fixed:', name)
cur.close()
conn.close()
print('DONE')
