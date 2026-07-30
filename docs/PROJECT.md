# Apple-AutoMation 项目参考

> 当前可运行方案：**Developer-first 会员判定 → Account 个人信息采集**。操作入口见 [运行手册](RUNTIME_RUNBOOK.md)。

## 1. 目标与非目标

| 能力 | 当前契约 |
| --- | --- |
| macOS 系统设置阶段 | 可选的 Apple Account 登录与短信后置流程；--skip-mac 时完全跳过。 |
| Firefox 浏览器阶段 | ruyiPage-only；初始 tab 先跑 Developer，再为 Account 新建 tab。 |
| Apple 认证 | email、password、remember-account、OTP 和 trust 提示复用同一可信认证链。 |
| Developer 判定 | active、not_enrolled、unknown 三态；仅 active 保存会员详情截图。 |
| Account 采集 | 稳定个人信息页后读取 birthday 与 name，并私有持久化。 |
| 诊断 | 完整脱敏 JSONL + 简洁终端进度；不把秘密/页面正文混入报告。 |

浏览器生命周期不使用 Playwright、Puppeteer、Selenium、Node BiDi 或 DOM synthetic input 回退。ruyiPage 对敏感输入使用 BiDi-native 行为；JavaScript 仅做无副作用的状态/文本查询。

## 2. 模块架构

~~~mermaid
flowchart LR
    Launcher[run.sh] --> Main[scripts/apple-id-full-flow.mjs]
    Main --> Browser[scripts/lib/account-browser-flow.js]
    Browser --> Runner[scripts/lib/ruyipage-backend-runner.js]
    Runner <--> Python[scripts/ruyipage/apple_account_flow.py]
    Browser --> TwoFA[scripts/lib/two-fa-sidecar.js]
    Browser --> Audit[flow-audit.jsonl]
    Main --> Report[report.json]
    Python --> Firefox[Firefox via ruyiPage]
    Python --> Dev[developer.apple.com/account]
    Python --> Account[account.apple.com/account/manage/section/information]
~~~

| 文件 | 所有权 |
| --- | --- |
| scripts/apple-id-full-flow.mjs | 总流程、报告目录、最终 acceptance marker、用户可见结束摘要。 |
| scripts/lib/account-browser-flow.js | Python runner、2FA collector、状态 sanitization、终端进度、私有结果持久化。 |
| scripts/lib/ruyipage-backend-runner.js | JSONL framing、超时、子进程组与 bounded cleanup。 |
| scripts/ruyipage/apple_account_flow.py | 唯一浏览器实现；Developer、Account、截图、profile、tab 和可信页面状态。 |
| scripts/lib/two-fa-sidecar.js | popup → Settings → TTY 严格串行取码。 |
| scripts/lib/flow-audit.js / scripts/lib/2fa-audit.js | 版本化、脱敏、runId 关联 audit。 |
| scripts/build-release.mjs | 分发包和独立 README/.env.example；同时打包当前文档。 |

## 3. Browser 状态机

~~~text
browser_ready
  -> developer_account
  -> developer_login
  -> [Developer auth failure] browser failure / preserve policy
  -> developer_membership
  -> developer_membership_checked
  -> [gate=1 && non-active] developer_membership_gate_blocked -> finalization
  -> [otherwise] account_navigation
  -> account authentication / shared 2FA
  -> account_home_confirmed
  -> account_information
  -> profile capture / finalization
~~~

### Developer-first 与 gate

**DEVELOPER_MEMBERSHIP_GATE=0** 是测试默认。Developer 登录已确认后，它允许 active、not_enrolled、unknown 继续 Account，便于同一次浏览器运行覆盖双模块。Developer 登录失败、仍可见 Apple 登录控件或 2FA 未完成时，绝不创建 Account tab。

**DEVELOPER_MEMBERSHIP_GATE=1** 是业务 gate。只有 postLoginDeveloperAccount.authenticated=true、success=true 且 membershipStatus=active 才会创建 Account tab。已认证的非 active 路径发送 developer_membership_gate_blocked，返回浏览器阶段成功但 accountModule.skipped=true 的固定结果；登录失败不是 gate stop。

Developer 会员状态在 developer_membership_checked 到达 Node 时立即私有持久化。只允许已认证后的 membership partial 持久化 unknown；Developer 登录失败不写 developer_membership。这样 Account tab 创建或后续 Account 认证失败不会丢失已完成的判定，也不会把失败登录冒充会员结果。

## 4. 结果、截图与 acceptance

报告只保留固定、可审计的 metadata：

| 区域 | 关键字段语义 |
| --- | --- |
| browserLogin | backend、Account home 是否已确认、session 是否复用等布尔/固定字段。 |
| postLoginDeveloperAccount | Developer 是否已检查、会员固定分类、失败 stage/class、保留状态。 |
| accountModule | 是否尝试、是否跳过、gate 是否启用/通过、固定 skip reason。 |
| postLoginProfileCapture | 个人资料是否成功、固定 failure stage/class、浏览器保留结果。 |
| screenshots | 仅文件名元数据，例如 03-developer-membership.png、02-account-information.png。 |

截图规则：

- 03-developer-membership.png：仅 active，且会员详情导航与内容确认后生成；
- 02-account-information.png：仅 Account 个人信息路由和姓名/生日卡稳定后生成；
- 认证页、OTP 页、OCR 过程不能成为成功截图；
- 保留在报告目录的截图属于私有数据，绝不作为默认反馈附件。

recordAccountHomeAcceptanceMarker() 只在 browserLogin.accountHomeConfirmed=true 时写 marker。Developer gate stop 的 marker 固定为 skipped，不能冒充为 Account 登录成功。

## 5. 配置边界

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| BROWSER_BACKEND | ruyiPage | 唯一浏览器后端；auto 仅兼容旧配置名。 |
| BROWSER_PROFILE_MODE | persistent | persistent 复用 profile；fresh 每 run 隔离 profile。 |
| BROWSER_ATTACH_EXISTING | 1 | 可接管已有 Firefox 会话，随后仍按 Developer-first 顺序推进。 |
| DEVELOPER_MEMBERSHIP_GATE | 0 | 0 测试双模块；1 仅 active 继续 Account。 |
| BROWSER_PRESERVE_ON_FAILURE | 1 | 直接运行失败后保留 Firefox 供人工核对。 |
| BROWSER_PRESERVE_ON_SUCCESS | 1 | 直接运行后保留已登录窗口和标签页。 |
| BROWSER_2FA_SETTINGS_AFTER_MS | 30000 | popup primary 窗口；Allow 确认后另有固定 OCR 宽限。 |
| BROWSER_2FA_SETTINGS_FALLBACK | 1 | 是否允许 popup-primary 后的 Settings 来源。 |
| BROWSER_2FA_MANUAL_FALLBACK | 1 | 是否允许 Settings 后真实 TTY 的隐藏手输。 |

.env 为本地私有输入/输出面：输入凭据与成功采集的 developer_membership、name、birthday。它不进入命令行、audit、report 或 Git。

## 6. 日志与脱敏

| 通道 | 内容 |
| --- | --- |
| 普通终端 | [→]、[✓]、[!]、[×] 等少量业务进度。 |
| APPLE_AUTOMATION_TERMINAL_DEBUG=1 | 额外镜像脱敏机器状态；不显示秘密、页面正文和个人资料。 |
| flow-audit.jsonl | Browser、Developer、Account、screenshot、gate、finalization 与 flow completion 的完整固定状态。 |
| 2fa-audit.jsonl | popup/AX/OCR/Settings/manual 的 provider 生命周期和固定失败分类。 |
| launcher-audit.jsonl | 进入、bootstrap、环境、preflight、主流程、完成/失败阶段。 |
| report.json | 脱敏结果汇总与固定截图文件名。 |

每份 JSONL 单独使用从 1 递增的 sequence，同一 runId 将四类报告关联起来。新增状态必须同步允许列表、sanitizer、audit、report、文档与回归测试。

## 7. 测试矩阵

| 命令 | 覆盖面 |
| --- | --- |
| npm.cmd run -s test:account-browser-flow | Node 编排、Developer result 持久化、gate stop、Account completion、终端/audit sanitization。 |
| npm.cmd run -s test:ruyipage-protocol | Python ↔ Node JSONL event/command schema。 |
| npm.cmd run -s test:ruyipage-flow | Python ruyiPage 状态机、tab 顺序、成员判定、个人信息采集边界。 |
| npm.cmd run -s test:flow-audit | audit schema、sequence、redaction。 |
| npm.cmd run -s test:release-copy-paths | 分发包、release README、当前运行手册与关键文档合同。 |
| git diff --check | 空白符与补丁基础检查。 |

## 8. 故障归属

| 状态/现象 | 拥有模块 | 首个排查文件 |
| --- | --- | --- |
| Developer login / membership | Python browser state | scripts/ruyipage/apple_account_flow.py、flow-audit.jsonl。 |
| developer_membership_gate_blocked | Python gate + Node summary | apple_account_flow.py、account-browser-flow.js。 |
| Account tab / login / profile | Python Account stage | apple_account_flow.py、test-account-browser-flow.mjs。 |
| 2FA provider / timeout | Node collector | two-fa-sidecar.js、2fa-audit.jsonl。 |
| OTP 到网页后的输入/提交 | Python owner-frame BiDi | 2FA_HANDOFF_DIAGNOSTICS.md。 |
| 报告/acceptance marker | Main flow | apple-id-full-flow.mjs。 |
| 分发文档偏离 | Release builder / static docs check | build-release.mjs、test-release-copy-paths.mjs。 |

## 9. 文档治理

- [README](../README.md)：最短的上手、模式、产物与入口。
- [运行手册](RUNTIME_RUNBOOK.md)：当前行为、验收和排错唯一入口。

每次实现改变执行顺序、环境变量、截图、固定状态、报告字段或测试入口时，至少同步 README、运行手册、项目参考、release README 和静态文档合同测试。
