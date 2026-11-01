# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 LucasHe1015
import json
p='data/parts/general_01.json'
d=json.load(open(p,encoding='utf-8'))
d.pop('',None)
d['=_=']='无奈眼'
d['cow_print']='奶牛纹'
json.dump(d,open(p,'w',encoding='utf-8'),ensure_ascii=False,indent=0)
sh=[l.strip() for l in open('data/shards/general_01.txt',encoding='utf-8') if l.strip()]
print('entries',len(d),'missing',[k for k in sh if k not in d])