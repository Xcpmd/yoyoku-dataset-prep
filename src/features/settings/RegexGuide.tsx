import { useProject } from "../../app/ProjectContext";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/ui";
import { S } from "../../lib/strings";
import { copyText } from "../../lib/utils";

const filenameTemplate = "[{{artist: str}}] {{id: int}}.png";
const filenameRegex = "^\\[(?P<artist>[^\\]]+)\\] (?P<id>[0-9]+)\\.png$";
const tagTemplate = "artist: {{artist}}\nid: {{id}}";

export function RegexGuide() {
  const { notify } = useProject();
  const copy = async (value: string) => {
    const ok = await copyText(value);
    notify({ tone: ok ? "success" : "danger", message: ok ? "已复制示例" : S.errors.clipboard });
  };
  const example = (label: string, value: string) => (
    <div className="regex-guide-example">
      <div>
        <span>{label}</span>
        <code>{value}</code>
      </div>
      <IconButton icon="copy" size="sm" label={"复制" + label} onClick={() => void copy(value)} />
    </div>
  );

  return (
    <details className="settings-card full regex-guide">
      <summary>
        <Icon name="file" />
        <h3>正则使用指南</h3>
        <Icon name="chevron-down" className="sm" />
      </summary>
      <div className="regex-guide-body">
        <section>
          <h4>搜索图片</h4>
          <p>在图库、裁剪或打标页点击 <code>.*</code>，选定搜索字段。停止输入约 300 毫秒后自动搜索。用 <code>Aa</code> 开关控制大小写匹配。</p>
          {example("文件名以 .png 结尾", "\\.png$")}
          {example("文件名以 photo 或 image 开头", "^(photo|image)")}
        </section>
        <section>
          <h4>组合筛选</h4>
          <p>在筛选中添加条件，选中文本字段后将比较方式设为「匹配正则」。组合条件默认忽略大小写，可用 <code>(?-i:…)</code> 指定区分大小写的片段。</p>
          {example("匹配 PNG 或 WebP 扩展名", "^(png|webp)$")}
          <p><code>^</code> 匹配开头，<code>$</code> 匹配结尾，<code>\.</code> 匹配点号，<code>|</code> 表示任选其一。直接填入表达式即可。此语法不支持前瞻、后顾和反向引用。</p>
        </section>
        <section>
          <h4>从文件名添加标签</h4>
          <p>在图库选中图片，打开「批量编辑 → 从文件名添加标签」。以 <code>[青山] 0042.png</code> 为例，<code>str</code> 提取文本，<code>int</code> 提取数字并保留前导零。</p>
          {example("文件名模板", filenameTemplate)}
          <p>也可以切换到「原生正则」，用 <code>(?P&lt;名称&gt;…)</code> 命名捕获组。原生正则默认区分大小写，可在开头加 <code>(?i)</code>。</p>
          {example("文件名正则", filenameRegex)}
          <p>标签模板每行一个标签。<code>{"{{artist}}"}</code> 按名称引用，<code>{"{{1}}"}</code> 引用第一个捕获组。</p>
          {example("标签模板", tagTemplate)}
          <p>预览结果为 <code>artist: 青山</code> 和 <code>id: 0042</code>。未匹配的图片会跳过，可在预览中查看原因。</p>
        </section>
        <section>
          <h4>替换或删除现有标签</h4>
          <p>「正则替换标签」逐个标签替换匹配的片段。「正则删除标签」移除匹配的整个标签。默认区分大小写，可用 <code>(?i)</code> 忽略大小写。</p>
          {example("匹配以 artist: 开头的标签", "^artist:\\s*(.+)$")}
          {example("替换为", "by {{1}}")}
          <p>先点「预览变更」核对增删与跳过的图片，再点「应用」。应用后可用 <kbd>Ctrl+Z</kbd> 撤销。</p>
        </section>
      </div>
    </details>
  );
}
