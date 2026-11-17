// Cloudflare 免费版 Worker 单请求 CPU 时间约 10ms，
// 迭代次数取一个在安全性与 CPU 预算之间平衡的值，并写入哈希串方便未来升级。
const ITERATIONS = 20000;
const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, saltHex, hashHex] = stored.split("$");
  if (scheme !== "pbkdf2" || !iter || !saltHex || !hashHex) return false;
  const hash = await derive(password, fromHex(saltHex), Number(iter));
  const expected = fromHex(hashHex);
  if (hash.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash[i] ^ expected[i];
  return diff === 0;
}

export function randomToken(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

const PASSWORD_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PASSWORD_LOWER = "abcdefghjkmnpqrstuvwxyz";
const PASSWORD_DIGITS = "23456789";
const PASSWORD_SPECIAL = "!@#$%^&*";
const PASSWORD_ALL = PASSWORD_UPPER + PASSWORD_LOWER + PASSWORD_DIGITS + PASSWORD_SPECIAL;

/** 生成指定长度的随机密码，保证包含大写、小写、数字和特殊符号 */
export function randomPassword(length = 22): string {
  const random = crypto.getRandomValues(new Uint32Array(length * 3 + 4));
  let cursor = 0;
  const pick = (chars: string) => chars[random[cursor++] % chars.length];

  const chars = [pick(PASSWORD_UPPER), pick(PASSWORD_LOWER), pick(PASSWORD_DIGITS), pick(PASSWORD_SPECIAL)];
  while (chars.length < length) chars.push(pick(PASSWORD_ALL));
  // Fisher-Yates 打乱，避免固定字符总是出现在前几位
  for (let i = chars.length - 1; i > 0; i--) {
    const j = (random[cursor++] ?? random[0]) % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export async function sha256(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}
