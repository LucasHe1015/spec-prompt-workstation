# -*- coding: utf-8 -*-
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 LucasHe1015
import csv, json, glob
rows=list(csv.DictReader(open('data/selected_tags.csv',encoding='utf-8')))
try:
    base={k.replace(' ','_'):v for k,v in json.load(open('data/glossary.base.json',encoding='utf-8'))['entries'].items()}
except FileNotFoundError:
    base={}
parts={}
for p in sorted(glob.glob('data/parts/*.json')):
    parts.update({k:v for k,v in json.load(open(p,encoding='utf-8')).items() if v})
g=json.load(open('data/glossary.json',encoding='utf-8'))['entries']
nocov=[r['name'] for r in rows if r['name'] not in parts]
print('CSV 无分片覆盖:',len(nocov),'全部在 base:',all(n in base for n in nocov))
if not all(n in base for n in nocov):
    print('base 也缺:',[n for n in nocov if n not in base])
print('final entries',len(g),'null',sum(1 for v in g.values() if not v))
for k in ['boo tao (genshin impact)','pyonta','akari (pokemon)','shinjou akane','shirase sakuya','nishi kinuyo','elin','tamura yuri','rabbit yukine','kondou taeko','jill stingray','wakan tanka','puru-see (hoshizuki (seigetsu))','kita high school uniform','ryouou school uniform','kibito high school uniform','sakugawa school uniform','planted','impossible shirt','skin fangs','enpera','okamisty','alphes (style)','oda uri','kotoyoro','general','sensitive','questionable','explicit']:
    print(' ',k,'=>',g.get(k,'<MISSING>'))
