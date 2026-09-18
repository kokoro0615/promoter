"""Static package checks only; this does not test a running application or database."""
from pathlib import Path
import csv,hashlib,json,re,sys
from datetime import datetime,timezone
import yaml
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012
ROOT=Path(__file__).resolve().parents[1]
results=[]
def check(name,fn):
    try:
        detail=fn();results.append({'check':name,'status':'PASS','detail':detail or 'OK'})
    except Exception as exc:
        results.append({'check':name,'status':'FAIL','detail':str(exc)})
def loadj(p):return json.loads((ROOT/p).read_text(encoding='utf-8'))
def csvrows(p):return list(csv.DictReader((ROOT/p).open(encoding='utf-8-sig')))
def ensure(condition,msg):
    if not condition:raise AssertionError(msg)
def parse_all():
    count=0
    for f in ROOT.rglob('*'):
        if f.suffix=='.json':json.loads(f.read_text());count+=1
        elif f.suffix in ['.yaml','.yml']:yaml.safe_load(f.read_text());count+=1
    return f'{count} JSON/YAML parsed'
check('JSON_YAML_PARSE',parse_all)
def schema_examples():
    count=0
    for example in list((ROOT/'config').glob('*.example.json'))+list((ROOT/'api').glob('*.example.json')):
        schema=example.with_name(example.name.replace('.example.json','.schema.json'))
        if not schema.exists():continue
        definition=json.loads(schema.read_text());Draft202012Validator.check_schema(definition)
        Draft202012Validator(definition,format_checker=FormatChecker()).validate(json.loads(example.read_text()));count+=1
    return f'{count} schemas and example instances valid'
check('JSON_SCHEMA_EXAMPLES',schema_examples)
api=yaml.safe_load((ROOT/'api/openapi.yaml').read_text());model=loadj('db/model.json');tables=model['tables'];by={t['name']:t for t in tables}
def pointer(ref):
    ensure(ref.startswith('#/'),'External ref not bundled: '+ref);obj=api
    for p in ref[2:].split('/'):obj=obj[p.replace('~1','/').replace('~0','~')]
    return obj
def api_checks():
    found=[]
    def walk(x):
        if isinstance(x,dict):
            if '$ref' in x:pointer(x['$ref'])
            for v in x.values():walk(v)
        elif isinstance(x,list):
            for v in x:walk(v)
    walk(api)
    for path,methods in api['paths'].items():
        for method,op in methods.items():
            if method not in ['get','post','put','patch','delete','options','head']:continue
            found.append(op['operationId']);params=[pointer(p['$ref']) if '$ref' in p else p for p in op.get('parameters',[])]
            expected=set(re.findall(r'{(\w+)}',path));actual={p['name'] for p in params if p['in']=='path'}
            ensure(expected==actual,f'Path params mismatch {path}')
            ensure(all(p.get('required') for p in params if p['in']=='path'),path)
            ensure(any(str(k).startswith('2') for k in op['responses']),op['operationId'])
    ensure(len(found)==len(set(found)),'Duplicate operation_id')
    for name,s in api['components']['schemas'].items():Draft202012Validator.check_schema(s)
    # Embedded document refs must resolve under OpenAPI, not the removed schema root.
    registry=Registry().with_resource("urn:nightclub:v4:openapi",Resource(contents=api,specification=DRAFT202012))
    for name,ex in [('PolicyDocument','config/policy.example.json'),('PermitDocument','config/permit.example.json')]:
        Draft202012Validator({'$ref':'urn:nightclub:v4:openapi#/components/schemas/'+name},registry=registry,format_checker=FormatChecker()).validate(loadj(ex))
    return f'{len(api["paths"])} paths / {len(found)} operations / {len(api["components"]["schemas"])} component schemas; internal references and example embedding checked (not a full OpenAPI product validator)'
check('OPENAPI_INTERNAL_CONTRACT',api_checks)
def model_checks():
    ensure(len(by)==len(tables),'Duplicate table')
    for t in tables:
        names=[c['name'] for c in t['columns']];ensure(len(names)==len(set(names)),t['name'])
        for k in t['uniques']:ensure(set(k)<=set(names),f'{t["name"]}: unique columns')
        for fk in t['foreign_keys']:
            ensure(fk['target'] in by,fk);target=by[fk['target']]
            ensure(set(fk['columns'])<=set(names),fk)
            ensure(set(fk['target_columns'])<=set(c['name'] for c in target['columns']),fk)
            ensure(fk['target_columns']==['id'] or fk['target_columns'] in target['uniques'],fk)
            ensure(len(fk['columns'])==len(fk['target_columns']),fk)
        if t['scope'] in ['store','event']:ensure('tenant_id'in names and 'store_id'in names,t['name'])
    cols=csvrows('db/data_dictionary.csv');ensure(len(cols)==sum(len(t['columns']) for t in tables),'dictionary count')
    sql=(ROOT/'db/reference_schema.sql').read_text();ensure(len(re.findall(r'CREATE TABLE nightclub\.',sql))==len(tables),'DDL table count')
    er=(ROOT/'diagrams/er_full_r1.mmd').read_text();entities=set(re.findall(r'^    (\w+) \{',er,re.M));ensure(entities==set(by),'ER entity mismatch')
    for t in tables:ensure(f'ALTER TABLE nightclub.{t["name"]} FORCE ROW LEVEL SECURITY;' in sql,t['name'])
    return f'{len(tables)} tables / {len(cols)} columns / {sum(len(t["foreign_keys"]) for t in tables)} foreign keys; names, target keys, scope columns, dictionary/DDL/ER counts matched. SQL execution NOT_RUN'
check('MODEL_DDL_DICTIONARY_ER_STATIC',model_checks)
legacy=csvrows('planning/legacy_143_traceability.csv');reqs=csvrows('planning/requirements_traceability.csv');tests=csvrows('tests/acceptance_cases.csv')
def trace_checks():
    base=(ROOT/'baseline/requirements_v3_original.md').read_text()
    original=set(re.findall(r'^\| ([A-Z]+-\d+)<br>',base,re.M))-{f'AT-{i:02d}' for i in range(1,61)}
    current={r['legacy_id'] for r in legacy};ensure(len(legacy)==143 and current==original,f'Legacy count/diff: {len(original)}, {len(legacy)}')
    ensure(len({r['requirement_id'] for r in reqs})==len(reqs),'Duplicate detailed requirement')
    main=(ROOT/'docs/requirements_v4.md').read_text();ids=set(re.findall(r'^\| (V[34]-[A-Z]+-\d+) \|',main,re.M));ensure(ids=={r['requirement_id'] for r in reqs},'Detailed requirement diff')
    ensure(len({t['test_id'] for t in tests})==len(tests),'Duplicate test ID');ensure(len(tests)==104,'Expected 104 acceptance cases')
    ensure(all(t['status']=='NOT_RUN' for t in tests),'Acceptance cases must not be falsely marked passed')
    known=ids|current
    for t in tests:
        for ref in re.findall(r'V[34]-[A-Z]+-\d+',t['requirements']):ensure(ref in known,t['test_id']+' unknown '+ref)
    ops={o['operationId'] for m in api['paths'].values() for o in m.values() if isinstance(o,dict) and 'operationId' in o}
    for r in reqs:
        for ref in filter(None,r['direct_operation_ids'].split(';')):ensure(ref in ops,r)
    return f'{len(legacy)} inherited IDs / {len(reqs)} detailed requirements / {len(tests)} acceptance cases / all acceptance NOT_RUN'
check('TRACEABILITY',trace_checks)
def mermaid_checks():
    r=loadj('validation/mermaid_results.json');files={p.name for p in (ROOT/'diagrams').glob('*.mmd')};ensure(files=={x['file'] for x in r},'Mermaid result coverage')
    ensure(all(x.get('parse')=='PASS' and x.get('render')=='PASS' for x in r),'Mermaid parse/render failed')
    for f in files:ensure((ROOT/'diagrams/svg'/f.replace('.mmd','.svg')).exists(),f)
    return f'{len(r)} Mermaid sources parsed and rendered by local Mermaid engine; results are from the generation run'
check('MERMAID_RECORDED_RESULTS',mermaid_checks)
def file_links():
    total=0
    for md in [ROOT/'README.md',ROOT/'docs/requirements_v4.md']:
        for target in re.findall(r'\]\(([^)]+)\)',md.read_text()):
            if re.match(r'(https?:|#|mailto:)',target):continue
            ensure((md.parent/target).exists(),str(md)+': '+target);total+=1
    ensure(hashlib.sha256((ROOT/'baseline/requirements_v3_original.md').read_bytes()).hexdigest()=='8c3b7742b6a5191703f0f4f71d255f4c24c6445f43fc7f43bfda2ff2d345cfe0','Baseline changed')
    return f'{total} local links and original v3 SHA-256 checked'
check('LINKS_AND_BASELINE',file_links)
report={'checked_at_utc':datetime.now(timezone.utc).isoformat(),'scope':'STATIC_DOCUMENT_AND_REFERENCE_CHECKS_ONLY','results':results,'counts':{'tables':len(tables),'columns':sum(len(t['columns']) for t in tables),'foreign_keys':sum(len(t['foreign_keys']) for t in tables),'paths':len(api['paths']),'operations':sum(1 for ms in api['paths'].values() for o in ms.values() if isinstance(o,dict) and 'operationId' in o),'legacy_requirements':len(legacy),'detailed_requirements':len(reqs),'acceptance_tests':len(tests),'mermaid_sources':len(list((ROOT/'diagrams').glob('*.mmd')))}}
(ROOT/'validation/static_checks.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
for r in results:print(r['status'],r['check'],r['detail'])
sys.exit(1 if any(r['status']=='FAIL' for r in results) else 0)
