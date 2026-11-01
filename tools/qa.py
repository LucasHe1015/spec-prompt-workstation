# -*- coding: utf-8 -*-
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 LucasHe1015
import csv, json, glob, os, re, collections
rows = list(csv.DictReader(open('data/selected_tags.csv', encoding='utf-8')))
cat = {r['name']: r['category'] for r in rows}
d = {}
src = {}
for p in sorted(glob.glob('data/parts/*.json')):
    for k, v in json.load(open(p, encoding='utf-8')).items():
        d[k] = v
        src.setdefault(k, []).append(os.path.basename(p))
bad = collections.defaultdict(list)
for k, v in d.items():
    if v is None or v == '':
        continue
    if re.search(r'[\s]', v):
        bad['space'].append((k, v))
    if re.search(r'[。，、；：！？]$', v):
        bad['tailpunct'].append((k, v))
    if re.search(r'[（）]', v) is None and re.search(r'[()]', v) and cat.get(k) != '4':
        bad['parens_nonschar'].append((k, v))
    if re.fullmatch(r'[a-zA-Z0-9 _\-]+', v):
        bad['ascii_only'].append((k, v))
print('total', len(d), 'null', sum(1 for v in d.values() if not v))
for kk, vv in bad.items():
    print(kk, len(vv), vv[:8])
dupes = collections.Counter(k for k, s in src.items() if len(s) > 1)
print('dup-keys', len(dupes), list(dupes)[:5])
