# DSH 插件索引、搜索和更新

本项目发布 **DSH TaskBridge 自定义插件索引**。它不是官方内置市场收录，也不会自动出现在没有订阅该索引的用户的搜索结果中。

索引地址：

```text
https://ranranyya.github.io/dsh-taskbridge/index.json
```

## 在 DSH 中使用

1. 打开“插件”，启用实验性的“自定义插件索引”。
2. 在“发现”中选择“添加索引源”，填写上面的 HTTPS 地址。
3. 搜索 **DSH TaskBridge** 或 **dsh-taskbridge**。
4. 安装确认框应显示本项目 GitHub 仓库和精确提交。核对后安装，不要改填别人的 `dsh-delegate` 或 `dsh-dispatch` npm 包。

当前索引采用固定 Git 提交作为安装来源，不依赖本机 npm 登录。另一种安装方式是直接在“添加插件”中输入 `dsh-taskbridge@1.3.2`，无需添加索引；若中国大陆镜像未同步，改选 npm 官方源。GitHub Release 同时提供 `.tgz` 和 SHA256 文件。

## 新版本

正式 Release 发布后，GitHub Pages 工作流会重新生成索引。支持 Git 来源更新的 DSH 版本可在索引中选择同一仓库的新版本更新；旧 Desktop 若提示第三方插件需要卸载再安装，以客户端实际能力为准。此前从本地 `.tgz` 安装的副本不保证自动转为 Git 来源。1.2.0 或 1.3.0 到 1.3.1 还涉及包名变更，必须先按 [升级说明](taskbridge-upgrade.md)迁移。曾添加旧 TaskDispatch 索引的用户，应改用本页的新索引地址。

工作流或 Pages 尚未部署成功时，不能声称已可搜索。发布报告记录实际公开地址、返回状态、格式校验与所指提交。索引中的 `engines.dsh` 与插件自身一致，不把未验证的宿主版本加进兼容范围。

## 维护发布源

`scripts/build-plugin-market.mjs` 从已检出的包元数据、明确的 40 位提交 SHA 和真实发布时间生成索引；不使用分支名或占位提交，不编造下载量或 star 数。`.github/workflows/plugin-market.yml` 在正式发布或手动指定已发布标签时部署 GitHub Pages；不自动发布 npm。

格式与操作依据：[DSH 官方插件索引说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.zh.md)。
