# ChatCell

一个 Android 上的极简 AI 聊天客户端。**没有服务器、没有账号体系**——你的手机直接调 DeepSeek 的 API，会话全部存在本机。

套壳方案：Vite + React 前端，Capacitor 打成 APK，APK 在 GitHub Actions 上云构建。

---

## 一、目录结构

```
chatcell/
├─ .github/workflows/android.yml   ← 云构建流水线（出 debug APK）
├─ capacitor.config.json           ← 壳的配置（appId / 应用名 / origin 方案）
├─ vite.config.js
├─ index.html
├─ package.json
├─ src/
│  ├─ main.jsx                     入口
│  ├─ App.jsx                      界面：会话抽屉 / 消息流 / 设置页（含主题、背景、人格、备份）
│  ├─ api.js                       流式请求 + SSE 解析 + 错误分类
│  ├─ storage.js                   设置存 localStorage，会话与背景图存 IndexedDB
│  ├─ backup.js                    会话导出（写文件 + 系统分享）/ 导入（解析 JSON）
│  ├─ markdown.js                  Markdown 渲染 + 简单消毒
│  └─ styles.css                   深色 / 亮色两套主题变量
└─ android/                        CI 里自动生成，不入库
```

---

## 二、三步拿到 APK

### 1. 建一个 GitHub 仓库，把本目录推上去

在项目根目录（就是本 README 所在的目录）执行：

```powershell
git init
git add .
git commit -m "init chatcell"
git branch -M main
git remote add origin https://github.com/<你的用户名>/chatcell.git
git push -u origin main
```

### 2. 等 Actions 跑完

推送后打开仓库页面 → 顶部 **Actions** 标签 → 点进正在跑的那次 `build-apk`。

首次构建大约 **6～12 分钟**（要下载 Android SDK 和 Gradle 依赖），之后有缓存会快一些。

### 3. 下载 APK 装到手机

Actions 那次运行页面**最底部**有个 **Artifacts** 区域，下载 `ChatCell-debug-apk-r1`（是个 zip），解压得到 `ChatCell-debug-r1.apk`。

传到手机（数据线 / 网盘 / 微信文件传输都行）→ 点开安装 → 系统提示"未知来源"，允许即可。

> 这是 **debug 签名**的包，装得上、用得爽，但**不能上应用商店**。要正式版见第六节。

---

## 三、第一次使用

1. 打开 App，点右上角 **⚙**。
2. 填 **API Key**（在 DeepSeek 开放平台申请）。
3. **接口地址**默认 `https://api.deepseek.com`，一般不用改。
4. **模型**填你账号实际可用的模型名，默认 `deepseek-chat`。
5. 点 **测试连接**，看到 `✓ 连接成功` 就对了，然后 **保存**。

API Key 只存在这台手机的 `localStorage` 里，不会上传到任何地方——所以**换手机或清数据要重新填**。

## 三之二、功能一览

设置面板（⚙）里从上到下的区块：

| 区块 | 内容 | 生效方式 |
|---|---|---|
| 接口 | API Key / 地址 / 模型 / 温度 / 额外参数 | 点「保存」 |
| 主题 | 🌙 黑色 / ☀️ 白色 | 点选立即生效 |
| 会话背景 | 选择图片 / 更换 / 清除 | 立即生效 |
| 人格预设 | 新建 / 编辑 / 删除 / 单选启用 | 立即生效 |
| 会话备份 | 导出全部 / 导入 | 立即生效 |
| 危险区 | 清空全部会话 | 二次确认 |

几个实现细节：

- **主题**：靠 `styles.css` 顶部的两套 CSS 变量切换（`<html data-theme="light">`），不改任何数据。
- **会话背景**：图片只铺在聊天消息区，用 `linear-gradient` 叠一层遮罩保证文字可读；大图先用 canvas 压缩到 1600px 以内再存进 IndexedDB，所以不受 `localStorage` 5MB 限制。
- **人格预设**：启用的人格会作为 `role: "system"` 插在每轮请求的**最前面**，后面才是历史消息。全局只有一个生效，再点一次取消。
- **导出**：生成 `chatcell-backup-<时间戳>.json`，写进应用缓存目录后调系统分享面板（可存文件管理器、发微信、发邮件）。
- **导入**：走原生文件选择器，读 JSON 后**追加**合并，不覆盖已有会话；同 id 的会被覆盖。

---

## 四、本地开发（改代码不用每次都等云端）

```powershell
npm install
npm run dev
```

浏览器打开 `http://localhost:5173`，热更新秒出，改界面/改逻辑都在这里调。
注意浏览器里直连 API 可能被 CORS 拦，这只影响本地调试，**装成 APK 后不受影响**。

想看真机效果：

```powershell
npm run build
npx cap add android      # 第一次要跑，生成本地 android 目录
npx cap sync android
# 然后用 Android Studio 打开 android/ 目录，或：
cd android ; ./gradlew assembleDebug
```

---

## 五、几个关键设计（出问题时先看这里）

| 点 | 怎么处理的 |
|---|---|
| **CORS / origin 变了** | `capacitor.config.json` 里设了 `server.androidScheme: "https"`，让 WebView 的 origin 变成标准的 `https://localhost`，而不是 `file://` |
| **流式输出** | 用 `fetch` + `ReadableStream` 手写 SSE 解析，不用 `EventSource`（它发不了 POST）。逐行解析，容忍半截 JSON |
| **停止生成** | `AbortController` 一路传给 `fetch`，点"停止"立刻断流，省 token |
| **高频重绘** | 每个 token 都 `setState` 会卡，用 `requestAnimationFrame` 节流 |
| **会话存储** | 设置走 `localStorage`（小、同步），消息走 `IndexedDB`（大、异步，不怕 5MB 上限） |
| **深度思考** | 如果 API 要传开关参数，写在设置页的「额外请求参数」里，原样合并进请求体；返回的 `reasoning_content` 会显示成可折叠的「思考过程」 |
| **Markdown 安全** | `marked` 渲染后做一次消毒，去掉 `script`/`iframe`/`on*` 事件/`javascript:` 链接 |

---

## 六、升级成正式版（可选）

要给别人的手机装、或上架，需要 release 签名：

1. 本地生成 keystore（**备份好，丢了就不能更新已发布的包**）：

```powershell
keytool -genkey -v -keystore release.keystore -alias chatcell -keyalg RSA -keysize 2048 -validity 10000
```

2. 转成 Base64：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("release.keystore")) | Set-Clipboard
```

3. 仓库 **Settings → Secrets and variables → Actions** 加四个 Secret：
   `KEYSTORE_BASE64`、`KEYSTORE_PASSWORD`、`KEY_ALIAS`（`chatcell`）、`KEY_PASSWORD`

4. 在 `android/app/build.gradle` 里配 `signingConfigs`，workflow 里把 `assembleDebug` 换成 `assembleRelease`。

> `android/` 是 CI 现场生成的，所以第 4 步意味着要把 `android/` 目录纳入版本管理（改 `.gitignore`），或者用 Capacitor 的 `build-extras` 钩子注入。

---

## 七、常见问题

**装完打开是白屏？**
先确认 Actions 里 `npm run build` 和 `npx cap sync android` 都成功了。白屏一般是 `dist/` 没同步进去，或者 `vite.config.js` 的 `base` 不是 `'./'`。

**发消息报"请求发不出去"？**
按顺序查：① 手机有没有网 ② API Key 填对没有 ③ 接口地址末尾别带多余路径（本程序会自动补 `/chat/completions`，但你填了 `/v1` 也没关系）。

**回复到一半断了？**
息屏或切后台时，Android 可能冻结 WebView 的网络。目前没做前台服务，长回复建议别锁屏。

**APK 装不上，提示"已有更高版本"？**
`versionCode` 没递增。改 `android/app/build.gradle` 里的 `versionCode`（或等你把 android 目录纳入版本管理后改）。

**图标还是 Capacitor 的默认图标？**
换掉 `android/app/src/main/res/mipmap-*/ic_launcher.png`，或者用 `@capacitor/assets` 一键生成。

---

## 八、实测踩坑记录（首次跑通，务必保留）

这是把 CI 从三次红色改成绿色过程中踩到的真坑，下次改 workflow 前先看这里。

### 1. JDK 必须是 21，不能是 17

**现象**

```
Execution failed for task ':capacitor-android:compileDebugJavaWithJavac'.
> error: invalid source release: 21
```

**原因**：Capacitor 7 的 Android 库源码按 Java 21 编译，JDK 17 的 javac 最高只认到 17，直接拒编。

**修法**：`actions/setup-java` 里写 `java-version: '21'`。

### 2. 不要用 `android-actions/setup-android`

**现象**：`安装 Android 命令行工具` 这一步直接红。

**原因**：该 action 已停更，被 GitHub 强制在 Node 24 运行时下执行，不稳定；且每次都要从 `dl.google.com` 重下一遍 cmdline-tools，容易超时。

**修法**：删掉它。`ubuntu-latest` 的 runner 镜像**本身预装了完整的 Android SDK**，`ANDROID_HOME` 和 `sdkmanager` 都是现成的，直接用即可。

### 3. Gradle 找不到 Android SDK

**修法**：构建前显式写入

```bash
echo "sdk.dir=${ANDROID_HOME}" > android/local.properties
```

环境变量不一定能跨 step 传到 Gradle，落成文件最保险。

### 4. `gradlew` 丢了执行权限

**修法**：`chmod +x android/gradlew`

在 Windows 上提交的仓库，到 Linux runner 上经常丢可执行位，不处理直接 `Permission denied`。

### 5. git 的两个坑

- `git add .` 漏掉末尾那个点 → 报 `Nothing specified, nothing added`。用 `git add -A` 更防呆。
- **千万别在家目录跑 `git init`**。会产生 `C:\Users\<你>\.git`，之后在家目录任何位置执行 git 命令都会用这个仓库，一个 `git add .` 就可能把整个用户目录推到远程。

### 已验证通过的点（真机实测）

| 项 | 结论 |
|---|---|
| 套壳后的 origin | `https://localhost`，DeepSeek API **接受**，无需额外加转发层 |
| 流式输出 | 逐字流畅，无掉帧 |
| Markdown | 表格、代码块渲染正常 |
| 键盘弹出 | 不遮挡输入框 |
| API Key 测试连接 | 正常返回 |

### 改代码之后的更新流程

```powershell
# 改完文件
git add -A
git commit -m "改了什么"
git push
```

→ 等 Actions 变绿 → 下载新 APK → **直接覆盖安装**（同名同签名，会话数据不会丢）。

---

## 许可证

自己写的代码，随便用。DeepSeek 的 API 使用需遵守其服务条款。
