# -*- coding: utf-8 -*-
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 LucasHe1015
import json, random, csv
g=json.load(open('data/glossary.json',encoding='utf-8'))
print('meta', g['meta'])
e=g['entries']; print('entries', len(e))
print('null_values', sum(1 for v in e.values() if not v))
keys=list(e)
random.seed(7)
for k in random.sample(keys,15): print(' ', k, '=>', e[k])
print('--- nsfw spot ---')
for k in ['penis','nipples','gokkun','ahegao','bondage','snow','snowing','rating_explicit' ]:
    if k in e: print(' ',k,'=>',e[k])
