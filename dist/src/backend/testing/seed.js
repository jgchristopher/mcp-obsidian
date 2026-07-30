import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FileSystemService } from "../../filesystem.js";
import { FrontmatterHandler } from "../../frontmatter.js";
import { PathFilter } from "../../pathfilter.js";
import { RestClient } from "../rest/client.js";
import { startFixture } from "./fixture-server.js";
export async function seedBoth(files) {
    // `realpathSync`: on macOS a `/var/folders/...` temp dir canonicalizes to
    // `/private/var/folders/...`, and `FileSystemService` does the same in its
    // constructor. Without it every `obsidianUri` would differ between arms.
    const vaultPath = realpathSync(await mkdtemp(join(tmpdir(), "mcpvault-contract-")));
    for (const [path, content] of Object.entries(files)) {
        const full = join(vaultPath, path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content, "utf-8");
    }
    const fixture = await startFixture({ files: { ...files } });
    const client = new RestClient({
        apiKey: "contract-key",
        host: "127.0.0.1",
        port: fixture.port,
        protocol: "http",
        verifySsl: false,
    });
    const fileSystem = new FileSystemService(vaultPath, new PathFilter(), new FrontmatterHandler());
    const filesystemState = {
        async read(path) {
            try {
                return await readFile(join(vaultPath, path), "utf-8");
            }
            catch {
                return undefined;
            }
        },
        async exists(path) {
            return (await filesystemState.read(path)) !== undefined;
        },
    };
    const restState = {
        async read(path) {
            return fixture.files.get(path);
        },
        async exists(path) {
            return fixture.files.has(path);
        },
    };
    return {
        vaultPath,
        fileSystem,
        client,
        fixture,
        filesystemState,
        restState,
        cleanup: async () => {
            client.destroy();
            await fixture.close();
            await rm(vaultPath, { recursive: true, force: true });
        },
    };
}
