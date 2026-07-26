import { createHash } from 'node:crypto';

/**
 * Keeps authoritative transcript hashing in the Node-owned backend boundary.
 */
export class TranscriptFingerprint {
    /**
     * Produces the lowercase digest used by exact cache and job identity.
     *
     * @param bytes - Canonical transcript tuple bytes.
     * @returns Lowercase SHA-256 hexadecimal digest.
     */
    static sha256Hex(bytes: Uint8Array): string {
        return createHash('sha256').update(bytes).digest('hex');
    }
}
