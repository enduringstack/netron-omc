# 在 Netron 查看 Kirin 9050 OMC

本机已安装 `~/Applications/Netron OMC.app`，支持 Apple Silicon macOS。程序基于 Netron 9.3.6，上游提交为 `5cc0f9f3ffb180202ae1180e151772110baac7f8`。桌面查看器从本地文件读取模型，可离线使用。

## 打开实测的整网 ViT

在本仓库根目录运行以下命令，或从应用的 **File → Open** 选择同一文件。

```sh
open -a "$HOME/Applications/Netron OMC.app" \
  ../../out/qwen35-2b-20261119/vision/full-compile/full-npu/vision_quant.omc
```

初始画布显示 `ge_default`，其中包含设备子图 `SubGraph_0`。点击子图节点标题旁的 **ƒ** 查看设备执行图。使用 **⌘F** 查找 `Permute`、`TransData` 或编译器保留的节点名，点击节点查看输入输出、张量形状及编译属性。点击左下角的返回箭头可回到封装图。整网布局较大，可以先用下面的六层样本检查节点及连接。

```sh
open -a "$HOME/Applications/Netron OMC.app" \
  ../../out/qwen35-2b-20261119/vision/full-compile/staged/last-six/model.omc
```

## 验证记录

| 本地样本 | 文件字节数 | 设备子图计算节点 | 数据输入引用数¹ | 实际验证 |
|---|---:|---:|---:|---|
| GE Add | 25,260 | 4 | 6 | Add、3 个 TransData。与 OMG JSON 逐项对照顶层算子、输入、输出和连边 |
| Qwen DeltaNet 单层 | 31,413,174 | 1 | 19 | 安装版打开 KirinDeltaBlock，可见三入四出、权重形状、kirin9050 与 op_tiling_blockdim |
| Qwen ViT 后六层 | 124,866,359 | 2,239 | 4,568 | 安装版展开子图、定位 Permute 并打开属性侧栏 |
| Qwen ViT 完整 24 层 | 526,930,649 | 8,423 | 17,538 | 安装版展开子图、定位 /patch_projection/Transpose 并显示节点属性 |

¹ 每个计算节点的每个已连接数据输入及每个图输出各计一次，包含来自常量和图输入的连接。常量呈现为端口上的权重，Data/NetOutput 呈现为图边界。多个消费者分别计数。布局中显示的图输入输出元素单独计算。

在本次记录的 `out/` 样本集，209 个 OMC 文件路径完成二进制解析与数据输入引用校验。上表后三个样本另用已安装的 Electron 应用打开、展开子图并检查可见节点的属性。截图见 [DeltaNet](docs/omc/delta.png)、[六层 ViT](docs/omc/vit-six.png) 和 [整网 ViT](docs/omc/vit-full.png)。六层样本的原厂 OMG 顶层解码顺序为 Data（/blocks.17/Add_1_output_0）、CastT（graphop_data_cast_0）、GraphOp（SubGraph_0）、NetOutput（Node_Output）。

## 编译产物中能看到哪些信息

加载器检查 IMOD 容器、模型类型 4 和分区边界，解码图分区的 GE ModelDef，继续解码 GraphOp 属性中内嵌的 GE GraphDef。节点名称、端口索引、设备侧布局和数据类型来自模型描述。逻辑输入与设备子图内部张量可能有不同的形状或精度，请在对应图层查看。

桌面端以文件流读取 OMC，预读窗口为 64 KiB。打开整网时，解析器请求约 16.03 MB 的图及容器数据。权重由描述符给出的分区、偏移及长度按需读取。部分设备布局采用打包权重，张量面板反映编译描述符和存储内容。

本版本验证范围为工程中的未加密 Kirin HiAI OMC。模型中的融合核只显示编译器保留的算子、端口与属性。原始 HF 层次、融合核内指令、运行时间及实际占用的 NPU 核数需要编译映射或设备侧 profiling 另行对照。未解释的二进制属性以长度显示。

## 复现

从本仓库根目录执行。第一条校验同时读取厂商 OMG 输出的 JSON，验证顶层算子名称、类型、每个输入引用及图边界端口。第二条检查完整 ViT 的数据连接，并输出各图的算子种类和边界张量。

```sh
node test/omc.mjs --reference \
  ../../out/ge-atc-kirin9050-20261119/state_a_kirin9050_omc.json \
  ../../out/ge-atc-kirin9050-20261119/state_a_kirin9050.omc
node test/omc.mjs \
  ../../out/qwen35-2b-20261119/vision/full-compile/full-npu/vision_quant.omc
```

在 Apple Silicon macOS 构建独立应用，可用 Node 26 和 npm 执行以下命令。生成的应用位于 `dist/mac-arm64/Netron OMC.app`，采用本机 ad-hoc 签名。正常安装依赖时 npm 会下载锁定版本的 Electron。

```sh
npm ci --no-audit --no-fund
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir --publish never \
  -c.electronDist=node_modules/electron/dist -c.mac.identity=- -c.mac.notarize=false
codesign --verify --deep --strict 'dist/mac-arm64/Netron OMC.app'
```

本机打包使用 Electron 45.3.4 darwin-arm64。若单独准备运行时，可从 Electron 发布包取得同版本 ZIP，按 `node_modules/electron/checksums.json` 校验后解压到 `node_modules/electron/dist/`。此次使用的 ZIP SHA-256 为 `f3ac0124c48a6cc3aa9332caca0e913cc478cd3610a378881729ca33452caa72`。应用的 bundle ID 为 `local.cannkit.netron.omc`，注册 .omc 文档类型。
