# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 LucasHe1015
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
sh=[l.strip() for l in open(sys.argv[2],encoding='utf-8') if l.strip()]
miss=[k for k in sh if k not in d]
open('data/_miss_tmp.txt','w',encoding='utf-8').write(chr(10).join(miss))
print(len(miss))
print(', '.join(miss))