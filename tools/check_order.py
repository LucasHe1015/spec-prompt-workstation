# -*- coding: utf-8 -*-
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 LucasHe1015
import csv
from pypinyin import lazy_pinyin
rows = list(csv.reader(open('data/glossary_zh.csv', encoding='utf-8-sig')))[1:]
key = lambda z: (lazy_pinyin(z), z)
prev=None; bad=0
for en, zh, c, n in rows:
    if prev is not None and key(zh) < prev: bad+=1
    prev = key(zh)
print('rows', len(rows), 'pinyin_order_violations', bad)
print('first5', [r[1] for r in rows[:5]])
print('last5', [r[1] for r in rows[-5:]])
