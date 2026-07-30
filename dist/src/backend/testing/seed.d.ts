import { FileSystemService } from "../../filesystem.js";
import { RestClient } from "../rest/client.js";
import type { Fixture } from "./fixture-server.js";
/**
 * One vault, seeded twice: once on disk and once inside the REST fixture.
 *
 * The contract suite runs literally identical assertions against both backends,
 * which is only possible if both start from the same contents. Everything
 * arm-specific — where a write lands, how to read it back — is confined to
 * `SeededVault.filesystemState` / `SeededVault.restState`.
 *
 * Never import this from a production path.
 */
export interface VaultState {
    /** File contents, or `undefined` when the file does not exist. */
    read(path: string): Promise<string | undefined>;
    exists(path: string): Promise<boolean>;
}
export interface SeededVault {
    /** Canonical (realpath'd) vault root, matching what both backends resolve to. */
    vaultPath: string;
    fileSystem: FileSystemService;
    client: RestClient;
    fixture: Fixture;
    filesystemState: VaultState;
    restState: VaultState;
    cleanup(): Promise<void>;
}
export declare function seedBoth(files: Record<string, string>): Promise<SeededVault>;
//# sourceMappingURL=seed.d.ts.map