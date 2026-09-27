import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";

const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

async function coinbase(apiKeyId: string, apiKeySecret: string): Promise<FacilitatorClient> {
  const { generateJwt } = await import("@coinbase/cdp-sdk/auth");
  const { host, pathname } = new URL(CDP_FACILITATOR_URL);
  const headers = async (path: string, requestMethod: string) => ({
    Authorization: `Bearer ${await generateJwt({ apiKeyId, apiKeySecret, requestMethod, requestHost: host, requestPath: `${pathname}${path}` })}`,
  });
  return new HTTPFacilitatorClient({
    url: CDP_FACILITATOR_URL,
    createAuthHeaders: async () => {
      const [verify, settle, supported] = await Promise.all([headers("/verify", "POST"), headers("/settle", "POST"), headers("/supported", "GET")]);
      return { verify, settle, supported };
    },
  });
}

export async function createFacilitator(setting: string, env: NodeJS.ProcessEnv = process.env): Promise<FacilitatorClient> {
  if (setting === "coinbase") {
    const apiKeyId = env.CDP_API_KEY_ID?.trim();
    const apiKeySecret = env.CDP_API_KEY_SECRET?.trim();
    if (!apiKeyId || !apiKeySecret) throw new Error('facilitator "coinbase" needs CDP_API_KEY_ID and CDP_API_KEY_SECRET');
    return coinbase(apiKeyId, apiKeySecret);
  }
  if (!/^https:\/\/[^\s]+$/.test(setting)) throw new Error('facilitator must be "coinbase" or an https URL');
  return new HTTPFacilitatorClient({ url: setting });
}
