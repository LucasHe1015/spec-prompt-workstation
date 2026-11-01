# -*- coding: utf-8 -*-
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 LucasHe1015
import csv, json
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, PatternFill
rows = list(csv.reader(open('data/glossary_zh.csv', encoding='utf-8-sig')))
g = json.load(open('data/glossary.json', encoding='utf-8'))['entries']
wb = Workbook(); ws = wb.active; ws.title = 'glossary'
hdr = ['中文提示词','英文tag','类别','出现次数']
ws.append(hdr)
for c in ws[1]:
    c.font = Font(bold=True); c.fill = PatternFill('solid', fgColor='ECE5D6')
data = rows[1:]
for en, zh, cat, cnt in data:
    ws.append([zh, en, int(cat) if cat != '' else None, int(cnt) if cnt != '' else None])
ws.freeze_panes = 'A2'
ws.column_dimensions['A'].width = 30; ws.column_dimensions['B'].width = 36
ws.column_dimensions['C'].width = 10; ws.column_dimensions['D'].width = 12
# 校验：xlsx 顺序与 glossary.json 一致、且中文值升序
prev = None; bad = 0; mismatch = 0
for en, zh, cat, cnt in data:
    if en in g and g[en] != zh: mismatch += 1
    if prev is not None and zh < prev: bad += 1
    prev = zh
print('rows', len(data), 'order_violations', bad, 'mismatch', mismatch)
print('glossary entries', len(g))
wb.save('data/glossary_zh.xlsx')
print('saved data/glossary_zh.xlsx')
