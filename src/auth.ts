import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export const MCP_SCOPE = "bridge:access";

export type OAuthConfig = {
  publicOrigin: string;
  issuer: string;
  subject: string;
  clientId: string;
};

function httpsOrigin(value: string, name: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTPS origin`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(`${name} must be an HTTPS origin`);
  }
  return url.origin;
}

export function oauthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing required configuration: ${name}`);
    return value;
  };
  return {
    publicOrigin: required("BRIDGE_PUBLIC_ORIGIN"),
    issuer: required("MCP_OAUTH_ISSUER"),
    subject: required("MCP_OAUTH_SUBJECT"),
    clientId: required("MCP_OAUTH_CLIENT_ID"),
  };
}

// The identity provider owns login, consent, PKCE, token issuance and refresh.
// This process is only the resource server. It never receives login passwords.
export function createMcpAccess(config: OAuthConfig, testKey?: JWTVerifyGetKey) {
  const resource = httpsOrigin(config.publicOrigin, "BRIDGE_PUBLIC_ORIGIN");
  const issuer = httpsOrigin(config.issuer, "MCP_OAUTH_ISSUER") + "/";
  if (!config.subject.trim() || !config.clientId.trim()) throw new Error("OAuth owner and client are required");
  const keys = testKey ?? createRemoteJWKSet(new URL(".well-known/jwks.json", issuer), {
    timeoutDuration: 5000,
    cooldownDuration: 30_000,
  });
  const challenge = `Bearer resource_metadata="${resource}/.well-known/oauth-protected-resource", scope="${MCP_SCOPE}"`;
  return {
    challenge,
    metadata: {
      resource,
      authorization_servers: [issuer],
      scopes_supported: [MCP_SCOPE],
      bearer_methods_supported: ["header"],
    },
    async verify(authorization: string | undefined): Promise<void> {
      const match = authorization?.match(/^Bearer ([A-Za-z0-9_.-]+)$/i);
      if (!match || match[1].length > 16_384) throw new Error("unauthorized");
      const { payload } = await jwtVerify(match[1], keys, {
        issuer,
        audience: resource,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "iat", "exp", "azp", "scope"],
        maxTokenAge: "1h",
        clockTolerance: 5,
      });
      if (payload.sub !== config.subject || payload.azp !== config.clientId
        || typeof payload.scope !== "string" || !payload.scope.split(" ").includes(MCP_SCOPE)
        || typeof payload.exp !== "number" || typeof payload.iat !== "number"
        || payload.exp - payload.iat > 3600) {
        throw new Error("unauthorized");
      }
    },
  };
}

export type McpAccess = ReturnType<typeof createMcpAccess>;

export function validIngestToken(configured: string, authorization?: string): boolean {
  if (configured.length < 32) return false;
  const actual = Buffer.from(authorization ?? "");
  const expected = Buffer.from(`Bearer ${configured}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
