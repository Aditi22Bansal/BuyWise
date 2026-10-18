"""BuyWise n8n relink tool: resolve every execute/toolWorkflow reference to live IDs.
Run after importing workflows: python3 tools/n8n_relink.py
Repo files intentionally use workflow NAMES (portable); n8n 1.107 resolves only
resource-locator IDs at runtime, so this tool rewrites live DB rows. Idempotent.
"""
import json
import re
import sys

import psycopg2

ROOT = 'D:/flexi'


def load_env():
    env = {}
    with open(ROOT + '/.env', encoding='utf-8') as f:
        for line in f:
            if '=' in line and not line.strip().startswith('#'):
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip()
    return env


def main():
    env = load_env()
    conn = psycopg2.connect(host='localhost', port=int(env.get('POSTGRES_PORT', '5432')),
                            dbname=env.get('POSTGRES_DB', 'buywise'),
                            user=env.get('POSTGRES_USER', 'buywise'),
                            password=env['POSTGRES_PASSWORD'])
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute('SELECT id, name FROM workflow_entity')
    name_to_id = {name: wid for wid, name in cur.fetchall()}
    fixed = []

    def ref_to_locator(value):
        target = None
        if isinstance(value, str) and value in name_to_id:
            target, label = name_to_id[value], value
        elif isinstance(value, dict):
            v = value.get('value')
            if v in name_to_id.values():
                return None  # already a live id
            if v in name_to_id:
                target, label = name_to_id[v], v
        if target is None:
            return None
        return {'__rl': True, 'mode': 'list', 'value': target, 'cachedResultName': label}

    cur.execute('SELECT id, name, nodes FROM workflow_entity')
    for wid, name, nodes in cur.fetchall():
        if isinstance(nodes, str):
            nodes = json.loads(nodes)
        changed = False

        def walk(o):
            nonlocal changed
            if isinstance(o, dict):
                t = o.get('type', '')
                if isinstance(t, str) and (t == 'n8n-nodes-base.executeWorkflow' or 'toolWorkflow' in t):
                    params = o.get('parameters')
                    if isinstance(params, dict) and 'workflowId' in params:
                        new = ref_to_locator(params['workflowId'])
                        if new is not None and params['workflowId'] != new:
                            params['workflowId'] = new
                            changed = True
                            fixed.append((name, o.get('name')))
                for v in o.values():
                    walk(v)
            elif isinstance(o, list):
                for v in o:
                    walk(v)

        walk(nodes)
        if changed:
            cur.execute('UPDATE workflow_entity SET nodes=%s, "updatedAt"=now() WHERE id=%s',
                        (json.dumps(nodes), wid))
    for wname, nname in fixed:
        print('reliked:', wname, '::', nname)
    if not fixed:
        print('all references already live')
    cur.close()
    conn.close()


if __name__ == '__main__':
    sys.exit(main())
