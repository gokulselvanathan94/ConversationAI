/**
 * User-to-User Information (RFC 7433) helpers for the SIP hand-off into
 * Genesys Cloud. The BYOC trunk must have "UUI Passthrough" enabled with
 * Type = User-to-User, Encoding = Hex, and the same 2-digit protocol
 * discriminator configured here (default 00). Genesys strips the PD and
 * decodes the rest; the payload then appears in Architect as Call.UUIData.
 *
 * Keep the payload short (best practice ≤128 chars on the wire): we send a
 * correlation token only, and Genesys fetches the full context from this
 * server's REST API via a data action.
 */

/** Encode an ASCII payload as a hex UUI header value with PD prefix. */
export function encodeUuiHex(payload: string, protocolDiscriminator = '00'): string {
  if (!/^[0-9a-f]{2}$/i.test(protocolDiscriminator)) {
    throw new Error(`invalid protocol discriminator: ${protocolDiscriminator}`);
  }
  const hex = Buffer.from(payload, 'utf8').toString('hex');
  return `${protocolDiscriminator.toLowerCase()}${hex};encoding=hex`;
}

/** Decode a hex UUI header value (with or without params/PD) back to ASCII. */
export function decodeUuiHex(headerValue: string, stripProtocolDiscriminator = true): string {
  const value = headerValue.split(';')[0].trim();
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) {
    throw new Error('UUI value is not valid hex');
  }
  const hex = stripProtocolDiscriminator ? value.slice(2) : value;
  return Buffer.from(hex, 'hex').toString('utf8');
}
