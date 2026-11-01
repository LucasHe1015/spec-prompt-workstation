# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 LucasHe1015
import csv,json,os
rows=list(csv.DictReader(open('data/selected_tags.csv',encoding='utf-8')))
base=json.load(open('data/glossary.json',encoding='utf-8'))['entries']
basek=set(k.replace('_',' ') for k in base)
gen=[r['name'] for r in rows if r['category']=='0']
ch=[r['name'] for r in rows if r['category']=='4']
gen_rem=[n for n in gen if n.replace('_',' ') not in basek]
ch_rem=[n for n in ch if n.replace('_',' ') not in basek]
os.makedirs('data/shards',exist_ok=True)
def dump(name,items):
    open('data/shards/'+name,'w',encoding='utf-8').write('\n'.join(items))
    print(name,len(items))
dump('base_locked.txt',[n for n in gen if n.replace('_',' ') in basek])
gens=[gen_rem[i:i+1200] for i in range(0,len(gen_rem),1200)]
for i,g in enumerate(gens): dump('general_%02d.txt'%(i+1),g)
chs=[ch_rem[i:i+1100] for i in range(0,len(ch_rem),1100)]
for i,c in enumerate(chs): dump('character_%02d.txt'%(i+1),c)
print('total general rem',len(gen_rem),'char rem',len(ch_rem))