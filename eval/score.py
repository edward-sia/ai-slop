import json,sys,collections,re
p=sys.argv[1]
# second arg picks the label axis: 'quality' (default) or 'provenance'
AXIS='label_'+(sys.argv[2] if len(sys.argv)>2 else 'quality')
d=json.load(open(p))
for x in d:
    if AXIS in x: x['label']=x[AXIS]
print(f'grading against {AXIS}')
tp=sum(1 for x in d if x['label']=='SLOP' and x['pred']=='SLOP')
fn=sum(1 for x in d if x['label']=='SLOP' and x['pred']=='HUMAN')
fp=sum(1 for x in d if x['label']=='HUMAN' and x['pred']=='SLOP')
tn=sum(1 for x in d if x['label']=='HUMAN' and x['pred']=='HUMAN')
n=len(d)
acc=(tp+tn)/n
prec=tp/(tp+fp) if tp+fp else 0
rec=tp/(tp+fn) if tp+fn else 0
f1=2*prec*rec/(prec+rec) if prec+rec else 0
print(f"n={n}  accuracy={acc:.1%}   precision={prec:.1%}  recall={rec:.1%}  F1={f1:.2f}")
print(f"confusion:  TP={tp}  FP={fp}  FN={fn}  TN={tn}")
print(f"flag rate = {(tp+fp)/n:.1%}  (base rate of SLOP in corpus = {sum(1 for x in d if x['label']=='SLOP')/n:.1%})")
print()
print("per-bucket accuracy:")
b=collections.defaultdict(lambda:[0,0])
for x in d:
    b[x['bucket']][1]+=1
    if x['pred']==x['label']: b[x['bucket']][0]+=1
for k in sorted(b): 
    c,t=b[k]; print(f"  {k:34s} {c}/{t}  ({c/t:.0%})")
print()
# output hygiene
exact=sum(1 for x in d if x['raw'].strip().upper().rstrip('.') in ('YES','NO'))
has_yes=sum(1 for x in d if 'YES' in x['raw'].upper())
has_no =sum(1 for x in d if 'NO' in x['raw'].upper())
both   =sum(1 for x in d if 'YES' in x['raw'].upper() and 'NO' in x['raw'].upper())
print(f"OUTPUT HYGIENE (this is what .includes('YES') is parsing):")
print(f"  replies that are exactly YES or NO : {exact}/{n} ({exact/n:.0%})")
print(f"  replies containing 'YES' anywhere  : {has_yes}/{n}")
print(f"  replies containing 'NO' anywhere   : {has_no}/{n}   <-- 'NO' also matches NOT/KNOW/NOTE")
print(f"  replies containing BOTH            : {both}/{n}   <-- .includes('YES') silently wins")
import statistics
ms=[x['ms'] for x in d]
print(f"\nlatency per paragraph: median {statistics.median(ms):.0f}ms  mean {statistics.mean(ms):.0f}ms  max {max(ms)}ms")
lens=[len(x['raw']) for x in d]
print(f"raw reply length: median {statistics.median(lens):.0f} chars  max {max(lens)} chars (asked for 1 word)")
