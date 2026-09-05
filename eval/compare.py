import json,sys,glob,os,collections
AXIS='label_quality'
rows=[]
for f in sorted(sys.argv[1:]):
    d=json.load(open(f))
    lab=lambda x: x.get(AXIS, x['label'])
    tp=sum(1 for x in d if lab(x)=='SLOP'  and x['pred']=='SLOP')
    fp=sum(1 for x in d if lab(x)=='HUMAN' and x['pred']=='SLOP')
    fn=sum(1 for x in d if lab(x)=='SLOP'  and x['pred']=='HUMAN')
    tn=sum(1 for x in d if lab(x)=='HUMAN' and x['pred']=='HUMAN')
    n=len(d); prec=tp/(tp+fp) if tp+fp else 0; rec=tp/(tp+fn) if tp+fn else 0
    f1=2*prec*rec/(prec+rec) if prec+rec else 0
    b=collections.defaultdict(lambda:[0,0])
    for x in d:
        b[x['bucket']][1]+=1
        if x['pred']==lab(x): b[x['bucket']][0]+=1
    rows.append((os.path.basename(f).replace('results_','').replace('_qwen3_4b.json',''),
                 n,(tp+tn)/n,prec,rec,f1,fp,fn,dict(b)))
print(f"{'run':22s}{'n':>4s}{'acc':>8s}{'prec':>8s}{'rec':>8s}{'F1':>7s}{'FP':>4s}{'FN':>4s}")
for r in rows:
    print(f"{r[0]:22s}{r[1]:>4}{r[2]:>7.1%}{r[3]:>8.1%}{r[4]:>8.1%}{r[5]:>7.2f}{r[6]:>4}{r[7]:>4}")
buckets=sorted({k for r in rows for k in r[8]})
print(f"\n{'bucket':32s}"+''.join(f"{r[0][:11]:>13s}" for r in rows))
for bk in buckets:
    line=f"{bk:32s}"
    for r in rows:
        c,t=r[8].get(bk,[0,0]); line+=f"{(str(c)+'/'+str(t)):>13s}"
    print(line)
