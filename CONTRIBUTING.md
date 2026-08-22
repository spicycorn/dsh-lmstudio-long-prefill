# Contributing to dsh-local-model-long-prefill

感谢你的兴趣！本插件是 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) 的社区插件。

## 开发环境

- Node.js ≥ 20
- npm 或 pnpm

## 本地测试

```bash
# 先跑单元测试（自包含，不需要启动 DSH）：行级重写逻辑 + 真实 yaml round-trip 路径
node test_settings_rewrite.mjs   # 期望 PASS 12/12
node test_yaml_path.mjs          # 期望 PASS 6/6

# 在 profile 目录安装本地版本
cd ~/.dsh/profiles/<your-profile>
npm install file:<path-to>/dsh-local-model-long-prefill
# 重启 DSH，新开一个会话，跑一个长 prefill 测试
# 检查 settings.yaml 是否被自动修改（每个本地 provider 的 timeoutMs、streamIdleTimeoutMs 都应 ≥ 7200000）
```

## 发布

```bash
npm pack   # 生成 .tgz
# 或
npm publish --access public
```

本插件是单文件 ESM（`lib/index.mjs`），无需构建步骤。

## 修改路由规则

要改哪些 URL 走长超时处理，编辑 `lib/index.mjs` 里的：
- `OPENAI_PATHS` — OpenAI 兼容路径集合
- `LOCAL_HOSTS` — 本地主机名集合
- `isLongPrefillRoute()` — 路由分类逻辑
- `isLocalOrLanHost()` — 本地/局域网主机识别
- `MANAGED_PROVIDER_FIELDS` — settings.yaml 自动重写要管理的 provider 字段（当前为 `timeoutMs`、`streamIdleTimeoutMs`）
- `DEFAULT_LOCAL_TIMEOUT_MS` — 抬高上述两个字段时使用的共享预算目标值（默认 7200000 ms = 2 小时，只升不降）

> 注意：这两个字段必须**一起**抬高——哪个截止期小就先触发。OpenAI SDK 的 per-request timeout 默认为 `DEFAULT_TIMEOUT`（600 s），若 settings.yaml 里没有显式 `timeoutMs`，请求会在恰好 +10 min 报 "Request timed out."；pi-ai 看门狗默认只有 300 s。

## 提交规范

- 小步提交，每个 commit 解决一个问题
- 提交信息用英文，简洁描述 what + why
- PR 描述里说明改了什么、为什么改、怎么测的

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
