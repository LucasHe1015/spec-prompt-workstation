# Tag 中文翻译规范（本地 AI 生图提示词词库）

## 目标
把 selected_tags.csv 第二列英文 tag（Danbooru 风格）逐条译为简体中文，产出 en -> zh-Hans 词库，供本地提示词翻译台使用。

## 输出格式
- 每个分片写一个 UTF-8 JSON 对象文件：{"<CSV 原名>": "<中文>"}。
- key **必须**与 CSV 第二列完全一致（保留下划线，如 long_hair）。
- value 只写中文译文本身：不要加引号、不要加英文括注、不要加解释、不要加句号。
- 严禁重复 key；严禁 JSON 注释、尾逗号；文件必须能被 json.load 解析。
- 无法确定译法的 key，value 写 null，并在同目录 <shard>.unknown.txt 里逐行写 "key<TAB>你的疑问"。

## 用词风格
- 简体中文，书面、直白、短；与 data/glossary.json 现有条目风格一致（先读它，能复用就复用，务必保持一致）。
- 不加空格、不加标点；中文与数字/字母之间也不加空格（如 4koma -> 四格漫画）。
- 身材/部位类：短词优先（长发、蓝瞳、锁骨、肚脐、过膝袜）。
- 颜色 + 部位统一后缀：*_hair -> *发，*_eyes -> *瞳，如 light_purple_hair -> 浅紫发，orange_eyes -> 橙瞳。
- 数量前缀用阿拉伯数字：2girls -> 2个女孩，6+girls -> 6个以上女孩，multiple_girls -> 多个女孩。
- 服饰按现有词库：shirt 衬衫、skirt 半身裙、dress 连衣裙、thighhighs 过膝袜、pantyhose 连裤袜、leotard 紧身连体衣。
- 视角/构图：from_below 仰视视角、from_above 俯视视角、cowboy_shot 七分身构图、dutch_angle 倾斜构图。

## NSFW
- 词库用于本地模型提示词，直译解剖学与性行为术语，用通用中文词（如 penis 阴茎、pussy 阴部、fellatio 口交、doggystyle 后入式、cum 精液）。
- 不美化、不模糊、不加警示语、不跳过。

## 颜文字与符号
- 形如 :d、:3、^ ^、> <、o o、= =、| |、@ @、;d、:<、:q、:t、!、?... 的 tag 视为颜文字/符号：能明确含义的写成意译并保留符号，如 :d -> :D大笑；纯符号直接保留原样（如 o o、| |、@ @、...、?)。
- star_(symbol) -> 星形符号，star_(sky) -> 天空的星星。

## 角色名（category=4）
- 知名角色用通行中文名：hatsune_miku -> 初音未来；rem_(re:zero) -> 雷姆(Re:从零开始的异世界生活)。
- 格式：角色名(作品名)，作品用通行中文名，不确定的作品名保留英文原名。
- 完全不知名的角色：保留英文原名原样，只把作品名译出或原样保留，例如 foo_bar_(some_series) -> foo bar(some series)。
- 需要查证时可用 web_search / web_fetch（Danbooru wiki、萌娘百科、Wikipedia）。

## 工作流
1. 读 data/glossary.json 建立术语基线。
2. 读指定 shard 文件（每行一个 CSV 原名）。
3. 分批翻译，每批 100-200 条，写回自己的分片 JSON 文件（先写全量再逐步补充也行，但最终文件必须完整覆盖 shard 所有 key）。
4. 自查：条数 == shard 行数；无 null 遗漏（除非确实不确定）；JSON 可解析。
5. 回报：文件路径 + 条数 + 不确定条数与示例 3 条。
