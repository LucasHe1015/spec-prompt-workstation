# S.P.E.C. 7 隐私检查清单

检查范围：本地服务、API Key、用户数据、导出与分享、前端网络行为。
检查方式：人工代码审查 + `test_privacy.py` 回归测试 + 实际 HTTP 响应头验证。

## 结论

- 当前没有发现仍未修复的高危泄露路径；
- 已修复 **1 个高危**：更换 API 地址时旧 API Key 被复用；
- 已补充 **防点击劫持响应头** 和 **导出文件预校验**；
- 仍有若干设计层面的隐私边界，需要用户在使用和分享时注意。

## 已修复项

| 等级 | 检查项 | 原问题 | 处理结果 | 验证 |
|---|---|---|---|---|
| 高 | API 地址变更后的密钥复用 | 修改 OpenAI / LibreTranslate 的 `baseUrl` 但密钥留空时，旧密钥仍会写入新配置，并在测试连接时发送给新地址 | `save_config` / `merged_draft_config` 仅在地址不变时复用旧密钥；地址变更且密钥为空则清空 | `test_changed_endpoint_does_not_reuse_stored_key` 通过 |
| 中 | 点击劫持 | 外部网站可 iframe 嵌入本机控制台并诱导点击 | 所有响应增加 `X-Frame-Options: DENY`、`Content-Security-Policy: frame-ancestors 'none'`、`nosniff`、`no-referrer` | HTTP 响应头实测通过 |
| 低 | 导出失败残留半成品 ZIP | 创建 ZIP 后才校验源文件，缺失文件会留下残包 | 先校验全部白名单文件，再创建 ZIP | 隐私测试通过 |
| 文档 | 原文同步说明过期 | README 仍写“约 5 秒自动同步”，未写 `Ctrl + Enter` 确认 | 已更新同步行为说明 | 文档检查 |

## 已覆盖的检查项

| 项目 | 状态 | 说明 |
|---|---|---|
| 只监听本机 | ✅ | 绑定 `127.0.0.1`，不对外监听 |
| DNS rebinding / 跨来源请求 | ✅ | 校验 `Host`、`Origin`、`Sec-Fetch-Site`；测试覆盖同源、跨来源、`null`、同站等组合 |
| 配置 API 脱敏 | ✅ | 读取/保存配置时不返回 API Key，只返回 `hasApiKey` |
| 上游错误信息脱敏 | ✅ | 不透传上游 URL、响应体、密钥或路径 |
| 重定向携带凭据 | ✅ | 仅允许同源重定向；跨站和降级重定向被拒绝 |
| 记录 ID / 文件路径 | ✅ | 记录 ID 正则校验；读取文件必须位于 `user_data` 内；拒绝符号链接逃逸 |
| 静态文件目录穿越 | ✅ | 只允许 `public/` 内文件，拒绝目录外路径 |
| 导出白名单 | ✅ | 只导出源码；不包含 `config.json`、`user_data`、`screenshots`、`models`、`dist`、本机词条库 |
| 导出词条库 | ✅ | 归档内写入空 `data/glossary.json`，避免带出自定义词条 |
| Git 忽略规则 | ✅ | 忽略配置、用户数据、截图、模型权重、导出包和本机词条库 |
| API Key 不回显到页面 | ✅ | 设置界面密钥输入框始终为空，仅显示“已保存密钥” |
| 服务版本信息 | ✅ | 不返回 Python 版本 |
| 本地存储提示 | ⚠️ | `localStorage` 的 `spec7:draft` 会保留原文草稿；README 已提示 |
| 数据落盘加密 | ⚠️ | `config.json` 和 `user_data` 不加密，依赖本机账户权限 |
| 文件权限加固 | ⚠️ | 未强制设置 `config.json` / 用户数据为仅当前用户可读 |
| 自动外发行为 | ⚠️ | 健康检查会探测配置端点；原文自动同步会使用所选翻译服务；README 已提示 |
| 重定向升级 | ⚠️ | 当前同时阻止 HTTP→HTTPS 升级，属于偏保守的过度阻止 |
| 端到端前端隐私测试 | ⚠️ | 现有测试偏函数级；未自动覆盖 iframe、localStorage、浏览器端自动同步 |
| README 完整性 | ⚠️ | 隐私版 README 取代了旧版详细功能/排障文档；本次仅补回同步相关说明 |

## 仍建议处理

1. **共享电脑**：使用后清理站点 localStorage；不要把整个项目目录压缩分享。
2. **配置文件**：`config.json` 中的 API Key 为明文；如曾公开过密钥，应撤销并更换。
3. **URL 中的凭据**：不要把 `user:token@host` 或 token 查询参数写入 Base URL。
4. **自动同步**：如果翻译服务是远端服务，停止输入 5 秒或按 `Ctrl + Enter` 都会把新增/修改内容发给该服务。
5. **导出**：统一使用 `python export_source.py`，不要直接压缩整个目录。
6. **测试增强**：建议增加真实 HTTP 层测试（iframe 头、同源 POST）、前端 localStorage 测试和导出失败测试。

## 验证

```sh
python -m unittest -v test_privacy
```

当前结果：

```text
Ran 9 tests in 0.060s
OK
```

实际响应头验证：

```text
X-Frame-Options: DENY
Content-Security-Policy: frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

## 关键文件

- [server.py](server.py)：本地请求校验、密钥处理、重定向、记录路径、响应头
- [test_privacy.py](test_privacy.py)：隐私回归测试
- [export_source.py](export_source.py)：白名单源码导出
- [.gitignore](.gitignore)：本机数据与分享产物忽略规则
- [README.md](README.md)：隐私与分享说明
