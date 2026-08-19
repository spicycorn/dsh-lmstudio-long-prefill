# Contributing to dsh-lmstudio-long-prefill

感谢你的兴趣！本插件是 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) 的社区插件。

## 开发环境

- Node.js ≥ 20
- npm 或 pnpm

## 本地测试

```bash
# 在 profile 目录安装本地版本
cd ~/.dsh/profiles/<your-profile>
npm install file:<path-to>/dsh-lmstudio-long-prefill
# 重启 DSH，新开一个会话，跑一个长 prefill 测试
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

## 提交规范

- 小步提交，每个 commit 解决一个问题
- 提交信息用英文，简洁描述 what + why
- PR 描述里说明改了什么、为什么改、怎么测的

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
