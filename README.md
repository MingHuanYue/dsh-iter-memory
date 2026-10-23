# 潮声 · dsh-tide-whisper

[![DSH Plugin Hub](https://img.shields.io/badge/DSH-Plugin%20Hub-7c5cff)](https://dsh-plugin.org/zh/plugins/MingHuanYue/dsh-tide-whisper)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.1.7--rc.1-blue)](https://www.deepseek.com/harness/)

让 DSH 里的 AI **不定期自己开口**：不是每天 9 点准时问早安，而是掷骰子——40 分钟后、两小时后、或者这次干脆不说话。

## 它和「定时提醒」差在哪

内置的 `schedule_create` 是「我定一个点，到点必须唤醒」：cron 也好、`after_seconds` 也好，**每次到点都真的叫醒模型一次**，就算它什么都不想说，token 也已经花掉了。

潮声是反过来做的：

1. 插件自己在本地掷骰子，决定**下一次什么时候**（默认 40~200 分钟里随便抽一个）；
2. 到点后先裁决要不要真的开口（活跃时段、一天上限、冷却、你刚说过话、以及 40% 的骰子）；
3. **只有决定开口时**才去向宿主的 `schedule` 服务塞一条提醒，把会话唤醒一次。

所以「沉默」是零成本的：不唤醒、不推理、不花钱。骰子掷空了就当没发生过，重新排下一次。

## 装上

```bash
dsh plugin --profile desktop add github:MingHuanYue/dsh-tide-whisper
```

本地开发时用路径：

```bash
dsh plugin --profile desktop add link:D:/DSH插件/projects/dsh-tide-whisper
```

装完**重启 DSH**（模块是启动时加载的）。之后在「设置」里多出一页「潮声」。

## 设置页能改什么

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 启用 | 关 | 默认不打扰你，自己去打开 |
| 最短 / 最长间隔 | 40 / 200 分钟 | 均匀分布里抽一个，落在中间的概率最大 |
| 一天最多 | 5 次 | 到了就等明天 |
| 开口概率 | 0.4 | 到点后掷骰子，低于它就这次不说 |
| 活跃时段 | 9 → 25 | 25 表示次日凌晨 1 点，支持跨午夜；区间外一律安静 |
| 冷却 | 25 分钟 | 刚开口过就不再连着说 |
| 你刚说过话 | 20 分钟 | 你正在跟我说话时不让它插嘴 |
| 提示词 | 内置一段 | 提醒投递时带的话术，可在设置页改 |

## 我（模型）能用的工具

| 工具 | 作用 |
| --- | --- |
| `whisper_status` | 现在开没开、下次大概什么时候、今天已经开口几次 |
| `whisper_set` | 改参数（开关、间隔、概率、时段、上限） |
| `whisper_now` | 不等骰子，立刻叫醒一次（测试用） |

## 数据与隐私

- 配置、状态、日志都在 `$DSH_HOME/tide-whisper/`：`config.json`、`state.json`、`log.jsonl`。
- **不联网**，不发遥测，不上传任何东西。
- 日志只记「几点、哪个会话、开口还是跳过、为什么」，可以随时删掉。
- 卸载插件不会删这些文件；想清干净就把整个 `tide-whisper` 目录删掉。

## 兼容性

- DSH >= `0.1.7-rc.1`（依赖宿主的 `schedule` 服务与 `agents` / `webServer` / `timer`）。
- Node >= 22。
- 需要宿主提供 `schedule` 服务；没有的话 `whisper_now` 会返回「宿主没有 schedule 服务，叫不醒」，其余功能照常。

## 已知限制

- 只能唤醒**还活着的会话**（`ctx.agents.list()` 里能看到的）。DSH 关掉以后它不会自己把程序拉起来。
- 记账只保留最近 30 个会话，老的会被清掉重排。
- 不是「每隔 N 分钟检查一次」那种轮询式的主动消息：沉默期完全不投递。

## 测试

```bash
node --test tests/core.test.mjs
```

纯逻辑（抽间隔、活跃时段、跨午夜、裁决）都是可注入骰子的纯函数，12 条用例。

## License

MIT © MingHuanYue
