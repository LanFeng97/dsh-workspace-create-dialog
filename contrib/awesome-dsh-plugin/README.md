# awesome-dsh-plugin 投稿材料

这里放的是给 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的**条目文件**——DSH 插件市场的目录来自那份清单，一个插件一个 YAML 文件。

## 怎么投

清单仓库不接受直接编辑 README（那两个 README 是脚本从 `data/plugins/*.yml` 生成的）。投稿就是**加一个文件**：

```sh
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
cp <本目录>/LanFeng97__dsh-workspace-create-dialog.yml data/plugins/
git checkout -b add-dsh-workspace-create-dialog
git add data/plugins/LanFeng97__dsh-workspace-create-dialog.yml
git commit -m "Add dsh-workspace-create-dialog"
git push -u origin add-dsh-workspace-create-dialog
gh pr create --title "Add dsh-workspace-create-dialog" --body "Codex-style Create Workspace dialog for DSH."
```

## 三条会拦住投稿的规则

1. **仓库年龄 ≥ 1 天。** 他们的 CI 会检查目标仓库的创建时间（`What CI checks` 第 3 条）。仓库刚建好就提 PR 会被驳回，隔一天再提即可。
2. **`package.json` 必须声明 `dsh.bundle`。** 只声明 `dsh.client` 会在第 2 步就失败（本仓库两者都有）。
3. **一个 PR 最多 3 条**，且只动自己那条。

## 条目文件内容

`LanFeng97__dsh-workspace-create-dialog.yml`（文件名格式是 `<owner>__<repo>.yml`）：

```yaml
url: https://github.com/LanFeng97/dsh-workspace-create-dialog
name: LanFeng97/dsh-workspace-create-dialog
category: ui
description:
  en: '...'
  zh: '...'
```

- `category` 取 `ui`：它替换的是界面里的一次交互。其它可选项里 `workflow`、`dev` 也算沾边，但 `ui` 最贴。
- 只有 `description.en` 是必填的；`zh` 写了更好。
- 描述里若含**半角冒号加空格**（`: `）必须加引号，否则 YAML 会把它当嵌套键——本条目两条都加了引号。
- 可选：若将来不发 npm，可以把预构建 tarball 挂到 GitHub Release 并用 `tarball:` 字段指向它。本仓库是纯 JS、无需构建，因此不需要。
