import json,sys
from pathlib import Path
manifest=json.loads(Path(sys.argv[1]).read_text())
runs=[]; fingerprints=set(); corpora=set(); runids=set()
for entry in manifest['runs']:
 p=Path(entry['file']); item={**entry,'complete':False,'passed':False,'issues':[]}
 if not p.exists():item['issues'].append('missing_report')
 else:
  d=json.loads(p.read_text()); fingerprints.add(d['sourceFingerprint']);corpora.add(d['corpusHash']);runids.add(d['runId'])
  item['complete']=d['status']=='completed' and len(d['results'])==5
  if d['agentVersion']!=manifest['agentVersion']:item['issues'].append('version_mismatch')
  item['elapsedMs']=d['elapsedMs']
  item['turns']=[{'index':r['index'],'issues':r.get('issues',[]),'error':r.get('error')} for r in d['results']]
  item['passed']=item['complete'] and not item['issues'] and all(not r.get('error') and not r.get('issues') for r in d['results'])
 runs.append(item)
coherent=len(fingerprints)==1 and len(corpora)==1 and len(runids)==9
cases={case:{'passed':sum(r['passed'] for r in runs if r['case']==case),'total':3,'pass3':all(r['passed'] for r in runs if r['case']==case)} for case in ['desk_chair','cat_housing','beginner_bad']}
report={'agentVersion':manifest['agentVersion'],'boundary':manifest['boundary'],'complete':all(r['complete'] for r in runs),'coherentVersionAndSources':coherent,'sourceFingerprints':sorted(fingerprints),'corpusHashes':sorted(corpora),'cases':cases,'passed':coherent and all(r['passed'] for r in runs),'runs':runs}
Path(sys.argv[2]).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='runs'},ensure_ascii=False))
sys.exit(0 if report['passed'] else 1)
