/**
 * Computes browser-owned fingerprints without exposing canonical captions on the wire.
 */
export class ServerTranscriptIdentity {
    /**
     * Produces the exact lowercase SHA-256 used for local cache identity.
     *
     * @param bytes - Canonical transcript tuple bytes.
     * @returns Lowercase SHA-256 hexadecimal digest.
     */
    static async sha256Hex(bytes: Uint8Array): Promise<string> {
        const ownedBytes = new Uint8Array(bytes.byteLength);
        ownedBytes.set(bytes);
        const digest = await crypto.subtle.digest('SHA-256', ownedBytes.buffer);
        return Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, '0'),
        ).join('');
    }
}
