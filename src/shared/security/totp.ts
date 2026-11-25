import { createHmac, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31]!;
  }

  return output;
}

export function decodeBase32(secret: string): Buffer {
  const cleaned = secret.trim().toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]!);
    if (idx === -1) {
      throw new Error('Invalid Base32 character');
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

export function deriveUserTotpSecret(
  masterSecret: string,
  userId: string,
  passwordHash: string,
): string {
  const digest = createHmac('sha256', masterSecret)
    .update(`antiliso:totp:v1:${userId}:${passwordHash.slice(0, 24)}`)
    .digest()
    .subarray(0, 20);

  return encodeBase32(digest);
}

export function buildOtpAuthUri(email: string, base32Secret: string, issuer = 'AntiLiso'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`;
  return `otpauth://totp/${label}?secret=${base32Secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

export function generateTotpCode(base32Secret: string, timestampMs = Date.now()): string {
  const key = decodeBase32(base32Secret);
  const counter = Math.floor(timestampMs / (TOTP_STEP_SECONDS * 1000));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter), 0);

  const hmac = createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  const otp = binary % 10 ** TOTP_DIGITS;
  return String(otp).padStart(TOTP_DIGITS, '0');
}

export function verifyTotpCode(
  base32Secret: string,
  candidateCode: string,
  timestampMs = Date.now(),
  windowSteps = 1,
): boolean {
  const normalized = candidateCode.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) {
    return false;
  }

  const candidateBuffer = Buffer.from(normalized, 'utf8');
  let matched = false;

  for (let step = -windowSteps; step <= windowSteps; step++) {
    const stepTime = timestampMs + step * TOTP_STEP_SECONDS * 1000;
    const expected = generateTotpCode(base32Secret, stepTime);
    const expectedBuffer = Buffer.from(expected, 'utf8');
    if (
      expectedBuffer.length === candidateBuffer.length &&
      timingSafeEqual(expectedBuffer, candidateBuffer)
    ) {
      matched = true;
    }
  }

  return matched;
}
