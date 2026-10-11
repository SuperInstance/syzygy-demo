#!/usr/bin/env python3
"""Deploy the syzygy-rack Worker via the Cloudflare API (skill route).

Uses the connected Cloudflare credential through the skill's surrogate
helpers — no raw token is read, printed, or stored. Uploads worker.js with
its KV binding + plain-text vars, then enables the workers.dev subdomain.

Provider SECRETS are deliberately NOT set here: this script never handles
provider keys. Set them once with wrangler or the dashboard (see README.md):

    wrangler secret put MINIMAX_API_KEY
    wrangler secret put TYPESAFE_API_KEY
    wrangler secret put MOTH_API_KEY
"""
import sys, os, json, tempfile
sys.path.insert(0, '/opt/hatch/skills/skill-creator/bin')
sys.path.insert(0, os.path.expanduser('~/workspace/skills/cloudflare/bin'))
from cf_api import request, multipart

WORKER_NAME = 'syzygy-rack'
KV_TITLE = 'SYZ_RACK_COUNTERS'
HERE = os.path.dirname(os.path.abspath(__file__))

PLAIN_VARS = {
    'ALLOWED_ORIGINS': 'https://superinstance.github.io,http://127.0.0.1:8734,http://localhost:8734',
    'PACE_MS': '2500',
    'PERCEIVE_DAILY_CAP': '600',
    'JUDGE_DAILY_CAP': '250',
    'MOTH_DAILY_CAP': '50',
}


def main():
    accounts = request('GET', '/client/v4/accounts')
    if not accounts.get('success') or not accounts['result']:
        sys.exit(f"accounts lookup failed: {accounts}")
    account_id = accounts['result'][0]['id']

    kv = request('GET', f'/client/v4/accounts/{account_id}/storage/kv/namespaces')
    ns = next((n for n in kv.get('result', []) if n['title'] == KV_TITLE), None)
    if not ns:
        ns = request('POST', f'/client/v4/accounts/{account_id}/storage/kv/namespaces',
                     data=json.dumps({'title': KV_TITLE}).encode())['result']
    print(f'KV namespace {KV_TITLE}: {ns["id"]}')

    metadata = {
        'main_module': 'worker.js',
        'compatibility_date': '2024-11-01',
        'bindings': [
            {'type': 'kv_namespace', 'name': 'RACK', 'namespace_id': ns['id']},
        ] + [
            {'type': 'plain_text', 'name': k, 'text': v} for k, v in PLAIN_VARS.items()
        ],
    }
    with tempfile.TemporaryDirectory() as td:
        meta_path = os.path.join(td, 'metadata.json')
        with open(meta_path, 'w') as f:
            json.dump(metadata, f)
        spec_path = os.path.join(td, 'spec.json')
        with open(spec_path, 'w') as f:
            json.dump({'fields': {}, 'files': {
                'metadata': {'path': meta_path, 'ctype': 'application/json'},
                'worker.js': {'path': os.path.join(HERE, 'worker.js'),
                              'ctype': 'application/javascript+module'},
            }}, f)
        out = multipart(f'/client/v4/accounts/{account_id}/workers/scripts/{WORKER_NAME}', spec_path)
    if not out.get('success'):
        sys.exit(f'upload failed: {json.dumps(out)[:800]}')
    print(f'Worker {WORKER_NAME} uploaded.')

    sub = request('GET', f'/client/v4/accounts/{account_id}/workers/subdomain')
    subdomain = sub['result']['subdomain']
    en = request('POST', f'/client/v4/accounts/{account_id}/workers/scripts/{WORKER_NAME}/subdomain',
                 data=json.dumps({'enabled': True}).encode())
    print('subdomain enable:', en.get('success'))
    print(f'URL: https://{WORKER_NAME}.{subdomain}.workers.dev')
    print()
    print('Provider secrets are NOT set by this script. To seat the house keys:')
    print('  wrangler secret put MINIMAX_API_KEY    # MiniMax console key')
    print('  wrangler secret put TYPESAFE_API_KEY   # Typesafe console key')
    print('  wrangler secret put MOTH_API_KEY       # Moth Quantum console key')
    print('(or dashboard: Workers & Pages -> syzygy-rack -> Settings -> Variables and Secrets)')


if __name__ == '__main__':
    main()
