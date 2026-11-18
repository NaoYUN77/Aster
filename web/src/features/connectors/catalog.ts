import gmailIcon from "@/assets/connectors/gmail.svg";
import githubIcon from "@/assets/connectors/github.svg";
import linearIcon from "@/assets/connectors/linear.svg";
import outlookIcon from "@/assets/connectors/outlook.svg";
import type { Connector, ConnectorId } from "@/api/connectors";

/** 本地静态品牌图标，不热链第三方资源。 */
export type ConnectorMeta = {
  id: ConnectorId;
  name: string;
  icon: string;
  tagline: string;
  description: string;
  readOnly: boolean;
  /** 只读连接器的说明文案；可写连接器为 null。 */
  readOnlyNotice: string | null;
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
      "授权后 Aster 可以读取你账号下的仓库信息，用于代码检索、Issue 与 Pull Request 相关工具。",
    readOnly: false,
    readOnlyNotice: null,
    permissions: ["读取仓库与代码", "读取 Issue / Pull Request", "以你的身份创建评论或提交"],
  },
  {
    id: "gmail",
    name: "Gmail",
    icon: gmailIcon,
    tagline: "只读邮件检索",
    description:
      "本轮 Gmail 仅提供只读能力：搜索和读取邮件。不会发送、删除或修改你的邮件。",
    readOnly: true,
    readOnlyNotice: "Gmail 本轮只读：不会发送、删除或修改你的邮件。",
    permissions: ["搜索邮件", "读取邮件内容与附件元信息"],
  },
  {
    id: "outlook",
    name: "Outlook",
    icon: outlookIcon,
    tagline: "只读邮件检索",
    description:
      "本轮 Outlook 仅提供只读能力：搜索和读取邮件。不会发送、删除或修改你的邮件。",
    readOnly: true,
    readOnlyNotice: "Outlook 本轮只读：不会发送、删除或修改你的邮件。",
    permissions: ["搜索邮件", "读取邮件正文与发件人"],
  },
  {
    id: "linear",
    name: "Linear",
    icon: linearIcon,
    tagline: "只读 Issue",
    description:
      "本轮 Linear 仅提供只读能力：浏览团队与 Issue。不会创建、修改或删除 Issue。",
    readOnly: true,
    readOnlyNotice: "Linear 本轮只读：不会创建、修改或删除 Issue。",
    permissions: ["读取团队与 Issue", "按关键字搜索 Issue"],
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
    readOnly: meta.readOnly,
    connectedAt: null,
    lastError: null,
  };
}

/** 只展示 GitHub / Gmail；未知 id 忽略，缺失的用占位状态补齐。 */
export function mergeCatalog(connectors: Connector[]): Connector[] {
  return CONNECTOR_CATALOG.map((meta) => {
    const remote = connectors.find((connector) => connector.id === meta.id);
    if (!remote) return disconnectedConnector(meta);
    return {
      ...disconnectedConnector(meta),
      ...remote,
      name: remote.name || meta.name,
      description: remote.description || meta.description,
      readOnly: meta.readOnly || remote.readOnly,
      scopes: Array.isArray(remote.scopes) ? remote.scopes : [],
      account: remote.account ?? null,
    };
  });
}
