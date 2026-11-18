import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "./schema";
import {
  connectConnector,
  connectorErrorText,
  createConnector,
  deleteConnector,
  listConnectors,
  mapConnectorList,
} from "./connectors";
import { configureApi } from "./client";
import { ApiError } from "./errors";

type ConnectorListResponse = components["schemas"]["ConnectorListResponse"];
type ConnectorConnection = components["schemas"]["ConnectorConnection"];

const provider = (
  name: "github" | "gmail",
  scopes: string[],
): components["schemas"]["ConnectorDefinition"] => ({
  provider: name,
  displayName: name === "github" ? "GitHub" : "Gmail",
  transport: "oauth",
  defaultScopes: scopes,
  tools: [`${name}.read`],
});

function connection(
  overrides: Partial<ConnectorConnection> & Pick<ConnectorConnection, "provider">,
): ConnectorConnection {
  return {
    id: `conn_${overrides.provider}`,
    slug: overrides.provider,
    status: "pending",
    accountLabel: null,
    scopes: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastErrorCode: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  configureApi({ baseUrl: "https://aster.test", token: "token" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mapConnectorList", () => {
  it("connected / pending / error / 无 connection 映射到两张卡片", () => {
    const response: ConnectorListResponse = {
      providers: [
        provider("github", ["repo"]),
        provider("gmail", ["gmail.readonly"]),
      ],
      connections: [
        connection({
          provider: "github",
          status: "connected",
          accountLabel: "octocat",
          scopes: ["repo"],
        }),
        connection({
          provider: "gmail",
          status: "pending",
        }),
      ],
    };

    const mapped = mapConnectorList(response);
    expect(mapped.map((item) => item.id)).toEqual(["github", "gmail"]);
    expect(mapped[0]).toMatchObject({
      status: "connected",
      account: { id: "octocat", label: "octocat" },
      scopes: ["repo"],
      readOnly: false,
    });
    expect(mapped[1]).toMatchObject({
      status: "pending",
      account: null,
      scopes: [],
      readOnly: true,
    });
  });

  it("没有 connection 时是未连接，lastErrorCode 使用安全中文文案", () => {
    const mapped = mapConnectorList({
      providers: [provider("github", ["repo"])],
      connections: [
        connection({
          provider: "gmail",
          status: "error",
          lastErrorCode: "CONNECTOR_OAUTH_STATE_INVALID",
        }),
      ],
    });

    expect(mapped[0]).toMatchObject({ id: "github", status: "disconnected" });
    expect(mapped[1]).toMatchObject({ id: "gmail", status: "error" });
    expect(mapped[1]!.lastError).toBe("授权已过期，请重试");
  });

  it("revoked 按未连接处理，mcp_stdio 不展示", () => {
    const mapped = mapConnectorList({
      providers: [
        provider("github", []),
        provider("gmail", []),
        {
          provider: "mcp_stdio",
          displayName: "Local",
          transport: "stdio",
          defaultScopes: [],
          tools: [],
        },
      ],
      connections: [
        connection({ provider: "github", status: "revoked" }),
      ],
    });

    expect(mapped).toHaveLength(2);
    expect(mapped[0]!.status).toBe("disconnected");
    expect(mapped[1]!.status).toBe("disconnected");
  });
});

describe("listConnectors", () => {
  it("解析 providers + connections 并保留 mock 标记", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          providers: [provider("github", ["repo"]), provider("gmail", [])],
          connections: [
            connection({
              provider: "github",
              status: "connected",
              accountLabel: "octocat",
            }),
          ],
          mock: true,
        }),
      ),
    );

    const result = await listConnectors();
    expect(result.mock).toBe(true);
    expect(result.connectors[0]!.status).toBe("connected");
    expect(result.connectors[1]!.status).toBe("disconnected");
  });

  it("503 CONNECTORS_DISABLED 抛出服务端安全错误，页面可显示未启用", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "CONNECTORS_DISABLED",
              message: "Connectors are disabled",
            },
          },
          503,
        ),
      ),
    );

    await expect(listConnectors()).rejects.toMatchObject({
      code: "CONNECTORS_DISABLED",
      status: 503,
    });
    expect(connectorErrorText("CONNECTORS_DISABLED")).toBe(
      "服务器未启用连接器",
    );
  });
});

describe("connectConnector", () => {
  it("先 create 再 oauth/start，并把 url 交给浏览器 opener", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            connection: connection({ provider: "github" }),
            created: true,
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ url: "https://github.com/login/oauth/authorize?state=x" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const opener = vi.fn(async () => {});

    await expect(connectConnector("github", opener)).resolves.toEqual({
      status: "pending",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [createUrl, createInit] = fetchMock.mock.calls[0]!;
    expect(String(createUrl)).toBe("https://aster.test/api/v1/connectors");
    expect(createInit).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(createInit.body))).toEqual({
      provider: "github",
      slug: "github",
    });

    const [startUrl, startInit] = fetchMock.mock.calls[1]!;
    expect(String(startUrl)).toBe(
      "https://aster.test/api/v1/connectors/github/oauth/start",
    );
    expect(startInit).toMatchObject({ method: "POST" });
    expect(opener).toHaveBeenCalledWith(
      "https://github.com/login/oauth/authorize?state=x",
    );
  });

  it("create 幂等（created:false）仍继续 oauth/start", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          connection: connection({ provider: "gmail" }),
          created: false,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ url: "https://accounts.google.com/o/oauth2" }));
    vi.stubGlobal("fetch", fetchMock);
    const opener = vi.fn(async () => {});

    await connectConnector("gmail", opener);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(opener).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2");
  });

  it("create 409 时不再启动 OAuth，也不打开浏览器", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "CONNECTOR_NOT_CONFIGURED",
              message: "OAuth client is not configured",
            },
          },
          409,
        ),
      ),
    );
    const opener = vi.fn(async () => {});

    await expect(connectConnector("github", opener)).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(opener).not.toHaveBeenCalled();
    expect(connectorErrorText("CONNECTOR_NOT_CONFIGURED")).toBe(
      "服务器未配置 OAuth 凭据",
    );
    expect(connectorErrorText("CONNECTOR_SECRET_MISSING")).toBe(
      "服务器未配置 OAuth 凭据",
    );
    expect(connectorErrorText("CONNECTOR_OAUTH_STATE_INVALID")).toBe(
      "授权已过期，请重试",
    );
  });
});

describe("createConnector / deleteConnector", () => {
  it("create 发送 provider+slug；delete 使用 DELETE", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { connection: connection({ provider: "github" }), created: true },
          201,
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await createConnector("github");
    await deleteConnector("github");

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://aster.test/api/v1/connectors",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual({
      provider: "github",
      slug: "github",
    });
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      "https://aster.test/api/v1/connectors/github",
    );
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: "DELETE" });
  });
});
