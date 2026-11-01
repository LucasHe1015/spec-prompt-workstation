# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 LucasHe1015
import csv,json
rows=list(csv.DictReader(open('data/selected_tags.csv',encoding='utf-8')))
gen=[r['name'].replace('_',' ') for r in rows if r['category']=='0']
ch=[r['name'].replace('_',' ') for r in rows if r['category']=='4']
open('data/_general.txt','w',encoding='utf-8').write('\n'.join(gen))
open('data/_character.txt','w',encoding='utf-8').write('\n'.join(ch))
print(len(gen),len(ch))