# 当前运行手册：Developer-first → Account

> 本文是当前运行行为的唯一操作入口。历史计划保留为决策记录；遇到旧流程描述时，以本文、README.md 与当前源码为准。

## 1. 运行目标与边界

浏览器阶段在一个 Firefox / ruyiPage 会话内依次完成：

1. 初始标签页打开 https://developer.apple.com/account；
2. 复用统一 Apple 身份验证与 2FA 上下文，判定 Developer 会员状态；
3. 立即持久化固定的 developer_membership 结果；
4. 根据 DEVELOPER_MEMBERSHIP_GATE 决定是否新建 Account 标签页；
5. Account 模块在 https://account.apple.com/account/manage/section/information 采集个人信息。

Firefox 启动、标签页创建、导航、页面查询、输入、点击和截图都由 scripts/ruyipage/apple_account_flow.py 经 ruyiPage 完成。Node 进程只做 JSONL、2FA provider、脱敏 audit、报告、私有 .env 持久化和终端进度，不持有浏览器控制连接。

~~~mermaid
sequenceDiagram
    participant User as 本机终端
    participant Node as Node 编排
    participant Ruyi as ruyiPage / Firefox
    participant Dev as Apple Developer
    participant Account as Apple Account

    User->>Node: ./run.sh [--skip-mac]
    Node->>Ruyi: 启动或接管 Firefox
    Ruyi->>Dev: 初始标签页登录 / 共享 2FA
    Dev-->>Ruyi: active | not_enrolled | unknown
    Ruyi-->>Node: developer_membership_checked
    Node->>Node: 立即写入私有 developer_membership
    alt Developer 已认证且 (gate=0 或 active)
        Ruyi->>Account: 新建 Account 标签页
        Account-->>Ruyi: Account home 已确认
        Ruyi->>Account: 打开个人信息页
        Ruyi-->>Node: 资料采集状态 / 截图元数据
    else Developer 已认证且 gate=1 且非 active
        Ruyi-->>Node: developer_membership_gate_blocked
        Node-->>User: 正常 gate stop
    else Developer 登录未确认
        Ruyi-->>Node: developer_account_failed
        Node-->>User: 失败并保留浏览器；不创建 Account tab
    end
~~~

## 2. 首次安装与日常运行

~~~bash
# 首次安装、更新 native helper 或换新 Mac 后
./install.sh

# 完整流程
./run.sh

# 浏览器模块验证（最常用）
./run.sh --skip-mac
~~~

./install.sh 负责：

- 检测 Node 18+、Python 3.10+、Firefox；
- 在需要时验证并安装官方 Python，再创建 .runtime/ruyipage-venv；
- 安装固定 ruyiPage 依赖；
- 编译 native Swift helper；
- 预检辅助功能和「屏幕与系统音频录制」。

权限归属必须是**实际启动 ./run.sh 的应用**。通常是 Terminal / iTerm；受监督验证时可能是 Codex 或 native helper。--skip-mac 仍需要辅助功能和屏幕录制，但不要求终端拥有「自动化 → 系统设置」权限。

## 3. 模式与 gate

### 测试模式：DEVELOPER_MEMBERSHIP_GATE=0

默认值。Developer 登录确认后，模块产生 active、not_enrolled 或 unknown 时都会继续执行 Account 模块。这个模式用于回归两段流程、确认新的 Account tab 和个人信息采集。Developer 仍停在 Apple 登录页、凭据输入失败或 2FA 未完成时属于登录失败：不得把它降级为 unknown，也不得创建 Account tab。

### 业务模式：DEVELOPER_MEMBERSHIP_GATE=1

只有 Developer 状态为 active 时才进入 Account：

| Developer 结果 | Account 模块 | 总流程语义 |
| --- | --- | --- |
| active | 新建 Account tab 并继续 | 常规 Account 登录/采集路径。 |
| not_enrolled | skipped | 正常 gate stop；不写 Account home acceptance marker。 |
| unknown | skipped | 正常 gate stop；保留固定不确定状态以便排查。 |
| Developer 登录失败 | 不进入 Account | 流程失败并按失败保留策略保留浏览器；不写会员值。 |

业务模式的“已跳过”与 “Account 登录失败”必须分开看：前者的报告中 accountModule.skipped=true、skipReason=developer_membership_gate，没有 browserLogin.accountHomeConfirmed=true，因此 acceptance marker 是 skipped。

## 4. 会员状态、私有持久化与截图

| 内部状态 | .env 写入 | 用户可见终端 | 详情截图 |
| --- | --- | --- | --- |
| active | developer_membership=已加入 | 已加入会员的固定提示 | 03-developer-membership.png，且仅在会员详情导航成功、详情内容确认后保存。 |
| not_enrolled | developer_membership=未加入 | 未加入的固定提示 | 不保存。 |
| unknown | developer_membership=未确认 | 未确认的固定提示 | 不保存。 |

Node 在收到 developer_membership_checked 时就写入私有 .env，不等 Account 模块或最终浏览器结果，因此后续 Account 新标签页、认证或采集失败也不会抹掉已完成的会员判定。未认证的 developer_account_failed 不会生成 developer_membership。

Account 个人信息页的契约独立于 Developer 截图：

- 目标路由固定为 /account/manage/section/information；
- 名称与生日卡必须连续稳定；
- 先读生日，再打开姓名弹窗并按**名在前、姓在后**组合；
- 成功就保存 screenshots/02-account-information.png；
- 私有 .env 写入 name、birthday。

认证页和 OTP 页不是截图目标；它们不应产出全页截图。

## 5. 终端、日志与报告

普通终端只显示业务进度，例如：

~~~text
[→] 正在打开 Apple Developer 账户页面
[✓] Apple Developer 会员状态检查完成
[→] 正在打开个人信息页面
[✓] 已保存个人信息页面截图
[✓] 个人资料采集完成
~~~

需要定位协议阶段时才使用：

~~~bash
APPLE_AUTOMATION_TERMINAL_DEBUG=1 ./run.sh --skip-mac
~~~

调试模式只镜像脱敏固定状态，不显示 Apple ID、密码、OTP、Cookie、原始 AX/OCR、URL query、页面正文、姓名或生日。

每次运行的报告目录使用同一 runId 关联：

| 文件 | 用途 | 是否包含个人/认证秘密 |
| --- | --- | --- |
| launcher-audit.jsonl | launcher 的启动、环境、预检、退出阶段。 | 否。 |
| flow-audit.jsonl | Node、ruyiPage、Developer、Account、截图、gate、最终完成状态。 | 否，只含固定分类与布尔字段。 |
| 2fa-audit.jsonl | popup / OCR / Settings / manual 的 provider 生命周期。 | 否，绝不含 OTP。 |
| report.json | 面向调用方的状态汇总、截图文件名和失败分类。 | 不含账号、密码、OTP、Cookie、个人资料值。 |
| screenshots/ | 仅 active 会员详情和稳定个人信息页面。 | 是，按私有数据保管，勿上传。 |
| .env | 本机输入凭据与成功采集的 developer_membership、name、birthday。 | 是，私有文件，勿读取/共享/提交。 |

## 6. 固定状态机与定位顺序

### Developer 模块

| 顺序 | 关键状态 | 含义 |
| --- | --- | --- |
| 1 | developer_account_started | 已开始初始 Developer tab。 |
| 2 | developer_account_authentication_started | 正在走共用认证链。 |
| 3 | developer_account_authenticated | Developer 页面 shell 已确认。 |
| 4 | developer_membership_checked | 已给出 active / not_enrolled / unknown 固定结果并触发私有持久化。 |
| 5 | developer_account_completed | Developer 阶段正常收束。 |
| 异常 | developer_account_failed | 固定 failure stage/class；若 authenticated=false，终端提示登录未完成、会员结果不写入、Account 不启动。 |
| gate | developer_membership_gate_blocked | 仅 gate=1 且不通过时出现；这是正常模块跳过。 |

### Account 模块

| 顺序 | 关键状态 | 含义 |
| --- | --- | --- |
| 1 | account_module_started | 已根据 Developer 结果尝试进入 Account。 |
| 2 | account_module_tab_created | 新 Account tab 已创建。 |
| 3 | account_home_confirmed | Account 登录态已确认。 |
| 4 | profile_capture_started | 正在打开个人信息页。 |
| 5 | screenshot_capture（account_information） | 个人信息截图已经生成。 |
| 6 | profile_capture_failed | Account 登录可以已成功，但资料采集 partial；Firefox 按保留策略留在现场。 |

最终在 flow-audit.jsonl 查 acceptance_marker_completed、acceptance_marker_partial 或 acceptance_marker_skipped。只有 account_home_confirmed 为真时，才允许出现 Account home acceptance marker。

## 7. 2FA 交接

Developer-first 和 Account 模块共用同一个认证上下文与验证码 generation。不要启动第二个浏览器或第二个 2FA collector。

网页手接的检查点：

~~~text
twofa_code_delivery_started
→ twofa_code_delivery_sent
→ code_received
→ twofa_code_delivery_acknowledged
→ target_resolved
→ input_completed
→ submit_sent
→ transition_confirmed
~~~

缺失哪一个，就定位该状态所属模块；不要通过坐标点击、DOM dispatchEvent、第二个浏览器框架或重放已部分输入的 OTP 来“补救”。完整边界见 [2FA 交接诊断](2FA_HANDOFF_DIAGNOSTICS.md)。

## 8. 故障矩阵

| 观察到的现象 | 核心判断 | 优先检查 |
| --- | --- | --- |
| Developer 完成后没有 Account | 先看是否 gate=1 的预期 stop。 | DEVELOPER_MEMBERSHIP_GATE、developer_membership_gate_blocked、accountModule。 |
| active 但没有会员截图 | 会员详情导航/内容确认没有成功。 | developer_membership_checked 前后的状态与 screenshots.developerMembership 元数据。 |
| Account tab 创建失败 | Developer 结果已持久化；是 Account 模块问题。 | account_module_started、account_module_tab_created、failureStage。 |
| Account home 确认后资料采集失败 | 登录成功与资料采集 partial 是两个结果。 | account_home_confirmed、profile_capture_failed、浏览器是否保留。 |
| 个人信息截图不是目标页面 | route 或卡片稳定性不足。 | profile_capture_readiness、screenshot_capture 的 checkpoint。 |
| 2FA 窗口已关但终端仍显示旧提示 | popup 清理是独立的尽力收尾；看 collector 固定结果，不要以 UI 消失单独判断失败。 | 2fa-audit.jsonl 的 provider completion/cleanup。 |
| target_resolved 之后无 input_completed | OTP 控件已经找到，但 BiDi 输入确认未完成。 | 2FA_HANDOFF_DIAGNOSTICS.md 与 owner frame / empty-cell guards。 |

## 9. 维护规则

- 先改拥有该状态的最小模块，再加定点测试；不要为了一个状态缺口换浏览器框架。
- 每次新增/改名固定状态，都要同步 flow-audit.jsonl、report.json sanitization、README/本手册及静态文档合同测试。
- 当前执行顺序是 Developer-first。旧的“Account 完成后再跑 Developer”仅是历史计划，不是可运行行为。
