# -*- coding: utf-8 -*-
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 LucasHe1015
"""Merge translation parts into the tag glossary.

Layers (低 -> 高优先级):
  1. data/glossary.base.json   原始人工词表基线
  2. data/parts/*.json          分片翻译产物（key 为 CSV 原名，保留下划线）
输出:
  data/glossary.json           en(空格形式) -> zh，按中文值升序(拼音)
  data/glossary_zh.csv         审阅用表格
  data/build_report.txt        统计与冲突报告
"""
import csv, json, os, sys, glob, collections
from pypinyin import lazy_pinyin

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

rows = list(csv.DictReader(open('data/selected_tags.csv', encoding='utf-8')))
base = json.load(open('data/glossary.base.json', encoding='utf-8'))['entries']
parts = {}
part_src = collections.defaultdict(dict)
for p in sorted(glob.glob('data/parts/*.json')):
    d = json.load(open(p, encoding='utf-8'))
    for k, v in d.items():
        if k not in parts or (parts.get(k) in (None, '') and v):
            parts[k] = v
        part_src[k][os.path.basename(p)] = v

def norm(k):
    return k.replace('_', ' ')

base_u = {k.replace(' ', '_'): v for k, v in base.items()}

conflicts = []
merged = {}
for r in rows:
    k = r['name']
    part_v = parts.get(k)
    base_v = base_u.get(k)
    v = part_v if part_v not in (None, '') else base_v
    if part_v and base_v and part_v != base_v:
        conflicts.append((k, base_v, part_v, ','.join(sorted(part_src[k]))))
    merged[k] = v

missing = [r['name'] for r in rows if merged.get(r['name']) in (None, '')]
# 基线里存在但 CSV 没有的旧词条照旧保留
extra_base = {k: v for k, v in base_u.items() if k not in merged}

entries = {norm(k): v for k, v in merged.items() if v}
entries.update({norm(k): v for k, v in extra_base.items()})

def sk(v):
    return (lazy_pinyin(v), v)

ordered = {k: v for k, v in sorted(entries.items(), key=lambda kv: (sk(kv[1]), kv[0]))}

glossary = {
    'meta': {
        'name': 'anime tag glossary',
        'version': 2,
        'note': 'en -> zh-Hans, Danbooru-style prompt tags',
        'source': 'data/selected_tags.csv (second column)',
        'entry_count': len(ordered),
        'sort': 'value-ascending (pinyin)',
    },
    'entries': ordered,
}
json.dump(glossary, open('data/glossary.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

with open('data/glossary_zh.csv', 'w', encoding='utf-8-sig', newline='') as f:
    w = csv.writer(f)
    w.writerow(['tag_en', 'tag_zh', 'category', 'count'])
    cat = {r['name']: (r['category'], r['count']) for r in rows}
    for en, zh in sorted(ordered.items(), key=lambda kv: (sk(kv[1]), kv[0])):
        c = cat.get(en.replace(' ', '_'), ('', ''))
        w.writerow([en, zh, c[0], c[1]])

rep = []
rep.append('CSV 条目: %d' % len(rows))
rep.append('已翻译: %d' % (len(rows) - len(missing)))
rep.append('缺失(未译): %d' % len(missing))
rep.append('基线保留(CSV 外): %d' % len(extra_base))
rep.append('输出条目总数: %d' % len(ordered))
rep.append('基线/分片冲突: %d' % len(conflicts))
if conflicts:
    rep.append('--- 冲突 (key | base | part | 来源) ---')
    for c in conflicts[:200]:
        rep.append(' | '.join(c))
if missing:
    rep.append('--- 未译 key ---')
    rep.append(', '.join(missing))
open('data/build_report.txt', 'w', encoding='utf-8').write('\n'.join(rep))
print('\n'.join(rep[:6]))
