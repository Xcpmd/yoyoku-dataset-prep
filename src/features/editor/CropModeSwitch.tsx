import { Segmented } from "../../components/ui";

export type CropMode = "masonry" | "single";

export const CROP_MODE_KEY = "yk.crop.mode";

export function readCropMode(): CropMode {
  try {
    return window.localStorage.getItem(CROP_MODE_KEY) === "single" ? "single" : "masonry";
  } catch {
    return "masonry";
  }
}

export function writeCropMode(mode: CropMode): void {
  try {
    window.localStorage.setItem(CROP_MODE_KEY, mode);
  } catch {
    // 忽略隐私模式下的本地存储限制
  }
}

export function CropModeSwitch({
  mode,
  onChange,
}: {
  mode: CropMode;
  onChange: (mode: CropMode) => void;
}) {
  return (
    <Segmented
      value={mode}
      onChange={onChange}
      options={[
        { value: "masonry", label: "瀑布流", icon: "grid" },
        { value: "single", label: "单图编辑", icon: "maximize" },
      ]}
      compact
      ariaLabel="裁剪模式"
    />
  );
}
