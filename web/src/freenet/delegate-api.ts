/**
 * Identity / repo-owner delegate messaging (microblogging pattern).
 */
import {
  FreenetWsApi,
  DelegateRequest,
  DelegateResponse,
} from "@freenetorg/freenet-stdlib";

export async function sendDelegateMessage(
  api: FreenetWsApi,
  delegateKeyBytes: number[],
  delegateCodeHash: number[],
  message: object,
): Promise<void> {
  const payload = Array.from(new TextEncoder().encode(JSON.stringify(message)));

  const { ApplicationMessageT } = await import("@freenetorg/freenet-stdlib/common");
  const clientReqModule = await import("@freenetorg/freenet-stdlib/client-request");
  const {
    ClientRequestT,
    ClientRequestType,
    ApplicationMessagesT,
    DelegateKeyT,
    DelegateRequestType,
    InboundDelegateMsgT,
    InboundDelegateMsgType,
  } = clientReqModule;

  const appMsg = new ApplicationMessageT(payload, [], false);
  const inbound = new InboundDelegateMsgT(
    InboundDelegateMsgType.common_ApplicationMessage,
    appMsg,
  );
  const delegateKey = new DelegateKeyT(delegateKeyBytes, delegateCodeHash);
  const appMessages = new ApplicationMessagesT(delegateKey, [], [inbound]);
  const delegateReq = new DelegateRequest(
    DelegateRequestType.ApplicationMessages,
    appMessages,
  );
  const clientReq = new ClientRequestT(
    ClientRequestType.DelegateRequest,
    delegateReq,
  );
  (api as unknown as { sendRequest: (r: unknown) => void }).sendRequest(
    clientReq,
  );
}

export function parseDelegateResponse(response: DelegateResponse): object[] {
  const results: object[] = [];
  if (!response.values) return results;
  for (const outbound of response.values) {
    if (outbound.inboundType !== 1) continue;
    const msg = outbound.inbound as { payload?: number[] } | null;
    if (!msg?.payload?.length) continue;
    try {
      const bytes = new Uint8Array(msg.payload);
      const json = new TextDecoder().decode(bytes);
      results.push(JSON.parse(json) as object);
    } catch (e) {
      console.warn("[forge-delegate] Failed to parse payload:", e);
    }
  }
  return results;
}
