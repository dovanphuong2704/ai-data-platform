import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY not configured');
  // Derive a 32-byte key from the env var (supports any length input)
  return crypto.createHash('sha256').update(key).digest();
}

/**
 * Encrypts plaintext using AES-256-GCM.
 * Returns: base64(iv:authTag:ciphertext)
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: base64(iv|authTag|ciphertext)
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/**
 * Decrypts ciphertext produced by encrypt().
 * Parses: base64(iv:authTag:ciphertext) and verifies authTag.
 */
export function decrypt(ciphertext: string): string {
  const key = getKey();
  const raw = Buffer.from(ciphertext, 'base64');
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}
