import type { ModelInfo } from "./types";

/** 一行模型定位说明，用于批量打标模型列表与单图建议模型选择。 */
export function modelDescription(item: ModelInfo): string {
  if (item.kind === "caption") {
    return "自然语言描述：生成完整句子，并按句号拆成多条短语";
  }
  const id = item.id.toLowerCase();
  const legacy = id.includes("v1-4");
  if (id.includes("eva02")) {
    return "EVA02-Large 主干：高精度，模型体积与内存占用最大";
  }
  if (id.includes("vit-large")) {
    return "ViT-Large 主干（v3）：比普通 ViT 更准，显存/内存占用更高";
  }
  if (id.includes("swinv2")) {
    return legacy
      ? "SwinV2（v1.4 权重）：老版标签体系，体积约 435 MB"
      : "SwinV2 主干（v3）：局部细节与速度较均衡";
  }
  if (id.includes("convnextv2")) {
    return "ConvNeXt V2（v1.4 权重）：较新主干，角色与服装细节稳定";
  }
  if (id.includes("convnext")) {
    return legacy
      ? "ConvNeXt（v1.4 权重）：经典标签体系，按版本体积约 360–370 MB"
      : "ConvNeXt 主干（v3）：角色与服装标签覆盖较稳";
  }
  if (id.includes("moat")) {
    return "MOAT（v1.4 权重）：通用标签覆盖较广，体积约 311 MB";
  }
  if (id.includes("vit")) {
    return legacy
      ? "ViT（v1.4 权重）：老版轻量模型，适合快速初筛"
      : "ViT 主干（v3）：轻量快速，适合大批量初筛";
  }
  if (id.includes("swin")) {
    return "Swin（v1.4 权重）：兼顾全局构图与局部细节";
  }
  if (id.includes("z3d") || id.includes("e621")) {
    return "社区微调 WD14：标签风格依训练集而定";
  }
  return "WD14 ONNX 标签模型：本地推理，不上传图片";
}

export function modelKindLabel(item: ModelInfo): string {
  return item.kind === "caption" ? "自然语言描述" : "短语标签";
}
