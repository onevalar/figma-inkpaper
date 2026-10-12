import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CreditCard,
  FileImage,
  FileText,
  Grid2X2,
  Package,
  PanelsTopLeft,
  Settings as SettingsIcon,
  Upload,
} from "lucide-react";
import { Button, type ButtonProps } from "../components/arc/button/button";
import { Input } from "../components/arc/input/input";
import { Select } from "../components/arc/select/select";
import { Combobox } from "../components/arc/combobox/combobox";
import { Switch } from "../components/arc/switch/switch";
import SegmentedControl from "../components/arc/segmented-control/segmented-control";
import { RadioCards } from "../components/arc/radio-cards/radio-cards";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../components/arc/tabs/tabs";
import { Accordion } from "../components/arc/accordion/accordion";
import { ExpandableCard } from "../components/arc/expandable-card/expandable-card";
import { Slider } from "../components/arc/slider/slider";
import { Alert } from "../components/arc/alert/alert";
import { Badge } from "../components/arc/badge/badge";
import { EmptyState } from "../components/arc/empty-state/empty-state";
import { Skeleton } from "../components/arc/skeleton/skeleton";
import { Dialog, DialogContent } from "../components/arc/dialog/dialog";
import { Progress } from "../components/arc/progress/progress";
import {
  S,
  render,
  DEFAULTS,
  RICH_PRESETS,
  MORE_KEYS,
  BUILTIN_PROFILES,
  getPath,
  update,
  toUnit,
  UNIT_NAMES,
  hexToRgb,
  fmtC,
  cmykFor,
  currentProfile,
  allMaps,
  frameSize,
  orderedFrames,
  checkKey,
  currentIssues,
  readiness,
  profileName,
  profileDirty,
  nupGrid,
  impSheets,
  impLabel,
  exportLabel,
  paintPreview,
  engine,
  dispatchAction,
  changeValue,
} from "./ui";
import type { ImpKind, CheckTab } from "./ui";
import {
  PAPER_PRESETS,
  SHEET_PRESETS,
  DIELINE_KEYWORDS,
  uni,
  type Issue,
  type ScannedColor,
} from "../shared";
import { tac, type CMYK } from "../pdf/color";
import { tr, LANGS } from "../i18n/i18n";
import "./layout.css";

export { MORE_KEYS };

// Only static metadata lives here. Never read the controller's live bindings at module scope.
export const DOC_KINDS = [
  {
    id: "book",
    name: "画册 / 书刊",
    desc: "A4 · 对页排列",
    noun: "画册",
    preset: "a4",
    pages: 8,
    facing: true,
    fold: "none",
    scale: 1,
    art: <BookOpen aria-hidden size={24} strokeWidth={1.75} />,
  },
  {
    id: "card",
    name: "名片 / 卡片",
    desc: "90×54 mm",
    noun: "名片",
    preset: "bc-cn",
    pages: 2,
    facing: false,
    fold: "none",
    scale: 1,
    art: <CreditCard aria-hidden size={24} strokeWidth={1.75} />,
  },
  {
    id: "poster",
    name: "海报 / 传单",
    desc: "A2 · A3 · A5",
    noun: "海报",
    preset: "a3",
    pages: 1,
    facing: false,
    fold: "none",
    scale: 1,
    art: <FileImage aria-hidden size={24} strokeWidth={1.75} />,
  },
  {
    id: "fold",
    name: "折页",
    desc: "对折 · 三折 · 关门折",
    noun: "折页",
    preset: "trifold-a4",
    pages: 2,
    facing: false,
    fold: "tri",
    scale: 1,
    art: <PanelsTopLeft aria-hidden size={24} strokeWidth={1.75} />,
  },
  {
    id: "pack",
    name: "包装 / 吊牌",
    desc: "可生成纸盒刀版",
    noun: "吊牌",
    preset: "hangtag",
    pages: 1,
    facing: false,
    fold: "none",
    scale: 1,
    art: <Package aria-hidden size={24} strokeWidth={1.75} />,
  },
  {
    id: "big",
    name: "大幅喷绘",
    desc: "易拉宝 · 按 1:10 制作",
    noun: "喷绘",
    preset: "rollup",
    pages: 1,
    facing: false,
    fold: "none",
    scale: 10,
    art: <FileText aria-hidden size={24} strokeWidth={1.75} />,
  },
] as const;

type Options = readonly (readonly [string | number | boolean, string])[];
type ChangeTarget = Parameters<typeof changeValue>[0];
const units: Options = [
  ["mm", "mm"],
  ["cm", "cm"],
  ["in", "in"],
  ["pt", "pt"],
];
const channels = ["c", "m", "y", "k"] as const;
const channelNames = { c: "C", m: "M", y: "Y", k: "K" };
const inkColors = { c: "#00A0E9", m: "#E5007D", y: "#FFE100", k: "#1d1d1f" };
const noChoice = "__inkpaper_none__";

/** Actions keep their attributes on Arc's native button and bubble to the existing controller. */
function Act({
  act,
  v,
  children,
  variant = "secondary",
  ...props
}: ButtonProps & { act: string; v?: string; children: ReactNode }) {
  return (
    <Button
      type="button"
      variant={variant}
      data-act={act}
      data-v={v}
      {...props}
    >
      {typeof children === "string" ? tr(children) : children}
    </Button>
  );
}
function Hint({ children }: { children: ReactNode }) {
  return (
    <p className="hint">
      {typeof children === "string" ? tr(children) : children}
    </p>
  );
}
function Section({
  title,
  children,
  className = "",
  literalTitle = false,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
  literalTitle?: boolean;
}) {
  return (
    <section className={`section ${className}`}>
      {title && <h2>{literalTitle ? title : tr(title)}</h2>}
      {children}
    </section>
  );
}
function SheetHead({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="sheet-h">
      <Act
        act="sheet"
        v=""
        variant="ghost"
        className="back"
        aria-label={tr("返回")}
      >
        <ArrowLeft aria-hidden size={16} strokeWidth={1.75} />
      </Act>
      <h1 className="title">{tr(title)}</h1>
      {right && <div className="sheet-actions">{right}</div>}
    </div>
  );
}
function Inks() {
  return (
    <span className="inks" aria-hidden>
      {channels.map((k) => (
        <i key={k} style={{ background: inkColors[k] }} />
      ))}
    </span>
  );
}
function SettingSwitch({
  path,
  label,
  hint,
}: {
  path: string;
  label: string;
  hint?: string;
}) {
  return (
    <div className="setting-switch">
      <Switch
        id={`setting-${path}`}
        label={tr(label)}
        checked={!!getPath(path)}
        onCheckedChange={(v) => update(path, v)}
      />
      {hint && <span className="hint">{tr(hint)}</span>}
    </div>
  );
}
function SettingText({
  path,
  label,
  placeholder = "",
}: {
  path: string;
  label: string;
  placeholder?: string;
}) {
  return (
    <Input
      id={`setting-${path}`}
      label={tr(label)}
      value={getPath(path) ?? ""}
      placeholder={tr(placeholder)}
      onChange={(e) => {
        e.stopPropagation();
        update(path, e.target.value);
      }}
    />
  );
}
function SettingNumber({
  path,
  label,
  min = 0,
  max,
  step = 1,
  unit = false,
  suffix,
}: {
  path: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: boolean;
  suffix?: string;
}) {
  const value = unit ? toUnit(getPath(path)) : getPath(path);
  const name = suffix || (unit ? S.settings.unit : "");
  // Keep typed values exact: NumberField snaps to its step grid on blur.
  return (
    <SpecialInput
      target={{
        id: `setting-${path}`,
        bind: path,
        t: "num",
        u: unit ? "1" : undefined,
      }}
      label={`${tr(label)}${name ? ` (${name})` : ""}`}
      type="number"
      value={value}
      min={min}
      max={max}
      step={unit && S.settings.unit !== "mm" ? "any" : step}
    />
  );
}
function Choice({
  id,
  label,
  value,
  options,
  onValueChange,
  searchable = false,
  translate = true,
  description,
}: {
  id?: string;
  label: string;
  value: string | number | boolean;
  options: Options;
  onValueChange: (v: string) => void;
  searchable?: boolean;
  translate?: boolean;
  description?: string;
}) {
  const items = options.map(([v, l]) => ({
    value: String(v) || noChoice,
    label: translate ? tr(l) : l,
  }));
  const change = (v: string) => onValueChange(v === noChoice ? "" : v);
  if (searchable)
    return (
      <Combobox
        id={id}
        label={tr(label)}
        value={String(value) || noChoice}
        options={items}
        onValueChange={change}
        description={description && tr(description)}
        placeholder={tr("— 选择 —")}
        emptyMessage={tr("没有找到颜色")}
      />
    );
  // Radix forbids empty option values; the sentinel is view-only, never stored in settings.
  return (
    <Select
      id={id}
      label={tr(label)}
      value={String(value) || noChoice}
      options={items}
      onValueChange={change}
      description={description && tr(description)}
    />
  );
}
function SettingSelect({
  path,
  label,
  options,
  numeric = false,
  searchable = false,
  translate = true,
}: {
  path: string;
  label: string;
  options: Options;
  numeric?: boolean;
  searchable?: boolean;
  translate?: boolean;
}) {
  return (
    <Choice
      id={`setting-${path}`}
      label={label}
      value={getPath(path)}
      options={options}
      searchable={searchable}
      translate={translate}
      onValueChange={(v) => update(path, numeric ? Number(v) : v)}
    />
  );
}
function Seg({
  label,
  value,
  options,
  onValueChange,
}: {
  label: string;
  value: string | number | boolean;
  options: Options;
  onValueChange: (v: string) => void;
}) {
  return (
    <div className="choice-row">
      <span className="field-label">{tr(label)}</span>
      <SegmentedControl
        label={tr(label)}
        value={String(value)}
        options={options.map(([v, l]) => ({ value: String(v), label: tr(l) }))}
        onValueChange={onValueChange}
      />
    </div>
  );
}
function SettingSeg({
  path,
  label,
  options,
}: {
  path: string;
  label: string;
  options: Options;
}) {
  return (
    <Seg
      label={label}
      value={getPath(path)}
      options={options}
      onValueChange={(v) =>
        update(path, options.find(([x]) => String(x) === v)![0])
      }
    />
  );
}
function Sides4({ base }: { base: string }) {
  return (
    <div className="grid4">
      {(["t", "r", "b", "l"] as const).map((k) => (
        <SettingNumber
          key={k}
          path={`${base}.${k}`}
          label={{ t: "上", r: "右", b: "下", l: "左" }[k]}
          min={0}
          step={0.5}
          unit
        />
      ))}
    </div>
  );
}
function SpecialInput({
  target,
  label,
  value,
  placeholder = "",
  type = "text",
  min,
  max,
  step,
}: {
  target: ChangeTarget;
  label: string;
  value: string | number;
  placeholder?: string;
  type?: string;
  min?: number;
  max?: number;
  step?: number | "any";
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value, target.id]);
  return (
    <Input
      id={target.id}
      label={tr(label)}
      value={draft}
      type={type}
      placeholder={tr(placeholder)}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        e.stopPropagation();
        setDraft(e.target.value);
      }}
      onBlur={(e) => {
        if (
          e.target.value !== String(value) &&
          (type !== "number" ||
            (e.target.value !== "" && Number.isFinite(e.target.valueAsNumber)))
        )
          changeValue(
            target,
            type === "number" ? e.target.valueAsNumber : e.target.value,
          );
      }}
    />
  );
}
/** Arc owns disclosure state and motion. Mirror genuine trigger/escape interactions to the controller
 * so reopening a route restores the same state. No proxy controls or fabricated events. */
function Disclosure({
  id,
  title,
  description,
  open,
  act,
  children,
  className,
}: {
  id: string;
  title: string;
  description?: string;
  open: boolean;
  act: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <ExpandableCard
      title={tr(title)}
      description={description && tr(description)}
      defaultExpanded={open}
      className={className}
      onClick={(e) => {
        const trigger = e.currentTarget.querySelector(
          ":scope > button[aria-expanded]",
        );
        if ((e.target as Element).closest("button") === trigger)
          dispatchAction(act, "");
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && e.currentTarget.dataset.expanded === "true")
          dispatchAction(act, "");
      }}
    >
      <div id={id} className="disclosure-content">
        {open ? children : null}
      </div>
    </ExpandableCard>
  );
}
function Loading({ label }: { label: string }) {
  return (
    <div className="loading" aria-busy="true">
      <p role="status" className="hint">
        {tr(label)}
      </p>
      <Skeleton label={tr(label)} lines={4} />
    </div>
  );
}
function NoSelection({ what }: { what: string }) {
  return (
    <EmptyState
      title={tr(what)}
      description={tr("在画布上选中画板，贴边的背景会自动延伸")}
      action={
        <Act act="route" v="prepare">
          新建印刷画板
        </Act>
      }
    />
  );
}

export function viewHead(): ReactNode {
  const settingsActive =
    ["settings", "resources", "transfer"].includes(S.sheet) ||
    S.sheetStack.includes("settings");
  return (
    <>
      <nav className="steps" aria-label={tr("插件工作区")}>
        {S.route === "welcome" ? (
          <span className="brand">Inkpaper 纸墨</span>
        ) : (
          (
            [
              ["prepare", "1", "准备"],
              ["check", "2", "检查"],
              ["export", "3", "导出"],
            ] as const
          ).map(([route, n, label]) => (
            <Act
              key={route}
              act="route"
              v={route}
              variant={S.route === route ? "secondary" : "ghost"}
              className="step"
              aria-current={S.route === route ? "page" : undefined}
            >
              <span className="num">{n}</span>
              <span>{tr(label)}</span>
            </Act>
          ))
        )}
      </nav>
      <div className="header-actions">
        {S.route !== "welcome" && (
          <Act
            act="sheet"
            data-root="1"
            v={S.sheet === "tools" ? "" : "tools"}
            variant={S.sheet === "tools" ? "secondary" : "ghost"}
            className="utility"
            title={tr("画布工具")}
            aria-label={tr("画布工具")}
          >
            <Grid2X2 aria-hidden size={16} strokeWidth={1.75} />
            <span className="utility-label">{tr("画布工具")}</span>
          </Act>
        )}
        <Act
          act="sheet"
          data-root="1"
          v={S.sheet === "settings" ? "" : "settings"}
          variant={settingsActive ? "secondary" : "ghost"}
          className="utility icon-only"
          title={tr("设置")}
          aria-label={tr("设置")}
        >
          <SettingsIcon aria-hidden size={16} strokeWidth={1.75} />
        </Act>
      </div>
    </>
  );
}

export function viewFoot(): ReactNode {
  if (S.sheet === "imposition")
    return (
      <div className="foot-actions">
        <Act act="imp-cancel">取消</Act>
        <Act act="sheet" v="" variant="primary" className="grow">
          {impLabel(S.settings.imp.kind)[0] === "不拼版"
            ? "完成"
            : `使用${impLabel(S.settings.imp.kind)[0]}`}
        </Act>
      </div>
    );
  if (S.sheet) return null;
  if (S.route === "welcome")
    return (
      <Act act="onboard" variant="primary" className="foot-primary">
        开始
      </Act>
    );
  if (S.route === "prepare") {
    const d = S.settings.doc;
    const kind = DOC_KINDS.find((k) => k.id === d.kind);
    const pp = PAPER_PRESETS.find((p) => p.id === d.preset);
    const size = pp
      ? tr(pp.name)
          .replace(/（.*?）|\(.*?\)/g, "")
          .trim()
      : `${toUnit(d.w)}×${toUnit(d.h)} ${S.settings.unit}`;
    return (
      <Act act="create-doc" variant="primary" className="foot-primary">
        <span className="foot-copy">
          <span>
            {tr(
              d.pages > 1
                ? `创建 ${d.pages} 页${kind?.noun || "印刷文档"}`
                : `创建${kind?.noun || "印刷文档"}`,
            )}
          </span>
          <span className="foot-sub">
            {size} · {tr("出血")}{" "}
            {d.sidesOn ? "…" : `${toUnit(d.bleed)} ${S.settings.unit}`}
          </span>
        </span>
      </Act>
    );
  }
  if (S.route === "check")
    return (
      <Act act="route" v="export" variant="primary" className="foot-primary">
        <span>{tr("返回导出")}</span>
        <ArrowRight aria-hidden size={16} strokeWidth={1.75} />
      </Act>
    );
  const label = exportLabel();
  return (
    <Act
      act="export"
      variant="primary"
      className="foot-primary"
      disabled={!S.frames.length || S.busy}
    >
      <span>{tr(label.main)}</span>
      {label.sub && <span>{tr(label.sub)}</span>}
    </Act>
  );
}

export function viewMain(): ReactNode {
  let body: ReactNode;
  switch (S.sheet) {
    case "settings":
      body = <SettingsView />;
      break;
    case "resources":
      body = <ResourcesView />;
      break;
    case "transfer":
      body = (
        <>
          <SheetHead title="预设导入 / 导出" />
          <Section>
            <Hint>包含印刷方案和颜色映射，不含 ICC 和色板。</Hint>
            <div className="actions">
              <Act act="import-json">导入 JSON</Act>
              <Act act="export-json">导出 JSON</Act>
            </div>
          </Section>
        </>
      );
      break;
    case "tools":
      body = <ToolsView />;
      break;
    case "more":
      body = <MoreView />;
      break;
    case "imposition":
      body = <ImpositionView />;
      break;
    case "profile":
      body = <ProfileView />;
      break;
    default:
      body =
        S.route === "welcome" ? (
          <WelcomeView />
        ) : S.route === "prepare" ? (
          <PrepareView />
        ) : S.route === "check" ? (
          <CheckView />
        ) : (
          <ExportView />
        );
  }
  return (
    <div
      className={`inkpaper-view${S.route === "check" && !S.sheet ? " check-view" : ""}`}
    >
      {body}
    </div>
  );
}

/** Mount alongside the three view roots. The controller owns open and its confirmation key;
 * action handling must close this controlled dialog rather than calling HTMLDialogElement.close(). */
export function ExportConfirmation({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const issues = currentIssues(),
    risks =
      issues?.filter((i) => i.level === "warning" || i.level === "error") || [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        id="export-confirm"
        className="quality"
        title={tr(issues ? "仍有风险，确认继续？" : "还未完成当前检查")}
        description={tr(
          issues
            ? "继续导出不会消除这些风险。"
            : "可以先检查，也可以跳过检查导出。跳过不代表文件适合送印。",
        )}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          document
            .querySelector<HTMLButtonElement>(
              '#export-confirm [data-act="export-cancel"]',
            )
            ?.focus();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          document
            .querySelector<HTMLButtonElement>('#foot [data-act="export"]')
            ?.focus();
        }}
      >
        {risks.length ? (
          <ul className="confirmation-risks">
            {risks.map((i, n) => (
              <li key={`${i.nodeId || ""}:${n}`}>{tr(i.msg)}</li>
            ))}
          </ul>
        ) : (
          S.settings.mode === "cmyk" &&
          !currentProfile() && <Hint>未选择 ICC，颜色仅能近似换算。</Hint>
        )}
        <div className="actions">
          <Act act="export-cancel">取消</Act>
          <Act act="route" v="check">
            {issues ? "查看检查" : "开始检查"}
          </Act>
          <Act act="export-confirm" variant="primary">
            {issues ? "接受风险并导出" : "跳过检查并导出"}
          </Act>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Progress is supplied by busy()/progress(); no imperative writes into React-owned nodes. */
export function ExportProgress({
  message,
  value,
}: {
  message: string;
  value: number;
}) {
  return (
    <div className="export-progress" role="status" aria-live="polite">
      <Progress label={tr(message)} value={value} max={1} showValue />
    </div>
  );
}

function IccHelp() {
  return (
    <Hint>
      <span>{tr("不知道用哪个？问印刷厂要，或从官网免费下载：")}</span>{" "}
      <a
        href="https://www.adobe.com/support/downloads/iccprofiles/iccprofiles_mac.html"
        target="_blank"
        rel="noopener noreferrer"
      >
        Adobe
      </a>{" "}
      /{" "}
      <a
        href="https://www.eci.org/en/downloads"
        target="_blank"
        rel="noopener noreferrer"
      >
        ECI
      </a>
    </Hint>
  );
}
function SettingsView() {
  return (
    <>
      <SheetHead title="设置" />
      <Section title="偏好">
        <Choice
          id="lang"
          label="界面语言"
          value={S.settings.lang}
          options={[
            ["", tr("跟随系统")],
            ...LANGS.map((l) => [l.code, l.name] as const),
          ]}
          translate={false}
          onValueChange={(v) => changeValue({ id: "lang" }, v)}
        />
        <SettingSelect path="unit" label="尺寸单位" options={units} />
        <div className="line">
          <span>{tr("外观")}</span>
          <span className="hint">{tr("跟随 Figma")}</span>
        </div>
      </Section>
      <Section title="资源管理">
        {[
          ["profile", "印刷方案与 ICC"],
          ["resources", "色板与颜色映射"],
          ["transfer", "预设导入 / 导出"],
        ].map(([v, l]) => (
          <Act
            key={v}
            act="sheet"
            v={v}
            variant="ghost"
            className="settings-link"
          >
            <span>{tr(l)}</span>
            <ArrowRight aria-hidden size={16} strokeWidth={1.75} />
          </Act>
        ))}
      </Section>
      <Accordion
        defaultOpen={-1}
        items={[
          {
            title: tr("关于与帮助"),
            content: (
              <>
                <Hint>Inkpaper 纸墨 · 全部在本机处理，不上传设计稿</Hint>
                <a
                  href="https://github.com/onevalar/figma-inkpaper#readme"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {tr("使用说明")}
                </a>
              </>
            ),
          },
        ]}
      />
    </>
  );
}
function WelcomeView() {
  return (
    <>
      <div className="welcome">
        <svg aria-hidden width="40" height="40" viewBox="0 0 44 44">
          <circle
            cx="22"
            cy="22"
            r="12"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
          />
          <circle cx="22" cy="22" r="6" fill="var(--accent)" />
          <path d="M22 2v40M2 22h40" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <h1>
          {tr("把屏幕上的设计，")}
          <br />
          {tr("变成纸上的墨。")}
        </h1>
        <Hint>准备 → 检查 → 导出</Hint>
      </div>
      <Section title="导入印刷厂的 ICC">
        {S.profiles.length ? (
          <div className="line">
            <Badge tone="success">{tr("已导入")}</Badge>
            <span className="grow wrap">
              {S.profiles.map((p) => p.name).join("、")}
            </span>
            <Act act="import-icc" variant="ghost">
              再导入
            </Act>
          </div>
        ) : (
          <Act id="icc-drop" act="import-icc" className="import-target">
            <Upload aria-hidden size={24} strokeWidth={1.75} />
            <span>{tr("拖入 .icc 文件，或点这里选择")}</span>
          </Act>
        )}
        <Hint>先跳过也可以，颜色会用近似算法换算</Hint>
        <Accordion
          defaultOpen={-1}
          items={[{ title: tr("ICC 获取帮助"), content: <IccHelp /> }]}
        />
      </Section>
    </>
  );
}

function PrepareView() {
  const s = S.settings,
    d = s.doc;
  const noMeta = S.frames.filter((f) => !f.meta);
  const paperOptions: Options = [
    ...PAPER_PRESETS.map(
      (p) => [p.id, `${tr(p.group)} · ${tr(p.name)}（${p.w}×${p.h}）`] as const,
    ),
    ...s.customPapers.map(
      (p, i) => [`custom:${i}`, `${tr("我的尺寸")} · ${p.name}`] as const,
    ),
    ["custom", tr("自定义尺寸…")],
  ];
  return (
    <>
      <div className="view-heading">
        <h1>{tr("要做什么印刷品？")}</h1>
        <Hint>选一个类型，自动带好出血、裁切线、安全区参考线</Hint>
      </div>
      <RadioCards
        aria-label={tr("要做什么印刷品？")}
        minColumnWidth={160}
        value={d.kind}
        onValueChange={(v) => dispatchAction("doc-kind", v)}
        options={DOC_KINDS.map((k) => ({
          value: k.id,
          label: (
            <span className="wrap" title={tr(k.name)}>
              {tr(k.name)}
            </span>
          ),
          description: tr(k.desc),
          icon: k.art,
        }))}
      />
      <Section>
        <Choice
          id="setting-doc.preset"
          label="尺寸"
          value={d.preset}
          options={paperOptions}
          translate={false}
          searchable
          onValueChange={(v) => changeValue({ act: "preset" }, v)}
        />
        <Seg
          label="方向"
          value={d.landscape ? "h" : "v"}
          options={[
            ["v", "竖版"],
            ["h", "横版"],
          ]}
          onValueChange={(v) => dispatchAction("orient", v)}
        />
        {!S.docMore &&
          (d.preset === "custom" || d.preset.startsWith("custom:")) && (
            <div className="grid2">
              <SettingNumber path="doc.w" label="宽" min={1} step={0.5} unit />
              <SettingNumber path="doc.h" label="高" min={1} step={0.5} unit />
            </div>
          )}
        <SettingNumber path="doc.pages" label="页数" min={1} max={400} />
        {d.kind === "book" && <Hint>骑马钉需要 4 的倍数</Hint>}
        {d.sidesOn ? (
          <Sides4 base="doc.sides" />
        ) : (
          <>
            <SettingNumber
              path="doc.bleed"
              label="出血"
              min={0}
              step={0.5}
              unit
            />
            <Hint>{`${tr("安全区")} ${toUnit(d.safety)} · ${tr("页边距")} ${toUnit(d.margin)} ${s.unit}`}</Hint>
          </>
        )}
        {d.w * d.h > 1000 * 1400 && d.scale === 1 && (
          <Alert
            tone="warning"
            title={tr(
              "幅面较大，建议用 1:10 比例制作，避免 Figma 卡顿；导出时会自动放大回实际尺寸。",
            )}
          />
        )}
      </Section>
      <Disclosure
        id="doc-advanced"
        title="更多尺寸选项"
        description="单位、页边距、四边出血、折页、比例、名称、保存常用尺寸"
        open={S.docMore}
        act="doc-more"
      >
        <SettingSeg path="unit" label="单位" options={units} />
        <div className="grid2">
          <SettingNumber path="doc.w" label="宽" min={1} step={0.5} unit />
          <SettingNumber path="doc.h" label="高" min={1} step={0.5} unit />
          <SettingNumber path="doc.margin" label="页边距" min={0} unit />
          <SettingNumber
            path="doc.safety"
            label="安全区"
            min={0}
            step={0.5}
            unit
          />
        </div>
        <SettingSwitch
          path="doc.sidesOn"
          label="四边出血不同"
          hint="（如装订边不需要出血）"
        />
        <SettingSelect
          path="doc.fold"
          label="折页"
          options={[
            ["none", "无"],
            ["half", "对折"],
            ["tri", "三折（风琴/卷折）"],
            ["z", "Z 字折"],
            ["gate", "关门折"],
          ]}
        />
        <SettingSelect
          path="doc.scale"
          label="制作比例"
          numeric
          options={[
            [1, "1:1 实际尺寸"],
            [2, "1:2"],
            [4, "1:4"],
            [5, "1:5"],
            [10, "1:10（大幅喷绘）"],
          ]}
        />
        <SettingSwitch path="doc.facing" label="对页排列（画册 / 书刊跨页）" />
        <SettingText path="doc.name" label="名称" />
        <div>
          <Act act="save-paper">保存为常用尺寸</Act>
        </div>
        <Hint>
          画板会包含出血区，并自动画出裁切线、安全区、折线参考线。按
          ⌘⇧4（Windows：Ctrl+Shift+4）显示或隐藏参考网格。
        </Hint>
      </Disclosure>
      <Section title="为现有画板添加出血">
        <Hint>
          {noMeta.length
            ? "按上方出血值扩大画板并延伸贴边元素，会修改原稿。"
            : S.frames.length
              ? "当前画板已有印刷设置；补足出血请到「导出」。"
              : "先在 Figma 中选择需要添加出血的画板。"}
        </Hint>
        <div>
          <Act act="convert-doc" disabled={!noMeta.length}>
            添加出血
          </Act>
        </div>
      </Section>
      <Section title="一次建很多尺寸">
        <Hint>{`CSV 每行：名称,宽,高,出血,页数（单位 ${UNIT_NAMES[s.unit]}）`}</Hint>
        <div className="actions">
          <Act act="csv-import">导入 CSV</Act>
          <Act act="csv-template" variant="ghost">
            下载模板
          </Act>
        </div>
      </Section>
    </>
  );
}

function Readiness() {
  const [cls, text, link] = readiness();
  const count =
    currentIssues()?.filter((i) => i.level === "warning" || i.level === "error")
      .length || 0;
  const label = count
    ? `${count} 项风险`
    : cls === "ok"
      ? "未发现已知风险"
      : S.pendingIssuesKey === checkKey()
        ? "正在检查…"
        : S.issues
          ? "需重新检查"
          : "未检查";
  return (
    <section className="quality line" title={tr(text)} aria-live="polite">
      <Badge
        tone={
          cls === "err"
            ? "danger"
            : cls === "warn"
              ? "warning"
              : cls === "ok"
                ? "success"
                : "neutral"
        }
      >
        {tr(label)}
      </Badge>
      {link && (
        <Act act="route" v="check" variant="ghost">
          {link}
        </Act>
      )}
    </section>
  );
}
function BleedWarning() {
  const s = S.settings;
  const req = s.bleedSidesOn ? s.bleedSides : uni(s.bleedMm);
  const short = S.frames.filter((f) => {
    if (!f.meta) return false;
    const b = f.meta.bleedSides || uni(f.meta.bleed);
    return (
      req.t > b.t + 0.01 ||
      req.r > b.r + 0.01 ||
      req.b > b.b + 0.01 ||
      req.l > b.l + 0.01
    );
  });
  return short.length ? (
    <Alert
      tone="warning"
      title={tr(
        `${short.length} 个画板做的出血比这里设置的少，导出时只能按画板实际的出血输出。`,
      )}
    >
      <Act act="convert-frames">为这些画板补足出血</Act>
    </Alert>
  ) : null;
}
function Pages() {
  const frames = orderedFrames(),
    s = S.settings,
    first = frames[0],
    size = frameSize(first);
  const same = frames.every((f) => {
    const z = frameSize(f);
    return Math.abs(z.w - size.w) < 0.5 && Math.abs(z.h - size.h) < 0.5;
  });
  const preset = PAPER_PRESETS.find(
    (p) => Math.abs(p.w - size.w) < 0.6 && Math.abs(p.h - size.h) < 0.6,
  );
  const sizeText = `${toUnit(size.w)}×${toUnit(size.h)} ${s.unit}`;
  const pname = preset
    ? tr(preset.name)
        .replace(/（.*?）|\(.*?\)/g, "")
        .trim()
    : "";
  const summary = !same
    ? tr("多种尺寸")
    : !preset
      ? sizeText
      : /\d×\d/.test(pname)
        ? `${pname} ${s.unit}`
        : `${pname} · ${sizeText}`;
  return (
    <section className="pages-summary">
      <div className="pages-compact">
        {S.thumbs[first.id] && (
          <img data-thumb={first.id} src={S.thumbs[first.id]} alt="" />
        )}
        <span className="num">{tr(`${frames.length} 页待导出`)}</span>
        <span className="hint">{summary}</span>
      </div>
      <Disclosure
        id="export-pages"
        title="查看与排序"
        open={S.pagesOpen}
        act="pages-open"
      >
        <Hint>拖动排序，也可用前移、后移按钮调整。</Hint>
        <div className="strip">
          {frames.map((f, i) => (
            <div className="page" key={f.id} draggable data-drag={i}>
              <Act
                act="select"
                v={f.id}
                variant="ghost"
                className="page-select"
                title={f.name}
              >
                <span className="page-content">
                  <span className="pg">
                    {S.thumbs[f.id] ? (
                      <img data-thumb={f.id} src={S.thumbs[f.id]} alt="" />
                    ) : (
                      <FileText aria-hidden size={24} />
                    )}
                  </span>
                  <span className="wrap num">
                    {i + 1} · {f.name}
                  </span>
                </span>
              </Act>
              <div className="page-order">
                <Act
                  act="page-move"
                  v={f.id}
                  data-dir="-1"
                  disabled={i === 0}
                  variant="ghost"
                  aria-label={`${tr("前移")} ${f.name}`}
                >
                  <ArrowLeft aria-hidden size={16} />
                </Act>
                <Act
                  act="page-move"
                  v={f.id}
                  data-dir="1"
                  disabled={i === frames.length - 1}
                  variant="ghost"
                  aria-label={`${tr("后移")} ${f.name}`}
                >
                  <ArrowRight aria-hidden size={16} />
                </Act>
              </div>
            </div>
          ))}
        </div>
      </Disclosure>
    </section>
  );
}
function ExportView() {
  const s = S.settings;
  if (!orderedFrames().length)
    return <NoSelection what="在画布上选择要导出的画板、编组或分区" />;
  const isPdf = s.format === "pdf";
  const customized =
    !!S.password ||
    [
      ...MORE_KEYS,
      "imp",
      "regMarks",
      "colorBars",
      "author",
      "subject",
      "keywords",
    ].some((k) => {
      if (
        s.compression !== "custom" &&
        ["imageCompression", "jpegQuality", "maxPpi"].includes(k)
      )
        return false;
      return (
        JSON.stringify((s as unknown as Record<string, unknown>)[k]) !==
        JSON.stringify((DEFAULTS as unknown as Record<string, unknown>)[k])
      );
    });
  return (
    <>
      <h1>{tr("导出")}</h1>
      <Pages />
      <Readiness />
      <Act act="sheet" v="profile" variant="ghost" className="profile">
        <span className="profile-content">
          <Inks />
          <span className="profile-copy">
            <span>{tr("印刷方案")}</span>
            <span>
              {s.profileId.startsWith("user:")
                ? profileName()
                : tr(profileName() || "自定义")}
              {profileDirty() && <> {tr("（已修改）")}</>}
            </span>
            <span className="hint wrap">
              {s.mode === "cmyk"
                ? currentProfile()?.name || tr("未选择 ICC，颜色仅能近似换算。")
                : s.mode === "rgb"
                  ? "RGB"
                  : tr("灰度")}
            </span>
          </span>
          <ArrowRight aria-hidden size={16} />
        </span>
      </Act>
      <Section title="输出设置" className="output-settings">
        <SettingSeg
          path="format"
          label="格式"
          options={[
            ["pdf", "PDF"],
            ["tiff", "TIFF"],
            ["jpeg", "JPEG"],
            ["png", "PNG"],
          ]}
        />
        {!isPdf && (
          <>
            <SettingSelect
              path="rasterDpi"
              label="分辨率"
              numeric
              options={[
                [150, "150 dpi"],
                [300, "300 dpi（标准印刷）"],
                [600, "600 dpi（细线、条码）"],
                [1200, "1200 dpi"],
              ]}
            />
            <Hint>
              {s.format === "png"
                ? "PNG 只能是 RGB，适合数码快印。"
                : `${s.mode === "cmyk" ? "CMYK" : s.mode === "gray" ? "灰度" : "RGB"} 位图，内嵌 ICC 和 DPI，文字和矢量会变成像素。`}
            </Hint>
          </>
        )}
        {s.bleedSidesOn ? (
          <Act
            act="sheet"
            v="more"
          >{`${tr("出血")} ${s.bleedSides.t}/${s.bleedSides.r}/${s.bleedSides.b}/${s.bleedSides.l} mm`}</Act>
        ) : (
          <SettingNumber
            path="bleedMm"
            label="出血"
            min={0}
            max={20}
            step={0.5}
            unit
          />
        )}
        {isPdf && <SettingSwitch path="cropMarks" label="裁切线" />}
        <BleedWarning />
        <SettingText
          path="title"
          label="文件名"
          placeholder={S.fileName || "印刷文件"}
        />
        <span className="hint">
          {isPdf
            ? ".pdf"
            : `.${({ tiff: "tif", jpeg: "jpg", png: "png" } as Record<string, string>)[s.format]}`}
        </span>
      </Section>
      <Disclosure
        id="export-advanced"
        title="专业设置"
        description={customized ? "已自定义" : undefined}
        open={s.advancedOpen}
        act="more-open"
        className="advanced"
      >
        <div className="section output-settings">
          {isPdf && (
            <>
              <div className="line">
                <span>{tr("拼版")}</span>
                <Act act="sheet" v="imposition">
                  {impLabel(s.imp.kind)[0]}
                </Act>
              </div>
              <SettingSelect
                path="textOutline"
                label="文字"
                options={[
                  ["perNode", "按图层设置"],
                  ["none", "全部保留"],
                  ["all", "全部转曲"],
                ]}
              />
              <SettingSelect
                path="output"
                label="文件输出"
                options={[
                  ["merged", "合并为一个 PDF"],
                  ["separate", "每页单独一个文件"],
                ]}
              />
              <div className="switches">
                <SettingSwitch path="regMarks" label="套准" />
                {s.mode !== "rgb" && (
                  <SettingSwitch path="colorBars" label="色标条" />
                )}
              </div>
            </>
          )}
          <SettingSelect
            path="compression"
            label="图片压缩"
            options={[
              ["light", "轻度"],
              ["balanced", "均衡"],
              ["strong", "强力"],
              ["custom", "自定义"],
            ]}
          />
          <Act act="sheet" v="more">
            全部专业设置
          </Act>
        </div>
      </Disclosure>
      {S.lastResult && (
        <Disclosure
          id="export-result"
          title="上次导出结果"
          description={`共 ${S.lastResult.files.length} 个文件`}
          open={S.resultOpen}
          act="result"
        >
          <ExportReports />
        </Disclosure>
      )}
    </>
  );
}
function ExportReports() {
  const r = S.lastResult;
  if (!r) return null;
  return (
    <div className="export-reports">
      <ul className="files">
        {r.files.map((f, i) => (
          <li key={`${f.name}:${i}`} className="wrap num">
            {f.name} · {Math.round(f.bytes.length / 1024)} KB
          </li>
        ))}
      </ul>
      {r.reports.map((p, i) => (
        <article key={`${p.page}:${i}`} className="report">
          <h2>{p.page}</h2>
          <Badge
            tone={
              p.flattened || (p.remainingRgb !== 0 && S.settings.mode !== "rgb")
                ? "warning"
                : "success"
            }
          >
            {tr(
              p.flattened
                ? "已整页拼合为图像"
                : p.remainingRgb === 0 || S.settings.mode === "rgb"
                  ? "颜色已全部转换"
                  : `还有 ${p.remainingRgb} 处保持 RGB`,
            )}
          </Badge>
          {!!p.images.length && <Hint>{`图片 ${p.images.length} 张`}</Hint>}
          {!!p.images.filter((im) => im.newW).length && (
            <Hint>{`${p.images.filter((im) => im.newW).length} 张已降采样`}</Hint>
          )}
          {!!p.hairlinesFixed && (
            <Hint>{`加粗细线 ${p.hairlinesFixed} 处`}</Hint>
          )}
          {!!p.spotsUsed.length && (
            <Hint>
              <span>{tr("专色：")}</span>
              {p.spotsUsed.join(", ")}
            </Hint>
          )}
          {p.leftovers.map((l, j) => (
            <Alert key={j} tone="warning" title={tr(l)} />
          ))}
        </article>
      ))}
    </div>
  );
}

function MoreView() {
  const s = S.settings,
    pdf = s.format === "pdf";
  const spots = Object.values(s.overrides).filter((o) => o.spot),
    fin = Object.entries(s.colorFinishing);
  return (
    <>
      <SheetHead
        title="专业设置"
        right={
          <Act act="more-reset" variant="ghost">
            恢复默认
          </Act>
        }
      />
      <Section title="出血与标记">
        <SettingSwitch path="bleedSidesOn" label="四边出血分别设置" />
        {s.bleedSidesOn && <Sides4 base="bleedSides" />}
        <SettingSwitch
          path="autoBleed"
          label="自动延伸未设出血画板的贴边元素"
          hint="（不修改设计稿）"
        />
        {pdf && (
          <>
            <SettingSwitch
              path="trimLine"
              label="成品框线"
              hint="校对用，裁切位置画一圈细线"
            />
            <SettingNumber
              path="markWeight"
              label="标记线宽"
              min={0.1}
              max={1}
              step={0.05}
              suffix="pt"
            />
          </>
        )}
      </Section>
      {s.mode !== "rgb" && (
        <Section title="刀版与专色">
          <SettingSeg
            path="dielineMode"
            label="识别刀线和工艺"
            options={[
              ["off", "关闭"],
              ["auto", "按图层名"],
              ["manual", "手动指定"],
            ]}
          />
          {s.dielineMode === "manual" && (
            <SettingText
              path="dielineNames"
              label="手动指定"
              placeholder="专色名，例如 CutContour, Kiss Cut"
            />
          )}
          <Accordion
            defaultOpen={-1}
            items={[
              {
                title: tr("刀线与工艺识别规则"),
                content: (
                  <>
                    <Hint>
                      图层名以下面关键词开头的图层，会单独输出成对应的专色版，并自动叠印。刀线、折线、压痕、打孔会输出成真正的单线路径。也可以在「检查
                      → 颜色」里把某个颜色指定为刀线或工艺。
                    </Hint>
                    <dl className="keyword-list">
                      {DIELINE_KEYWORDS.map((d) => (
                        <React.Fragment key={d.spot}>
                          <dt className="mono">{d.spot}</dt>
                          <dd>
                            {d.key.source
                              .replace(/^\^\\\[\?\\s\*\(/, "")
                              .replace(/\)$/, "")
                              .replace(/\|/g, " / ")
                              .replace(/\.\?/g, " ")}
                          </dd>
                        </React.Fragment>
                      ))}
                    </dl>
                  </>
                ),
              },
            ]}
          />
          {!!fin.length && (
            <Hint>
              <span>{tr("按颜色指定：")}</span>
              {fin.map(([hex, sp]) => `${hex} → ${sp}`).join("，")}
            </Hint>
          )}
          {pdf && (
            <SettingSeg
              path="dielineFile"
              label="刀版输出"
              options={[
                ["inline", "随文件"],
                ["separate", "单独文件"],
                ["both", "两种都要"],
              ]}
            />
          )}
          <SettingSeg
            path="spotPolicy"
            label="专色"
            options={[
              ["preserve", "保留专色"],
              ["flatten", "转为四色"],
              ["keepListed", "只保留指定"],
            ]}
          />
          {s.spotPolicy === "keepListed" && (
            <SettingText
              path="keepSpots"
              label="只保留指定"
              placeholder="专色名，用逗号分隔"
            />
          )}
          {!!spots.length && (
            <Hint>
              <span>{tr("当前专色：")}</span>
              {spots.map((o) => o.spot!.name).join("、")}
            </Hint>
          )}
        </Section>
      )}
      <Section title="文字与图片">
        {pdf && (
          <SettingSeg
            path="textOutline"
            label="文字"
            options={[
              ["none", "全部保留"],
              ["perNode", "按图层设置"],
              ["all", "全部转曲"],
            ]}
          />
        )}
        <SettingSeg
          path="compression"
          label="图片压缩"
          options={[
            ["light", "轻度"],
            ["balanced", "均衡"],
            ["strong", "强力"],
            ["custom", "自定义"],
          ]}
        />
        {s.compression === "custom" ? (
          <>
            <SettingSelect
              path="maxPpi"
              label="降采样"
              numeric
              options={[
                [0, "不降采样"],
                [300, "超过 450ppi 降到 300ppi"],
                [450, "超过 675ppi 降到 450ppi"],
                [600, "超过 900ppi 降到 600ppi"],
              ]}
            />
            <SettingSelect
              path="imageCompression"
              label="编码"
              options={[
                ["auto", "自动（照片 JPEG，图形无损）"],
                ["jpeg", "全部 JPEG"],
                ["lossless", "全部无损"],
              ]}
            />
            {s.imageCompression !== "lossless" && (
              <SettingNumber
                path="jpegQuality"
                label="JPEG 质量"
                min={50}
                max={100}
              />
            )}
          </>
        ) : (
          <Hint>
            {
              {
                light: "图片几乎不压缩，质量最高",
                balanced: "JPEG 90，超过 675ppi 的图片降到 450ppi",
                strong: "JPEG 80，图片统一降到 300ppi，文件最小",
              }[s.compression]
            }
          </Hint>
        )}
      </Section>
      {pdf && (
        <Section title="文件信息与安全">
          <SettingSwitch path="bookmarks" label="每页书签" />
          {(s.pdfx === "none" || s.mode === "rgb") && (
            <SettingSwitch path="keepLinks" label="保留超链接" />
          )}
          <SettingText path="author" label="作者" />
          <SettingText path="subject" label="主题" />
          <SettingText
            path="keywords"
            label="关键词"
            placeholder="用逗号分隔"
          />
          {s.pdfx === "none" || s.mode === "rgb" ? (
            <>
              <SpecialInput
                target={{ id: "pdf-password" }}
                label="打开密码"
                type="password"
                value={S.password}
                placeholder="留空则不加密"
              />
              <Hint>AES-256 加密。密码不会被保存。</Hint>
            </>
          ) : (
            <Hint>PDF/X 不允许加密，需要密码请在印刷方案里改用普通 PDF</Hint>
          )}
        </Section>
      )}
      <Section title="附加输出">
        {pdf && s.mode !== "rgb" && (
          <SettingSwitch
            path="alsoDigital"
            label="同时导出 RGB 屏幕版"
            hint="无出血无标记，发给客户看"
          />
        )}
        <Switch
          id="setting-output"
          label={tr(pdf ? "每页单独一个文件" : "每页单独下载（不打包）")}
          checked={s.output === "separate"}
          onCheckedChange={(v) => update("output", v ? "separate" : "merged")}
        />
        {pdf && (
          <SettingNumber
            path="scalePct"
            label="输出缩放"
            min={10}
            max={1000}
            step={5}
            suffix="%"
          />
        )}
      </Section>
    </>
  );
}

function ImpArt({ kind }: { kind: ImpKind }) {
  return (
    <svg aria-hidden width="50" height="36" viewBox="0 0 50 36">
      <rect
        x="1"
        y="1"
        width="48"
        height="34"
        fill="var(--background)"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      {(kind === "spreads" || kind === "booklet") && (
        <path
          d="M25 1v34"
          stroke="currentColor"
          strokeDasharray={kind === "booklet" ? "2 2" : undefined}
        />
      )}
      {(kind === "nup" || kind === "duplex") &&
        [0, 1, 2].flatMap((r) =>
          [0, 1, 2].map((c) => (
            <rect
              key={`${r}:${c}`}
              x={5 + c * 14}
              y={5 + r * 9}
              width="12"
              height="7"
              fill="currentColor"
              opacity=".5"
            />
          )),
        )}
      {kind === "booklet" && (
        <>
          <text x="11" y="30" fill="currentColor">
            4
          </text>
          <text x="35" y="30" fill="currentColor">
            1
          </text>
        </>
      )}
      {kind === "duplex" && (
        <path d="M9 18h30m-5-5 5 5-5 5" stroke="var(--accent)" fill="none" />
      )}
    </svg>
  );
}
function ImpositionView() {
  const i = S.settings.imp,
    f = orderedFrames()[0],
    kinds: ImpKind[] = ["none", "spreads", "booklet", "nup", "duplex"];
  const g = nupGrid();
  const sheets = impSheets(orderedFrames().length),
    scale = Math.min(104 / i.sheetW, 148 / i.sheetH);
  return (
    <>
      <SheetHead
        title="拼版方式"
        right={f && <span className="hint wrap">{f.name}</span>}
      />
      <RadioCards
        aria-label={tr("拼版方式")}
        value={i.kind}
        minColumnWidth={160}
        onValueChange={(v) => update("imp.kind", v)}
        options={kinds.map((k) => ({
          value: k,
          label: (
            <span className="wrap" title={tr(impLabel(k)[0])}>
              {tr(impLabel(k)[0])}
            </span>
          ),
          description: tr(impLabel(k)[1]),
          icon: <ImpArt kind={k} />,
        }))}
      />
      {i.kind === "none" && <Hint>每个画板单独一页输出。</Hint>}
      {i.kind === "spreads" && (
        <Hint>第 1 页单独一页，之后两页一组排成跨页，方便整体校对。</Hint>
      )}
      {i.kind === "booklet" && (
        <Section>
          <SettingSeg
            path="imp.rtl"
            label="翻页方向"
            options={[
              [false, "从左往右"],
              [true, "从右往左"],
            ]}
          />
          <Hint>
            页数会补齐到 4
            的倍数（空白页），按折页顺序排成正反面，双面打印后对折装订即可。从右往左适合竖排中文、日文、阿拉伯文。
          </Hint>
        </Section>
      )}
      {(i.kind === "nup" || i.kind === "duplex") && f && g && (
        <Section>
          <figure className="imposition-art">
            <div
              className="print-sheet"
              style={{ width: i.sheetW * scale, height: i.sheetH * scale }}
            >
              <div
                className="print-cells"
                style={{
                  gridTemplateColumns: `repeat(${g.cols}, ${g.cw * scale}px)`,
                  gap: Math.max(1, i.gutter * scale),
                }}
              >
                {Array.from({ length: Math.min(g.per, 1000) }, (_, n) => (
                  <i
                    key={n}
                    style={{ width: g.cw * scale, height: g.ch * scale }}
                  />
                ))}
              </div>
            </div>
            <figcaption className="num hint">
              {tr(`共 ${sheets} 张`)}
            </figcaption>
          </figure>
          <SettingSelect
            path="imp.sheet"
            label="印刷纸张"
            options={[
              ...SHEET_PRESETS.map((p) => [p.id, p.name] as const),
              ["custom", "自定义"],
            ]}
          />
          {i.sheet === "custom" && (
            <div className="grid2">
              <SettingNumber
                path="imp.sheetW"
                label="纸宽"
                min={50}
                suffix="mm"
              />
              <SettingNumber
                path="imp.sheetH"
                label="高"
                min={50}
                suffix="mm"
              />
            </div>
          )}
          <Hint>每张排（0 = 自动）</Hint>
          <div className="grid2">
            <SettingNumber path="imp.cols" label="列" min={0} />
            <SettingNumber path="imp.rows" label="行" min={0} />
            <SettingNumber
              path="imp.gutter"
              label="间距"
              min={0}
              step={0.5}
              suffix="mm"
            />
            <SettingNumber
              path="imp.copies"
              label="印数"
              min={1}
              suffix={tr("份")}
            />
          </div>
          {i.kind === "nup" && (
            <SettingSwitch path="imp.repeat" label="同一成品铺满整版" />
          )}
          <Hint>{`每张 ${g.cols} × ${g.rows} = ${g.per} 个，共 ${sheets} 张，裁切线画在拼版外侧。`}</Hint>
          {i.kind === "duplex" ? (
            <Hint>
              第 1、3、5… 页为正面，2、4、6…
              页为反面；反面自动左右镜像，长边翻转后与正面对齐。
            </Hint>
          ) : (
            !i.repeat && <Hint>按页序依次排。</Hint>
          )}
        </Section>
      )}
    </>
  );
}

function ProfileView() {
  const s = S.settings;
  const options = [
    ...BUILTIN_PROFILES.map((p) => ({
      value: p.id,
      label: (
        <span className="wrap" title={tr(p.name)}>
          {tr(p.name)}
        </span>
      ),
      description: tr(p.desc),
    })),
    ...S.presets.map((p, i) => ({
      value: `user:${i}`,
      label: (
        <span className="wrap" title={p.name}>
          {p.name}
        </span>
      ),
      description: tr("我的方案"),
    })),
  ];
  return (
    <>
      <SheetHead
        title="印刷方案"
        right={
          <>
            <Act act="import-json" variant="ghost">
              导入
            </Act>
            <Act act="export-json" variant="ghost">
              导出
            </Act>
          </>
        }
      />
      <Hint>
        一个方案 = 印刷厂的一套要求。选好以后，颜色转换、黑色处理、PDF
        标准都按它来，一般不用再改。
      </Hint>
      <RadioCards
        aria-label={tr("印刷方案")}
        value={s.profileId || null}
        layout="list"
        onValueChange={(v) => dispatchAction("profile", v)}
        options={options}
      />
      <Section
        title={s.profileId ? profileName() : "当前设置（自定义）"}
        literalTitle={s.profileId.startsWith("user:")}
      >
        {profileDirty() && <Badge>{tr("（已修改）")}</Badge>}
        <ProfileDetails />
      </Section>
      {!!S.presets.length && (
        <Section title="我的方案">
          {S.presets.map((p, i) => (
            <div className="line" key={`${p.name}:${i}`}>
              <span className="grow wrap">{p.name}</span>
              <Act
                act="del-preset"
                v={String(i)}
                variant="ghost"
                aria-label={`${tr("删除")} ${p.name}`}
              >
                删除
              </Act>
            </div>
          ))}
        </Section>
      )}
      <Section>
        <Input
          id="preset-name"
          label={tr("名称")}
          placeholder={tr("把当前设置存为新方案，例如「某某印刷厂 · 铜版纸」")}
        />
        <div>
          <Act act="save-preset">保存</Act>
        </div>
      </Section>
    </>
  );
}
function ProfileDetails() {
  const s = S.settings,
    prof = currentProfile();
  return (
    <>
      <Section title="颜色">
        <SettingSeg
          path="mode"
          label="输出色彩"
          options={[
            ["cmyk", "CMYK"],
            ["rgb", "RGB"],
            ["gray", "灰度"],
          ]}
        />
        {s.mode === "cmyk" ? (
          <>
            <SettingSelect
              path="iccId"
              label="ICC 配置文件"
              searchable
              translate={false}
              options={[
                ["", tr(S.profiles.length ? "— 选择 —" : "尚未导入 ICC")],
                ...S.profiles.map((p) => [p.id, p.name] as const),
              ]}
            />
            <div className="actions">
              <Act act="import-icc">导入</Act>
              {prof && (
                <Act act="del-icc" variant="ghost">
                  移除
                </Act>
              )}
            </div>
            {!S.profiles.length && (
              <Hint>
                <span>
                  {tr(
                    "请导入印刷厂提供的 ICC 文件。国内胶印一般用 Japan Color 2001 Coated，欧洲用 FOGRA39 / PSO Coated v3，北美用 GRACoL / SWOP。可从",
                  )}
                </span>{" "}
                <a
                  href="https://www.adobe.com/support/downloads/iccprofiles/iccprofiles_mac.html"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Adobe
                </a>{" "}
                /{" "}
                <a
                  href="https://www.eci.org/en/downloads"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ECI
                </a>{" "}
                {tr("免费下载。")}
              </Hint>
            )}
            <SettingSelect
              path="intent"
              label="渲染意图"
              numeric
              options={[
                [1, "相对比色（推荐）"],
                [0, "可感知（照片多时更顺滑）"],
                [2, "饱和度（图表、色块）"],
                [3, "绝对比色（模拟纸白）"],
              ]}
            />
            <SettingSwitch
              path="bpc"
              label="黑场补偿"
              hint="（保留暗部层次）"
            />
          </>
        ) : (
          <Hint>
            {s.mode === "gray"
              ? "所有颜色和图片会转成单色灰度（只用黑色油墨），适合黑白印刷。"
              : "保持 RGB 颜色，适合数码快印或屏幕阅读。出血、裁切线等功能照常可用。"}
          </Hint>
        )}
      </Section>
      {s.mode === "cmyk" && (
        <Section title="黑色与墨量">
          <SettingSwitch
            path="pureBlackToK"
            label="纯黑只用 K 版"
            hint="（小字不发虚）"
          />
          <SettingSwitch
            path="grayToK"
            label="灰色只用 K 版"
            hint="（灰字更干净）"
          />
          <SettingSwitch
            path="richBlackOn"
            label="大面积黑色用四色黑"
            hint="（≥1cm 色块，文字不受影响）"
          />
          {s.richBlackOn && (
            <>
              <SettingSelect
                path="richPreset"
                label="四色黑"
                options={[
                  ...Object.entries(RICH_PRESETS).map(
                    ([k, v]) => [k, v[0]] as const,
                  ),
                  ["custom", "自定义"],
                ]}
              />
              <div className="grid4">
                {channels.map((k) => (
                  <SettingNumber
                    key={k}
                    path={`richBlack.${k}`}
                    label={channelNames[k]}
                    min={0}
                    max={100}
                  />
                ))}
              </div>
            </>
          )}
          <SettingNumber
            path="tacLimit"
            label="总墨量上限"
            min={0}
            max={400}
            step={10}
            suffix="%"
          />
          <Hint>铜版纸常用 320，胶版纸 280–300，报纸 240；0 = 不限制。</Hint>
        </Section>
      )}
      <Section title="输出">
        {s.mode !== "rgb" && (
          <SettingSelect
            path="pdfx"
            label="PDF 标准"
            options={[
              ["x4", "PDF/X-4（推荐，支持透明）"],
              ["x1a", "PDF/X-1a（老设备、报纸常用）"],
              ["x3", "PDF/X-3"],
              ["none", "普通 PDF"],
            ]}
          />
        )}
        {(s.pdfx === "x1a" || s.pdfx === "x3") && s.mode !== "rgb" && (
          <>
            <SettingSelect
              path="flattenDpi"
              label="透明拼合精度"
              numeric
              options={[
                [300, "300 dpi"],
                [450, "450 dpi"],
                [600, "600 dpi（小字更清晰）"],
              ]}
            />
            <Hint>
              X-1a / X-3
              不允许透明。含阴影、半透明、混合模式的页面会整页转成图像，其余页面保持矢量。
            </Hint>
          </>
        )}
        <SettingSwitch path="minStrokeOn" label="细线自动加粗" />
        <SettingNumber
          path="minStrokePt"
          label="最细线条"
          min={0}
          max={2}
          step={0.05}
          suffix="pt"
        />
        {s.mode === "cmyk" && (
          <>
            <SettingSwitch
              path="overprintBlack"
              label="100% 黑色自动叠印"
              hint="（防止黑字周围露白）"
            />
            <SettingSwitch
              path="removeWhiteOverprint"
              label="去掉白色对象的叠印"
              hint="（否则白色会消失）"
            />
          </>
        )}
      </Section>
    </>
  );
}

const categoryNames: Record<string, string> = {
  geometry: "出血与版面",
  color: "颜色与墨量",
  resolution: "图片分辨率",
  transparency: "透明效果",
  text: "文字与字体",
  annotation: "注释",
  spot: "专色与刀版",
};
const levelNames = {
  error: "错误",
  warning: "风险",
  info: "提示",
  pass: "通过",
};
const levelTones = {
  error: "danger",
  warning: "warning",
  info: "info",
  pass: "success",
} as const;

function CheckView() {
  if (!S.frames.length) return <NoSelection what="在画布上选择要检查的画板" />;
  const n =
    currentIssues()?.filter((i) => i.level === "error" || i.level === "warning")
      .length || 0;
  const tabs: [CheckTab, string, number | undefined][] = [
    ["issues", "问题", n || undefined],
    ["preview", "印刷预览", undefined],
    ["colors", "颜色", S.colors?.length],
    ["text", "文字", S.texts?.length],
  ];
  return (
    <>
      <div className="view-heading">
        <h1>{tr("检查印刷质量")}</h1>
      </div>
      <Tabs value={S.checkTab} onValueChange={(v) => dispatchAction("ctab", v)}>
        <TabsList aria-label={tr("检查内容")}>
          {tabs.map(([v, l, count]) => (
            <TabsTrigger value={v} key={v}>
              {tr(l)}
              {count !== undefined && <span className="num"> {count}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="issues" className="check-panel">
          {S.checkTab === "issues" && <IssuesView />}
        </TabsContent>
        <TabsContent value="preview" className="check-panel">
          {S.checkTab === "preview" && <PreviewView />}
        </TabsContent>
        <TabsContent value="colors" className="check-panel">
          {S.checkTab === "colors" && <ColorsView />}
        </TabsContent>
        <TabsContent value="text" className="check-panel">
          {S.checkTab === "text" && <TextView />}
        </TabsContent>
      </Tabs>
    </>
  );
}
function IssuesView() {
  const s = S.settings,
    issues = currentIssues();
  if (!issues)
    return (
      <>
        <section className="quality">
          <Alert
            tone={S.checkError ? "danger" : "info"}
            title={tr(
              S.pendingIssuesKey === checkKey()
                ? "正在检查…"
                : S.checkError
                  ? "检查未完成，请重试"
                  : "需要更新检查结果",
            )}
          >
            {tr(S.checkError || "旧结果不再作为当前导出的依据。")}
          </Alert>
          {S.pendingIssuesKey === checkKey() ? (
            <Skeleton label={tr("正在检查…")} lines={4} />
          ) : (
            <Act act="preflight">重新检查</Act>
          )}
        </section>
        <CheckOptions />
      </>
    );
  const list = issues.filter((i) => i.level !== "pass");
  const err = list.filter((i) => i.level === "error").length,
    warn = list.filter((i) => i.level === "warning").length;
  const fixable = list.filter(
    (i) =>
      i.fix &&
      (i.fix.startsWith("k100:") ||
        i.fix === "removeWhiteOverprint" ||
        (i.fix === "autoBleed" && !s.autoBleed)),
  );
  const order: Record<string, number> = {
    error: 0,
    warning: 1,
    info: 2,
    pass: 3,
  };
  const risks = list.filter((i) => i.level !== "info");
  const notes = list.filter((i) => i.level === "info");
  return (
    <>
      <Section>
        <div className="section-title">
          <h2>
            {tr(
              err || warn
                ? `${err + warn} 项风险需要处理或确认`
                : "检查完成，未发现已知风险",
            )}
          </h2>
          <Act act="preflight" size="sm">
            重新检查
          </Act>
        </div>
        {!!fixable.length && (
          <div className="actions">
            <Act act="fix-all" size="sm">
              全部修复
            </Act>
            <span className="hint">{tr("仅调整导出设置")}</span>
          </div>
        )}
      </Section>
      {!!risks.length && (
        <div className="issue-list">
          {risks
            .sort((a, b) => order[a.level] - order[b.level])
            .map((i, n) => (
              <IssueCard
                key={`${i.cat}:${i.nodeId || ""}:${i.fix || ""}:${n}`}
                issue={i}
              />
            ))}
        </div>
      )}
      <CheckOptions notes={notes} />
    </>
  );
}
function IssueCard({ issue: i }: { issue: Issue }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const image =
    i.fix === "upscale" ? S.images.find((im) => im.id === i.nodeId) : undefined;
  // Summarise only known cases from structured data. Other findings keep their full message.
  const summary =
    i.fix === "icc"
      ? "没有选择 ICC，颜色仅能近似换算。"
      : i.fix === "autoBleed"
        ? "没有出血"
        : image
          ? `${image.name} · ${image.ppi} ppi，要求 ≥ ${S.settings.minPpi} ppi`
          : i.msg;
  const hasDetails = summary !== i.msg;
  return (
    <article className="issue-card">
      <div className="section-title">
        <div className="issue-heading">
          <h2>{tr(categoryNames[i.cat] || "提示")}</h2>
          {i.frame && (hasDetails || !i.msg.includes(i.frame)) && (
            <span className="hint wrap">{i.frame}</span>
          )}
        </div>
        <Badge tone={levelTones[i.level]}>{tr(levelNames[i.level])}</Badge>
      </div>
      <p className="msg">{tr(summary)}</p>
      {i.fix === "upscale" && <Hint>会修改原稿；放大不会增加细节。</Hint>}
      <div className="issue-actions">
        <FixButton issue={i} />
        {i.nodeId && (
          <Act act="select" v={i.nodeId} variant="ghost" size="sm">
            在画布上定位
          </Act>
        )}
        {hasDetails && (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsOpen(!detailsOpen)}
          >
            {tr(detailsOpen ? "收起" : "详细说明")}
          </Button>
        )}
      </div>
      {hasDetails && (
        <p id={detailsId} className="msg" hidden={!detailsOpen}>
          {tr(i.msg)}
        </p>
      )}
    </article>
  );
}
function CheckOptions({ notes = [] }: { notes?: Issue[] }) {
  const options = [
    {
      kind: "scope",
      title: tr("检查范围与图片"),
      content: (
        <div id="check-images" className="disclosure-content">
          {S.passOpen && (
            <>
              <Hint>出血、版面、图片、文字及部分颜色问题</Hint>
              <Hint>检查是最近一次快照，改稿后请重新检查。</Hint>
              <Hint>出血和颜色修复只影响导出；图片操作会修改原稿。</Hint>
              <Hint>检查有范围，送印前请核对印刷厂要求。</Hint>
              {S.images.map((im) => (
                <div className="image-row" key={im.id}>
                  <Act
                    act="select"
                    v={im.id}
                    variant="ghost"
                    size="sm"
                    title={im.name}
                  >
                    <span className="wrap image-name">{im.name}</span>
                  </Act>
                  <span className="mono">{im.px}</span>
                  <Badge
                    tone={im.ppi >= S.settings.minPpi ? "success" : "warning"}
                  >
                    {im.ppi} ppi
                  </Badge>
                </div>
              ))}
            </>
          )}
        </div>
      ),
    },
    {
      kind: "standards",
      title: tr("检查标准"),
      content: <>{S.stdOpen && <CheckStandards />}</>,
    },
  ];
  if (notes.length)
    options.unshift({
      kind: "notes",
      title: tr(`${notes.length} 个提示`),
      content: (
        <div className="issue-list">
          {notes.map((i, n) => (
            <IssueCard key={`${i.cat}:${i.nodeId || ""}:${n}`} issue={i} />
          ))}
        </div>
      ),
    });
  return (
    <div
      onClick={(e) => {
        const triggers = [
          ...e.currentTarget.querySelectorAll(
            ":scope > div > div > h3 > button",
          ),
        ];
        const idx = triggers.indexOf((e.target as Element).closest("button")!);
        if (idx < 0) return;
        if (options[idx].kind === "standards") {
          S.passOpen = false;
          dispatchAction("std-open");
        } else if (options[idx].kind === "scope") {
          S.stdOpen = false;
          dispatchAction("pass-open");
        } else {
          S.stdOpen = S.passOpen = false;
          render();
        }
      }}
    >
      <Accordion
        key={notes.length ? "with-notes" : "without-notes"}
        defaultOpen={
          S.stdOpen ? options.length - 1 : S.passOpen ? options.length - 2 : -1
        }
        items={options}
      />
    </div>
  );
}
function CheckStandards() {
  const s = S.settings;
  return (
    <div id="check-standards" className="disclosure-content">
      <Hint>{`检查标准：图片 ≥ ${s.minPpi} ppi · 线条 ≥ ${s.minStrokePt} pt · 字号 ≥ ${s.minTextPt} pt`}</Hint>
      <SettingNumber
        path="minPpi"
        label="最低分辨率"
        min={72}
        max={600}
        step={10}
        suffix="ppi"
      />
      <SettingNumber
        path="minStrokePt"
        label="最细线条"
        min={0}
        max={2}
        step={0.05}
        suffix="pt"
      />
      <SettingNumber
        path="minTextPt"
        label="最小字号"
        min={3}
        max={12}
        step={0.5}
        suffix="pt"
      />
      <SettingSwitch
        path="blockLowPpi"
        label="有图片低于最低分辨率时，禁止导出"
      />
      <div>
        <Act act="preflight" size="sm">
          按新标准重新检查
        </Act>
      </div>
    </div>
  );
}
function FixButton({ issue: i }: { issue: Issue }) {
  if (!i.fix) return null;
  if (i.fix === "icc")
    return (
      <Act act="sheet" v="profile" size="sm">
        选择颜色配置
      </Act>
    );
  if (i.fix.startsWith("k100:"))
    return (
      <Act act="fix-k100" v={i.fix.slice(5)} size="sm">
        改为单色黑
      </Act>
    );
  if (i.fix === "upscale" && i.nodeId)
    return (
      <>
        <Act act="upscale" v={i.nodeId} size="sm">
          放大 2 倍
        </Act>
        <Act act="replace-image" v={i.nodeId} variant="ghost" size="sm">
          替换图片
        </Act>
      </>
    );
  if (i.fix === "autoBleed")
    return S.settings.autoBleed ? (
      <span className="hint">{tr("导出时自动延伸")}</span>
    ) : (
      <Act act="tg" data-path="autoBleed" size="sm">
        导出时自动加出血
      </Act>
    );
  if (i.fix === "removeWhiteOverprint")
    return (
      <Act act="fix-white" size="sm">
        去掉叠印
      </Act>
    );
  return null;
}
function PreviewCanvas() {
  // Painting needs the committed canvas, not an imperative write during React render.
  useLayoutEffect(() => {
    paintPreview();
  });
  return <canvas id="pv-canvas" role="img" aria-label={tr("印刷预览")} />;
}
function PreviewSplit() {
  const value = Math.round((S.preview?.split ?? 0.5) * 100);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Slider
      label={tr("对比")}
      value={draft}
      min={0}
      max={100}
      onValueChange={(v: number) => {
        setDraft(v);
        if (S.preview) {
          S.preview.split = v / 100;
          paintPreview();
        }
      }}
    />
  );
}
function PreviewView() {
  const p = S.preview,
    frames = orderedFrames(),
    idx = Math.min(S.previewIdx, frames.length - 1);
  if (!p || p.id !== frames[idx]?.id) return <Loading label="正在生成预览…" />;
  const st = p.data?.stats;
  return (
    <>
      <Seg
        label="印刷预览"
        value={p.mode}
        options={[
          ["split", "对比"],
          ["proof", "印刷效果"],
          ["original", "原稿"],
        ]}
        onValueChange={(v) => dispatchAction("pv-mode", v)}
      />
      <Seg
        label="分色"
        value={p.mode}
        options={[
          ["c", "C"],
          ["m", "M"],
          ["y", "Y"],
          ["k", "K"],
          ["tac", "墨量"],
          ["gamut", "超色域"],
        ]}
        onValueChange={(v) => dispatchAction("pv-mode", v)}
      />
      <div className="pv">
        {p.mode === "split" && (
          <div className="line hint">
            <span>{tr("原稿")}</span>
            <span>{tr("印出来的样子")}</span>
          </div>
        )}
        <PreviewCanvas />
        <div className="pager">
          <Act
            act="pv-page"
            v="-1"
            variant="ghost"
            disabled={idx <= 0}
            aria-label={tr("前移")}
          >
            <ArrowLeft aria-hidden size={16} />
          </Act>
          <span className="num">
            {idx + 1} / {frames.length}
          </span>
          <Act
            act="pv-page"
            v="1"
            variant="ghost"
            disabled={idx >= frames.length - 1}
            aria-label={tr("后移")}
          >
            <ArrowRight aria-hidden size={16} />
          </Act>
        </div>
      </div>
      {p.mode === "split" && <PreviewSplit />}
      {st && (
        <dl className="stats">
          <div>
            <dt>{tr("最大墨量")}</dt>
            <dd>
              <Badge
                tone={st.tacMax > S.settings.tacLimit ? "danger" : "neutral"}
              >
                {st.tacMax}%
              </Badge>
            </dd>
          </div>
          <div>
            <dt>{tr("超墨量面积")}</dt>
            <dd>
              <Badge tone={st.tacOver > 0 ? "warning" : "neutral"}>
                {(st.tacOver * 100).toFixed(1)}%
              </Badge>
            </dd>
          </div>
          <div>
            <dt>{tr("超色域面积")}</dt>
            <dd>
              <Badge tone={st.gamutOut > 0.02 ? "warning" : "neutral"}>
                {(st.gamutOut * 100).toFixed(1)}%
              </Badge>
            </dd>
          </div>
        </dl>
      )}
      <Switch
        label={tr("模拟纸张白")}
        checked={p.paper}
        onCheckedChange={() => dispatchAction("pv-paper", "")}
      />
      <Hint>纸张略偏暖，白色不是纯白</Hint>
      {S.settings.mode !== "cmyk" && (
        <Hint>{`当前印刷方案是 ${S.settings.mode === "rgb" ? "RGB" : "灰度"}，印刷模拟仅在 CMYK 下有意义。`}</Hint>
      )}
      <Hint>
        “墨量”里红色区域超过总墨量上限（导出时会自动压到上限）；“超色域”里标出的区域印刷时会明显变灰、变暗。
      </Hint>
    </>
  );
}

function ColorsView() {
  const s = S.settings;
  if (s.mode !== "cmyk")
    return (
      <EmptyState
        title={tr(
          `当前印刷方案是 ${s.mode === "rgb" ? "RGB" : "灰度"}，颜色映射、专色和总墨量只在 CMYK 下生效。`,
        )}
        description={tr("更换印刷方案")}
        action={
          <Act act="sheet" v="profile">
            更换印刷方案
          </Act>
        }
      />
    );
  if (!S.colors) return <Loading label="正在扫描颜色…" />;
  const open = S.colors.find((c) => c.hex === S.expanded);
  const options = S.colors.map((c) => {
    const { c: cm, kind } = cmykFor(c.hex),
      ov = s.overrides[c.hex];
    const proof = engine && kind !== "finish" ? engine.proofHex(cm) : c.hex;
    const [r, g, b] = hexToRgb(c.hex),
      de = engine && kind === "icc" ? engine.gamutDeltaE(r, g, b, cm) : 0;
    const value =
      kind === "finish"
        ? s.colorFinishing[c.hex]
        : kind === "spot"
          ? ov!.spot!.name
          : channels.map((k) => Math.round(cm[k])).join(" ");
    let label = "",
      tone: "neutral" | "info" | "success" | "warning" = "neutral";
    if (kind === "finish") {
      label = "工艺";
      tone = "info";
    } else if (kind === "spot") {
      label = `专色${ov?.overprint ? " · 叠印" : ""}`;
      tone = "info";
    } else if (kind === "custom")
      label = `自定义${ov?.overprint ? " · 叠印" : ""}`;
    else if (de > 10) {
      label = "超色域";
      tone = "warning";
    } else if (cm.c === 0 && cm.m === 0 && cm.y === 0 && cm.k > 0) {
      label = cm.k >= 99.5 ? "单色黑" : "只用 K";
      tone = "success";
    } else if (s.tacLimit && tac(cm) > s.tacLimit + 0.5) {
      label = `墨量 ${Math.round(tac(cm))}%`;
      tone = "warning";
    } else if (ov?.overprint) label = "叠印";
    return {
      value: c.hex,
      label: <span className="mono">{c.hex}</span>,
      description: (
        <span className="wrap">
          {c.names?.[0]}
          <span className="mono"> {value}</span>
        </span>
      ),
      icon: (
        <span className="sw2">
          <i style={{ background: c.hex }} title={tr("设计稿颜色")} />
          <i style={{ background: proof }} title={tr("印刷效果预览")} />
        </span>
      ),
      meta: (
        <span className="color-meta">
          {label && <Badge tone={tone}>{tr(label)}</Badge>}
          <span className="num">×{c.count}</span>
        </span>
      ),
    };
  });
  return (
    <>
      <div className="line">
        <Hint>{`${S.colors.length} 种颜色，默认按印刷方案自动转换，点开可单独调整`}</Hint>
        <Act act="scan-colors">重新扫描</Act>
      </div>
      {S.colors.length ? (
        <RadioCards
          className="color-list"
          aria-label={tr("颜色")}
          layout="list"
          value={S.expanded || null}
          options={options}
          onValueChange={(v) => dispatchAction("expand", v)}
        />
      ) : (
        <EmptyState
          title={tr("没有找到颜色")}
          description={tr("在画布上选择要检查的画板")}
          action={<Act act="scan-colors">重新扫描</Act>}
        />
      )}
      {open && (
        <Section title={open.hex} className="cedit">
          <ColorEditor color={open} />
          <div>
            <Act act="expand" v={open.hex} variant="ghost">
              收起
            </Act>
          </div>
        </Section>
      )}
      <Act act="sheet" v="resources" variant="ghost" className="settings-link">
        色板与颜色映射
      </Act>
    </>
  );
}
/** Keep continuous edits local; expensive colour-engine rebuilds happen once on release. */
function CommitSlider({
  label,
  value,
  min = 0,
  commit,
}: {
  label: string;
  value: number;
  min?: number;
  commit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Slider
      label={tr(label)}
      value={draft}
      min={min}
      max={100}
      step={1}
      format={(v) => `${v}%`}
      onValueChange={(v: number) => setDraft(v)}
      onValueCommit={(v: number) => commit(v)}
    />
  );
}
function ChannelEditor({ hex, value }: { hex: string; value: CMYK }) {
  return (
    <div className="channel-editor">
      {channels.map((k) => (
        <div className="channel-row" key={k}>
          <CommitSlider
            label={channelNames[k]}
            value={value[k]}
            commit={(v) => changeValue({ act: "cmyk", hex, k }, v)}
          />
          <SpecialInput
            target={{ id: `color-${hex}-${k}`, act: "cmyk", hex, k }}
            label={`${channelNames[k]} (%)`}
            value={Math.round(value[k])}
            type="number"
            min={0}
            max={100}
            step={1}
          />
        </div>
      ))}
    </div>
  );
}
function ColorEditor({ color: c }: { color: ScannedColor }) {
  const s = S.settings,
    ov = s.overrides[c.hex];
  const kind = s.colorFinishing[c.hex]
    ? "finish"
    : ov?.spot
      ? "spot"
      : ov?.cmyk
        ? "custom"
        : "icc";
  const [r, g, b] = hexToRgb(c.hex),
    icc = engine ? engine.iccCmyk(r, g, b) : { c: 0, m: 0, y: 0, k: 0 };
  const de = engine ? engine.gamutDeltaE(r, g, b, icc) : 0;
  return (
    <div className="section" data-stop="1">
      <Seg
        label="颜色"
        value={kind}
        options={[
          ["icc", "按方案"],
          ["custom", "自定义 CMYK"],
          ["spot", "专色"],
          ["finish", "刀线 / 工艺"],
        ]}
        onValueChange={(v) => dispatchAction("ckind", v, { hex: c.hex })}
      />
      {kind === "icc" && (
        <Hint>
          <span>{tr("按方案换算")} </span>
          <span className="mono">
            {fmtC(icc)} · TAC {Math.round(tac(icc))}% · ΔE {de.toFixed(1)}{" "}
          </span>
          <span>
            {tr(
              de > 10 ? "超出印刷色域，会偏灰" : de > 5 ? "略有偏差" : "准确",
            )}
          </span>
          {c.inGradient && <span> {tr("这个颜色用在渐变里。")}</span>}
        </Hint>
      )}
      {kind === "custom" && ov?.cmyk && (
        <ChannelEditor hex={c.hex} value={ov.cmyk} />
      )}
      {kind === "spot" && ov?.spot && (
        <>
          <SpecialInput
            target={{ id: `spot-${c.hex}`, act: "spotname", hex: c.hex }}
            label="专色名称"
            value={ov.spot.name}
            placeholder="例如 PANTONE 186 C"
          />
          {!!S.lib.length && (
            <>
              <Combobox
                label={tr("色板库")}
                value={
                  S.lib.some((l) => l.name === ov.spot!.name)
                    ? ov.spot.name
                    : ""
                }
                options={S.lib
                  .slice(0, 3000)
                  .map((l) => ({ value: l.name, label: l.name }))}
                onValueChange={(v) => {
                  if (v) changeValue({ act: "spotname", hex: c.hex }, v);
                }}
                placeholder={tr("专色名称")}
                emptyMessage={tr("没有找到颜色")}
              />
              <div>
                <Act act="nearest-spot" data-hex={c.hex}>
                  找最接近的
                </Act>
              </div>
            </>
          )}
          <CommitSlider
            label="浓度"
            value={ov.spot.tint}
            min={1}
            commit={(v) => changeValue({ act: "tint", hex: c.hex }, v)}
          />
          <Hint>专色的 CMYK 替代值（屏幕预览和“转为四色”时使用）：</Hint>
          <ChannelEditor hex={c.hex} value={ov.spot.alt} />
          {c.inGradient && (
            <Alert
              tone="warning"
              title={tr(
                "注意：渐变里的专色无法单独成版，会按 CMYK 替代值输出。",
              )}
            />
          )}
        </>
      )}
      {kind === "finish" && (
        <>
          <Choice
            label="工艺版"
            value={s.colorFinishing[c.hex]}
            options={DIELINE_KEYWORDS.map((d) => [d.spot, d.spot] as const)}
            onValueChange={(v) =>
              changeValue({ act: "finish-name", hex: c.hex }, v)
            }
          />
          <Hint>
            用这个颜色的描边会输出成单线刀线 /
            折线（叠印），填充会输出成对应的工艺专色版（光油、白墨、烫金等），不会印成颜色。
          </Hint>
        </>
      )}
      {kind !== "finish" && (
        <Switch
          label={tr("叠印")}
          checked={!!ov?.overprint}
          onCheckedChange={(v) =>
            changeValue({ act: "overprint", hex: c.hex }, v)
          }
        />
      )}
      {(ov || kind === "finish") && (
        <div>
          <Act act="reset-color" data-hex={c.hex} variant="ghost">
            恢复默认
          </Act>
        </div>
      )}
    </div>
  );
}

function DraftName({ value }: { value: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      id="map-name"
      label={tr("名称")}
      placeholder={tr("映射表名称，例如：品牌色 2026")}
      value={draft}
      onChange={(e) => {
        e.stopPropagation();
        setDraft(e.target.value);
      }}
    />
  );
}
function ResourcesView() {
  const s = S.settings,
    current = allMaps().find((m) => m.name === s.activeMap);
  const dirty =
    s.activeMap &&
    JSON.stringify(current?.overrides || {}) !== JSON.stringify(s.overrides);
  return (
    <>
      <SheetHead title="色板与颜色映射" />
      <Section title="颜色映射表">
        {s.activeMap && (
          <p className="hint wrap">
            {s.activeMap}
            {dirty && <> {tr("（未保存）")}</>}
          </p>
        )}
        <Choice
          id="map-select"
          label="应用"
          value={s.activeMap}
          translate={false}
          searchable
          options={[
            ["", tr("— 不使用 —")],
            ...allMaps().map(
              (m) =>
                [m.name, `${m.name}${m.file ? tr("（本文件）") : ""}`] as const,
            ),
          ]}
          onValueChange={(v) => changeValue({ act: "load-map" }, v)}
        />
        {s.activeMap && (
          <div>
            <Act act="del-map" variant="ghost">
              删除
            </Act>
          </div>
        )}
        <DraftName value={s.activeMap} />
        <div>
          <Act act="save-map">保存</Act>
        </div>
        <SettingSwitch
          path="mapsInFile"
          label="保存到当前 Figma 文件"
          hint="（团队成员打开同一文件都能用）"
        />
      </Section>
      <Section title="色板库">
        <Hint>
          {S.lib.length
            ? `已导入 ${S.lib.length} 个色板`
            : "可导入潘通 / RAL / HKS 色板（.ase 或 CSV）"}
        </Hint>
        <div className="actions">
          <Act act="import-lib">导入</Act>
          {!!S.lib.length && (
            <Act act="clear-lib" variant="ghost">
              清空
            </Act>
          )}
        </div>
      </Section>
    </>
  );
}
function TextView() {
  const s = S.settings,
    text = S.texts;
  if (!text) return <Loading label="正在扫描文字…" />;
  const def =
    s.textOutline === "none"
      ? "none"
      : s.textOutline === "all"
        ? "all"
        : "perNode";
  const missing = text.filter((n) => n.missingFont).length;
  const sorted = [...text].sort(
    (a, b) =>
      +(b.missingFont || b.hasEffects) - +(a.missingFont || a.hasEffects),
  );
  return (
    <>
      <Section>
        <Seg
          label="导出时文字怎么处理"
          value={def}
          options={[
            ["none", "全部保留文字"],
            ["perNode", "按图层设置"],
            ["all", "全部转曲"],
          ]}
          onValueChange={(v) => dispatchAction("tdefault", v)}
        />
        <Hint>
          保留文字：PDF
          里能选中、搜索（含中文）。转曲：变成图形，任何印刷机都不会缺字体。
        </Hint>
        {def === "perNode" && <Hint>下面可以逐个图层设置。</Hint>}
        {def === "perNode" && !!text.length && (
          <div>
            <Act act="tall" v="live-noeff" variant="ghost">
              有效果的转曲，其余保留
            </Act>
          </div>
        )}
      </Section>
      {!!missing && (
        <Alert
          tone="warning"
          title={tr(
            `有 ${missing} 个文字图层缺少字体，请先在 Figma 中安装或替换字体，否则导出的字形会被替换。`,
          )}
        />
      )}
      {text.length ? (
        <div className="text-list">
          {sorted.map((n) => {
            const mode =
              def === "perNode" ? n.mode : def === "all" ? "outline" : "live";
            return (
              <article className="text-row" key={n.id}>
                <Act
                  act="select"
                  v={n.id}
                  variant="ghost"
                  title={n.preview || n.name}
                >
                  <span className="text-copy wrap">
                    <span>{n.preview || n.name}</span>
                    <span className="hint">
                      {n.fonts.join("、")} · {n.size} pt · {n.frame}
                    </span>
                  </span>
                </Act>
                {n.missingFont ? (
                  <Badge tone="danger">{tr("缺字体")}</Badge>
                ) : n.hasEffects ? (
                  <Badge tone="warning">{tr("有效果")}</Badge>
                ) : null}
                <Seg
                  label="文字"
                  value={mode}
                  options={[
                    ["live", "文字"],
                    ["outline", "转曲"],
                  ]}
                  onValueChange={(v) => dispatchAction("tmode", n.id, { m: v })}
                />
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          title={tr("没有文字图层")}
          description={tr("在画布上选择要检查的画板")}
          action={<Act act="scan-text">重新扫描</Act>}
        />
      )}
    </>
  );
}

function MeasureTool() {
  const measure = S.measure;
  return (
    <>
      <SettingSwitch path="keepRatio" label="改宽高时保持比例" />
      {measure.length ? (
        measure.slice(0, 4).map((n) => (
          <article className="measure-node" key={n.id}>
            <div className="line">
              <span className="wrap grow">{n.name}</span>
              <span className="hint">{n.type}</span>
            </div>
            <div className="grid2">
              <MeasureField
                label="宽"
                k="w"
                nodeId={n.id}
                value={toUnit((n.w * 25.4) / 72)}
                unit={S.settings.unit}
              />
              <MeasureField
                label="高"
                k="h"
                nodeId={n.id}
                value={toUnit((n.h * 25.4) / 72)}
                unit={S.settings.unit}
              />
              {n.fontSize !== undefined && (
                <MeasureField
                  label="字号"
                  k="fontSize"
                  nodeId={n.id}
                  value={n.fontSize}
                  unit="pt"
                />
              )}
              {n.strokeWeight !== undefined && (
                <MeasureField
                  label="描边"
                  k="strokeWeight"
                  nodeId={n.id}
                  value={n.strokeWeight}
                  unit="pt"
                />
              )}
              {n.cornerRadius !== undefined && (
                <MeasureField
                  label="圆角"
                  k="cornerRadius"
                  nodeId={n.id}
                  value={toUnit((n.cornerRadius * 25.4) / 72)}
                  unit={S.settings.unit}
                />
              )}
            </div>
          </article>
        ))
      ) : (
        <Hint>在画布上选中任意图层，这里会显示它的实际尺寸，可以直接改。</Hint>
      )}
    </>
  );
}
function MeasureField({
  label,
  k,
  nodeId,
  value,
  unit,
}: {
  label: string;
  k: string;
  nodeId: string;
  value: number;
  unit: string;
}) {
  return (
    <SpecialInput
      target={{ id: `measure-${nodeId}-${k}`, act: "mz", nodeId, k }}
      label={`${tr(label)} (${unit})`}
      value={value}
      type="number"
      step="any"
    />
  );
}
function PickTool() {
  const hex = engine
    ? engine.proofHex(S.settings.pick)
    : "var(--surface-muted)";
  return (
    <>
      <span
        className="pick-swatch"
        style={{ background: hex }}
        role="img"
        aria-label={tr("印刷效果预览")}
      />
      <div className="grid4">
        {channels.map((k) => (
          <SettingNumber
            key={k}
            path={`pick.${k}`}
            label={channelNames[k]}
            min={0}
            max={100}
          />
        ))}
      </div>
      <div className="actions">
        <Act act="pick-apply" v="fill">
          填充所选
        </Act>
        <Act act="pick-apply" v="stroke">
          描边所选
        </Act>
      </div>
      <Hint>导出时按这组 CMYK 精确输出</Hint>
    </>
  );
}
function LabelTool() {
  return (
    <>
      <div className="switches">
        {[
          ["hex", "HEX"],
          ["rgb", "RGB"],
          ["cmyk", "CMYK"],
          ["spot", "专色名"],
          ["names", "样式名"],
        ].map(([k, label]) => (
          <SettingSwitch key={k} path={`label.${k}`} label={label} />
        ))}
      </div>
      <div>
        <Act act="labels">为所选色块生成标注</Act>
      </div>
      <Hint>重复运行会更新，不会重叠</Hint>
    </>
  );
}
function PageNumberTool() {
  return (
    <>
      <SettingSelect
        path="pageNum.format"
        label="格式"
        translate={false}
        options={[
          ["{n}", "1"],
          ["{n} / {total}", "1 / 12"],
          ["- {n} -", "- 1 -"],
          ["P{n}", "P1"],
          ["Page {n}", "Page 1"],
          ["第 {n} 页", "第 1 页"],
          ["{n} ページ", "1 ページ"],
          ["{n} 페이지", "1 페이지"],
          ["Página {n}", "Página 1"],
          ["Seite {n}", "Seite 1"],
        ]}
      />
      <div className="grid2">
        <SettingNumber path="pageNum.start" label="起始数字" min={0} />
        <SettingNumber path="pageNum.skip" label="跳过前几页（封面）" min={0} />
      </div>
      <SettingSeg
        path="pageNum.position"
        label="位置"
        options={[
          ["outer", "外侧角"],
          ["center", "底部居中"],
        ]}
      />
      <SettingSwitch
        path="pageNum.create"
        label="没有名为「页码」的文字图层时自动添加"
      />
      <div>
        <Act act="page-numbers">按导出页顺序编页码</Act>
      </div>
    </>
  );
}
function ImageTool() {
  const imgs = S.measure.filter((n) => n.hasImage);
  return imgs.length ? (
    <>
      <Hint>替换或放大图片会修改原稿；放大不会补回缺失的细节。</Hint>
      {imgs.map((n) => (
        <div className="image-tool-row" key={n.id}>
          <span className="wrap">{n.name}</span>
          <div className="actions">
            <Act act="replace-image" v={n.id}>
              替换图片
            </Act>
            <Act act="upscale" v={n.id}>
              放大 2 倍
            </Act>
          </div>
        </div>
      ))}
    </>
  ) : (
    <Hint>先在画布上选中带图片的图层。</Hint>
  );
}
function RescaleTool() {
  const [dpi, setDpi] = useState(300);
  return (
    <>
      <Hint>
        例如 A4 做成 2480×3508 像素的画板，缩回 210×297 mm，图片清晰度不变。
      </Hint>
      <Seg
        label="原来按"
        value={dpi}
        options={[
          [300, "300"],
          [150, "150"],
          [200, "200"],
          [350, "350"],
          [600, "600"],
        ]}
        onValueChange={(v) => setDpi(Number(v))}
      />
      <Input
        id="rescale-dpi"
        label={`${tr("原来按")} (DPI)`}
        type="number"
        value={dpi}
        onChange={(e) => {
          e.stopPropagation();
          if (e.target.value !== "" && Number.isFinite(e.target.valueAsNumber))
            setDpi(e.target.valueAsNumber);
        }}
        min={1}
      />
      <div>
        <Act act="rescale">缩回实际尺寸</Act>
      </div>
    </>
  );
}
function BoxTool() {
  return (
    <>
      <SettingSeg
        path="box.style"
        label="盒型"
        options={[
          ["ste", "插舌盒"],
          ["tray", "托盘盒"],
          ["mailer", "飞机盒"],
        ]}
      />
      <div className="grid3">
        <SettingNumber path="box.w" label="长" min={10} suffix="mm" />
        <SettingNumber path="box.d" label="宽" min={10} suffix="mm" />
        <SettingNumber path="box.h" label="高" min={5} suffix="mm" />
      </div>
      <Hint>
        内尺寸。生成后刀线为实线、折线为虚线，图层名已按规则命名，导出时自动输出为刀版专色。
      </Hint>
      <div>
        <Act act="box">生成刀版</Act>
      </div>
    </>
  );
}
function ToolsView() {
  const tools = [
    {
      id: "measure",
      title: "实物尺寸",
      desc: "宽高、字号、描边和圆角",
      body: <MeasureTool />,
    },
    {
      id: "pick",
      title: "按 CMYK 数值上色",
      desc: "输入印刷厂给的色值，填充或描边所选",
      body: <PickTool />,
    },
    {
      id: "labels",
      title: "色卡标注",
      desc: "在色块旁写上 HEX / RGB / CMYK / 专色名",
      body: <LabelTool />,
    },
    {
      id: "pagenum",
      title: "页码",
      desc: "按导出顺序自动编号，奇偶页左右对称",
      body: <PageNumberTool />,
    },
    {
      id: "image",
      title: "替换 / 放大图片",
      desc: "换图保留裁切；低清图放大 2 倍",
      body: <ImageTool />,
    },
    {
      id: "rescale",
      title: "缩回实际尺寸",
      desc: "按 300 DPI 像素做的画板，一键换算成实际尺寸",
      body: <RescaleTool />,
    },
    {
      id: "box",
      title: "纸盒刀版生成",
      desc: "插舌盒 · 托盘盒 · 飞机盒，输入长宽高即可",
      body: <BoxTool />,
    },
  ];
  return (
    <>
      <SheetHead title="画布工具" />
      <SettingSeg path="unit" label="单位" options={units} />
      <Hint>直接修改画布上的图层</Hint>
      <div
        className="tools"
        onClick={(e) => {
          const trigger = (e.target as Element).closest(
            "button[aria-expanded]",
          );
          if (!trigger || !e.currentTarget.contains(trigger)) return;
          // Restrict to the Accordion's own headers, never a combobox or select in its content.
          const triggers = [
            ...e.currentTarget.querySelectorAll(
              ":scope > div > div > h3 > button",
            ),
          ];
          const idx = triggers.indexOf(trigger);
          if (idx >= 0) dispatchAction("tool", tools[idx].id);
        }}
      >
        <Accordion
          defaultOpen={tools.findIndex((t) => t.id === S.toolOpen)}
          items={tools.map((t) => ({
            title: tr(t.title),
            content: (
              <div id={`tool-${t.id}`} className="tool-content">
                <Hint>{t.desc}</Hint>
                {S.toolOpen === t.id ? t.body : null}
              </div>
            ),
          }))}
        />
      </div>
      <input
        type="file"
        id="file-image"
        accept="image/png,image/jpeg,image/webp"
        hidden
      />
    </>
  );
}
