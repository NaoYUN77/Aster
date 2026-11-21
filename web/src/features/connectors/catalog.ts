import gmailIcon from "@/assets/connectors/gmail.svg";
import githubIcon from "@/assets/connectors/github.svg";
import googleCalendarIcon from "@/assets/connectors/google-calendar.svg";
import googleDriveIcon from "@/assets/connectors/google-drive.svg";
import linearIcon from "@/assets/connectors/linear.svg";
import notionIcon from "@/assets/connectors/notion.svg";
import outlookIcon from "@/assets/connectors/outlook.svg";
import type { Connector, ConnectorId } from "@/api/connectors";

/** 本地静态品牌图标，不热链第三方资源。 */
export type ConnectorMeta = {
  id: ConnectorId;
  name: string;
  icon: string;
  tagline: string;
  description: string;
  /** 面向用户的权限说明；服务端返回 scopes 时优先展示服务端结果。 */
  permissions: string[];
};

export const CONNECTOR_CATALOG: ConnectorMeta[] = [
  {
    id: "github",
    name: "GitHub",
    icon: githubIcon,
    tagline: "仓库、Issue 与 Pull Request",
    description:
      "可读取仓库、Issue 与 Pull Request，也可创建 Issue 与评论。",
    permissions: ["读取仓库与代码", "读取 Issue / Pull Request", "创建 Issue 与评论"],
  },
  {
    id: "gmail",
    name: "Gmail",
    icon: gmailIcon,
    tagline: "邮件检索与发送",
    description: "支持邮件检索与发送，不会删除邮件。",
    permissions: ["搜索与读取邮件", "发送邮件"],
  },
  {
    id: "outlook",
    name: "Outlook",
    icon: outlookIcon,
    tagline: "邮件检索、发送与回复",
    description: "支持邮件检索、发送与回复，不会删除邮件。",
    permissions: ["搜索与读取邮件", "发送与回复邮件"],
  },
  {
    id: "linear",
    name: "Linear",
    icon: linearIcon,
    tagline: "Issue 读取与创建",
    description: "支持 Issue 读取、创建与更新，不会删除 Issue。",
    permissions: ["读取团队与 Issue", "创建与更新 Issue"],
  },
  {
    id: "notion",
    name: "Notion",
    icon: notionIcon,
    tagline: "页面与数据库读写",
    description: "支持页面与数据库的读取与写入，不会删除内容。",
    permissions: ["搜索页面/数据库", "读取与写入页面内容"],
  },
  {
    id: "google_calendar",
    name: "Google Calendar",
    icon: googleCalendarIcon,
    tagline: "日程读取与创建",
    description: "支持日程读取与创建，不会删除日程。",
    permissions: ["读取日历与事件", "创建日程"],
  },
  {
    id: "google_drive",
    name: "Google Drive",
    icon: googleDriveIcon,
    tagline: "文件检索与读写",
    description:
      "支持文件检索与读写（仅限 Aster 创建或打开的文件），不会删除文件。",
    permissions: ["搜索文件", "读取与写入 Google 文档"],
  },
];

export function connectorMeta(id: string): ConnectorMeta | null {
  return CONNECTOR_CATALOG.find((meta) => meta.id === id) ?? null;
}

export function connectorName(id: string): string {
  return connectorMeta(id)?.name ?? id;
}

/** 服务端还没返回某个 Connector 时的占位状态（服务端状态始终优先）。 */
export function disconnectedConnector(meta: ConnectorMeta): Connector {
  return {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    status: "disconnected",
    account: null,
    scopes: [],
    connectedAt: null,
    lastError: null,
  };
}

/** 固定展示七个 provider；未知 id 忽略，缺失的用占位状态补齐。 */
export function mergeCatalog(connectors: Connector[]): Connector[] {
  return CONNECTOR_CATALOG.map((meta) => {
    const remote = connectors.find((connector) => connector.id === meta.id);
    if (!remote) return disconnectedConnector(meta);
    return {
      ...disconnectedConnector(meta),
      ...remote,
      name: remote.name || meta.name,
      description: remote.description || meta.description,
      scopes: Array.isArray(remote.scopes) ? remote.scopes : [],
      account: remote.account ?? null,
    };
  });
}
