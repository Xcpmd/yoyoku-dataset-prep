# Yoyoku Dataset Prep

Stable Diffusion LoRA 训练集预处理桌面工具。v1.0 实施基线见 [PROJECT_SPEC.md](PROJECT_SPEC.md)。

技术栈：Tauri 2 + React 19 + TypeScript + Vite；Rust 负责项目存储、SQLite、任务、导入与导出；Pillow 图像工作进程负责像素处理与本地 WD14 ONNX 标签推理。

## 功能范围

主工作流为 **导入 → 裁剪 → 打标 → 导出**；质检作为独立工具入口保留。

- 项目：新建 / 打开 / 最近项目 / 重命名 / 资源管理器定位 / 普通与便携备份 / 恢复；主页提供设置入口（外观、运行时、模型下载），不再显示“试用示例”。
- 图库：扫描导入（复制或引用、递归、多标注冲突、重复与多帧报告）、导入时选择或新建分组、分页网格与虚拟化列表、搜索、组合筛选、集合、跨页多选、检查器、批量操作预览与撤销。网格卡片按源图比例完整显示原图并铺满卡片，右侧检查器同样显示完整原图。
- 裁剪：提供 **瀑布流** 与 **单图编辑** 两种模式，可随时切换并记住选择。瀑布流按分组展示，卡片比例与源图一致、图片铺满卡片；裁剪框按目标比例取最大内接矩形，框外覆盖半透明遮罩、框内保持原样，不显示三分线；卡片左上角为高对比勾选按钮，支持多选与同组联动，滚轮不会带动页面滚动。单图编辑恢复原工作台页面：左侧全部图片列表、中央原图/裁剪画布、右侧裁剪与信息面板，支持原图/编辑/对比、自由裁剪、旋转翻转、草稿与「保存并进入打标」。两种模式都保留多选与联动能力；分组目标尺寸、单图输出尺寸与导出尺寸均按 64 的倍数调整。
- 打标：短语标签与自然语言描述统一显示为同一组短语芯片；自然语言整句也作为一条短语，可删除、排序并参与自动翻译。短语区提供 **排序视图 / 分组视图**：排序视图为文件顺序，可拖拽芯片（也支持 Alt + 左右方向键）调整；分组视图按提示词库主分类折叠展示，不影响文件顺序，可一键「按分组排序」、按分组整组启用/停用（停用项保留在编辑器中但不写入标注文件，状态随图片保存）。顶部提供模型下拉与「AI 打标」，用所选 WD14 / Florence-2 模型为当前图片补充短语，已有短语保留、重复项剔除；「批量打标」处理选中图片并显示进度条。手动输入提示词时从提示词库给出最佳匹配，支持 ↑↓ 选择、Tab 补全，并可按主分类筛选；提示词库首次导入项目 SQLite，翻译结果写入项目本地缓存并在后续复用。支持下划线扩展（转空格或复制空格版本，首尾下划线保留）、中英对照与翻译、触发词、审核状态与上一张 / 下一张。Florence-2 输出会按句号等句末标点拆成多条短语。素材栏上方提供全选 / 清空；按住勾选框拖动可批量选中/取消，普通点击图片只切换当前图片，不会自动勾选。
- 提示词库：独立管理页（侧栏「提示词库」或顶栏图标进入）支持搜索英文 / 中文 / 分类、分类筛选、英文 / 分类 / 中文排序、分页；可新增、编辑英文与中文、修改主分类、调用翻译服务填充中英文、删除条目。修改写入项目 SQLite，并立即刷新打标页的补全、分组与中英对照。
- 质检：阻塞 / 建议 / 已忽略筛选、规则证据、忽略理由、pHash 分组查重、数据概况与 Kohya 分桶估算。
- 导出：范围与验证集拆分、Kohya `sd-scripts`（TXT + TOML）与 Hugging Face ImageFolder（JSONL）、文件夹 / ZIP、命名与尺寸策略、预检指纹、结构校验、导出历史与绝对版训练入口。
- 设置：浅色 / 深色 / 跟随系统、减透明、减动效、高对比、大字号、密度、图库卡片宽度、检查器宽度；项目阈值；本地打标模型目录、模型清单与 **Hugging Face 模型下载**（WD14 ONNX 与 Florence-2 base-ft 权重；进度、失败重试、已安装标记）；图像运行时；百度翻译 AppID / 密钥（可选，留空时使用 MyMemory 免费接口）；存储占用与可重建缓存清理；快捷键说明。
- 外观：Apple 风格设计令牌（单一 Action Blue、系统字体、羊皮纸 / 白 / 近黑表面、胶囊按钮、8/11/18 px 圆角），适配 1920 / 1440 / 平板 / 手机宽度。原生标题栏与独立自绘标题条均已移除：最小化 / 最大化 / 关闭是**应用内按钮**，项目页位于顶栏右端，项目列表页浮在右上角；拖动由顶栏和页面空白区域承担，双击最大化。`core:window` 的最小化 / 切换最大化 / 关闭 / 查询最大化 / 开始拖动权限已在 capabilities 中显式授予。所有外部 Python 与系统命令都以 `CREATE_NO_WINDOW` 启动，使用期间不会弹出终端窗口。应用图标保留 `public/icon.jpg` 完整画面，仅用五次方超椭圆 `|x|⁵ + |y|⁵ ≤ 1` 裁切四角，得到**圆角矩形**（不是圆形）；`tools/make_icons.py` 可重新生成 32–1024 px PNG、ICO、ICNS 与 Windows 方形图块。

## 开发环境

前置：

- Windows 11（x64），WebView2 Runtime
- Node.js 20+（本项目用 Node 26 验证）
- Rust stable + MSVC 工具链（Visual Studio Build Tools）
- Python 3.10+ 且安装 Pillow（图像工作进程）

图像运行时解析顺序：

1. 设置中的 Python 路径（保存至 `settings.json`）
2. `YOYOKU_PYTHON` 环境变量
3. `worker/.venv/Scripts/python.exe`
4. `wd14Tagger/python31010/python.exe`（如存在，本项目环境会命中）
5. `python`

安装与开发：

```powershell
npm install
npm run tauri:dev
```

仅前端：`npm run dev`。类型检查：`npx tsc --noEmit`。前端构建：`npm run build`。安装包：`npm run tauri:build`，NSIS 输出位于 `src-tauri/target/release/bundle/nsis/`。

工作进程可用 `YOYOKU_WORKER_SCRIPT` 指定 `worker/main.py`，打包时通过 Tauri resource `worker/` 分发。安装包**不包含** Python 运行时与 Pillow，也不会打包 WD14 模型；目标机需要 Python 3.10+ 且安装 Pillow，或安装后在设置中填写 Python 路径，并把模型目录指向本机的 WD14 ONNX 目录。开发环境会自动命中 `wd14Tagger/python31010`。

## 本地标签模型

WD14 建议使用随项目准备的 `wd14Tagger/models/SmilingWolf--*` 目录（`model.onnx` + `selected_tags.csv`），也可以把模型目录放进设置中的「模型目录」。推理使用 `wd14Tagger/python31010/python.exe`（含 onnxruntime 与 Pillow），通过 `worker/tagging/wd14_infer.py` 执行；图片不会上传。

设置页提供「下载模型」：后端 `models_catalog` 列出 WD ViT / ViT-Large / SwinV2 / ConvNeXt 等 WD14 v3 ONNX 模型及大约体积，`model_download` 调用只依赖 Python 标准库的 `worker/tagging/download_model.py`，从 Hugging Face 下载到模型目录。下载写入 `.part` 临时文件，`fsync` 后原子改名；进度通过 `model:download-progress` 事件显示，失败可直接重试。已安装的模型在下载对话框中标记为「已安装」。

Florence-2 现在可在设置页下载 base-ft 权重（约 0.5 GB）并显示为已安装。打标页顶部「AI 打标」与「批量打标」都可选择 Florence-2，执行 `<MORE_DETAILED_CAPTION>` 后按句号等句末标点拆成多条短语，再与现有标签去重合并。它需要 Python 安装 `torch`、`transformers`、`einops` 与 Pillow；设置中的 Python 路径会优先使用，未填写时使用系统 `python`。WD14 仍使用自带 Python 与 ONNX Runtime。

## 数据布局

```text
<项目>/
  project.json
  database.sqlite
  originals/<sha256>.<ext>     # 复制模式受管理原件
  cache/
    thumbs/<assetId>/<version>.jpg
    display/<assetId>/<version>.png
    previews/<hash>.jpg
  staging/
  exports/
  backups/
```

引用模式只记录来源根、相对路径与文件指纹。删除最近项目记录不会删除项目文件。

## 导出目标

- Kohya：`train/` 同名图片 + `.txt`（或 `.caption`），`dataset.toml`、`validation/` 留出目录、`manifest.json`、`README.md`。默认分桶 64 px、`bucket_no_upscale=true`，可在界面对应字段调整。
- ImageFolder：`train/` 与可选 `validation/`，每个目录一个 `metadata.jsonl`，另有 `manifest.json` 与 `README.md`。
- 导出先写同父目录临时区，通过计数、像素、配对、JSONL/TOML、清单一致性校验后原子提交；ZIP 先写临时文件并重开校验。

## 测试

```powershell
cd src-tauri
cargo test
```

当前结果：**17 passed, 0 failed, 2 ignored**。单元测试覆盖裁剪几何（保留比例、固定裁切阻塞、固定补边、floor/ceil 裁剪、旋转）、标注归一化 / 触发词 / 计数、短语与自然语言混合标注的导出文本 / 统计 / 检索、Windows 文件名与路径安全、备份归档路径穿越拒绝。另有两个 `#[ignore]` 的真实归档往返用例（普通/便携备份），需先生成 `tests/out/example-normal.zip` 后以 `--ignored` 手动执行。

验收记录见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。

## 已知限制

- 本仓库未分发 sd-scripts 与 Diffusers 训练端；导出包执行了结构、配对、像素与语法校验，但真实训练端 loader 的最终读取需要在已安装上游依赖的目标机器上复验。README 与导出报告会注明上游适配器版本。
- Florence-2 权重可下载并识别为已安装，可在单图建议与批量打标中选择；其推理需要目标机 Python 具备 torch、transformers、einops。批量打标也可继续使用 WD14 标签模型。
- 安装包只包含 `worker/` 脚本与前端资源，不含 Python、Pillow 和 WD14 模型；目标机需自备运行时与模型，设置页会显示解析结果。
- 自动模糊检测阈值需要人工校准，默认关闭。
- 打标页的默认画布仍显示原图（可切换「原图 / 对比」查看处理后预览），不会在打标页直接改裁剪；裁剪联动只作用于裁剪页。
- 工作台处理预设库与 ZIP 内直接生成绝对版 TOML 仍为后续迭代项。
- 模型下载已接入并完成目录/进度 UI 验证，但本次未重复下载 360 MB–1.17 GB 的实际模型文件；网络中断后的断点体验依赖重新开始下载。
- 5,000 张性能基准、Windows 150%/200% 缩放、读屏软件与真实上游训练端 loader 尚未在目标机复验；已完成项与部分完成项见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。

## 许可与来源

示例素材由 `worker/main.py` 程序生成，可随项目分发。WD14 模型许可见 Hugging Face 模型发布页。UI 视觉为自有实现，参考 `public/apple/DESIGN.md` 的排版、色彩与交互原则；应用图标基于 `public/icon.jpg` 生成，不包含第三方商标素材。
