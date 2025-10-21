# Pad 版本内容重建工具 (PadContentRebuild)

## 概述

`PadContentRebuild.js` 是一个用于重建 Etherpad Pad 版本内容的工具。它通过直接调用 Etherpad 的 Changeset 核心函数，模拟 timeslider 的版本重建过程，将每个版本的完整内容重建并存储到数据库中。


```bash
# 进入 src 目录
cd src

# 运行重建工具
node --require tsx/cjs node/scheduler/PadContentRebuild.js <padId>
```

