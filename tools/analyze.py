# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 LucasHe1015
import json,csv,collections
g=json.load(open('data/glossary.json',encoding='utf-8'))
print('glossary meta',g['meta'],'entries',len(g['entries']))
rows=list(csv.DictReader(open('data/selected_tags.csv',encoding='utf-8')))
print('rows',len(rows))
print('cats',collections.Counter(r['category'] for r in rows))
names=[r['name'] for r in rows]
print('dup',len(names)-len(set(names)))
gk=set(g['entries']); ns=set(names)
print('overlap',len(gk & ns))
print('glossary-only count',len(gk-ns))
print('glossary-only sample',sorted(gk-ns)[:60])
print('first 5 counts',[ (r['name'],r['count']) for r in rows[:5]])