"""Print resolved schemas, paths or tag descriptions from the GrowthBook REST API spec.

  python3 -I tools/growthbook_schema_dump.py FeatureV2 SavedGroup Attribute   # component schemas
  python3 -I tools/growthbook_schema_dump.py --paths [prefix]                  # GET routes + query params
  python3 -I tools/growthbook_schema_dump.py --tags                            # tag descriptions

Needs PyYAML (the spec is YAML): `python3 -m venv .venv && .venv/bin/pip install pyyaml`.
"""
import json, os, sys
try:
    import yaml
except ImportError:
    sys.exit("PyYAML is required: python3 -m venv .venv && .venv/bin/pip install pyyaml")

SPEC = os.path.join(os.path.dirname(__file__), '..', 'growthbook', 'openapi.yaml')
s = yaml.safe_load(open(SPEC))

def res(r):
    o = s
    for p in r.lstrip('#/').split('/'):
        o = o[p]
    return o

def show(sch, ind=0, depth=0, seen=()):
    pad = '  ' * ind
    if '$ref' in sch:
        name = sch['$ref'].split('/')[-1]
        if name in seen or depth > 9:
            print(pad + '<' + name + '>'); return
        sch = res(sch['$ref']); seen = seen + (name,)
    for k in ('allOf', 'anyOf', 'oneOf'):
        if k in sch:
            print(pad + k + ':')
            for x in sch[k]:
                if '$ref' in x: print(pad + '  <' + x['$ref'].split('/')[-1] + '>')
                show(x, ind + 1, depth + 1, seen)
            return
    if sch.get('type') == 'object' or 'properties' in sch:
        req = set(sch.get('required', []))
        for pn, pv in sch.get('properties', {}).items():
            pv2 = res(pv['$ref']) if '$ref' in pv else pv
            tt = pv2.get('type', '')
            if isinstance(tt, list): tt = '|'.join(map(str, tt))
            extra = ''
            if 'enum' in pv2: extra = ' enum=' + json.dumps(pv2['enum'])
            if 'const' in pv2: extra = ' const=' + json.dumps(pv2['const'])
            if pv2.get('nullable'): extra += ' nullable'
            if pv2.get('deprecated'): extra += ' DEPRECATED'
            if '$ref' in pv: extra += ' <' + pv['$ref'].split('/')[-1] + '>'
            d = (pv2.get('description') or '').replace('\n', ' ')[:160]
            print(f"{pad}{pn}{'*' if pn in req else ''}: {tt}{extra}  # {d}")
            if tt == 'object' or 'properties' in pv2 or any(k in pv2 for k in ('allOf', 'anyOf', 'oneOf')):
                show(pv, ind + 1, depth + 1, seen)
            elif tt == 'array':
                it = pv2.get('items', {})
                it2 = res(it['$ref']) if '$ref' in it else it
                if 'enum' in it2: print(pad + '  items enum=' + json.dumps(it2['enum']))
                if it2.get('type') == 'object' or 'properties' in it2 or any(k in it2 for k in ('allOf', 'anyOf', 'oneOf')):
                    print(pad + '  [items]' + (' <' + it['$ref'].split('/')[-1] + '>' if '$ref' in it else '')); show(it, ind + 2, depth + 1, seen)
                else:
                    print(pad + '  items: ' + str(it2.get('type')))
        ap = sch.get('additionalProperties')
        if isinstance(ap, dict):
            print(pad + '[additionalProperties]'); show(ap, ind + 1, depth + 1, seen)

args = sys.argv[1:]
if args[:1] == ['--tags']:
    for t in s.get('tags', []):
        print(f"{t['name']}: {(t.get('description') or '').replace(chr(10), ' ')[:400]}")
elif args[:1] == ['--paths']:
    prefix = args[1] if len(args) > 1 else ''
    for p, ops in s['paths'].items():
        if not p.startswith(prefix): continue
        for m, op in ops.items():
            if m != 'get': continue
            params = [(x if '$ref' not in x else res(x['$ref'])) for x in op.get('parameters', [])]
            q = ', '.join(f"{x['name']}{'*' if x.get('required') else ''}" for x in params if x.get('in') == 'query')
            print(f"GET {p}  [{op.get('operationId')}]{'  DEPRECATED' if op.get('deprecated') else ''}  ?{q}")
else:
    for name in args:
        print(f"=== {name} ===")
        show({'$ref': '#/components/schemas/' + name})
