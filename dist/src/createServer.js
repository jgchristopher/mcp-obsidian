import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { FileSystemBackend } from "./backend/filesystem/index.js";
import { Health } from "./backend/health.js";
import { ObsidianLiveService } from "./backend/live.js";
import { createPeriodicNote } from "./backend/periodic/create.js";
import { loadRecentPeriodicNotes, PERIODS } from "./backend/periodic/resolve.js";
import { RestBackend } from "./backend/rest/index.js";
import { RestClient } from "./backend/rest/client.js";
import { resolveRestConfig } from "./backend/rest/config.js";
import { RoutingBackend } from "./backend/routing.js";
import { clamp, FileSystemService, RECENT_CHANGES_DEFAULT_DAYS, RECENT_CHANGES_DEFAULT_LIMIT, RECENT_CHANGES_MAX_LIMIT, } from "./filesystem.js";
import { FrontmatterHandler, parseFrontmatter } from "./frontmatter.js";
import { PathFilter } from "./pathfilter.js";
import { SearchService } from "./search.js";
import { handleWikiLinkTool } from "./wikilink/index.js";
import { resolve } from "path";
export function createServer(vaultPath, options = {}) {
    const { name = "mcpvault", version = "0.0.0", pathFilter = new PathFilter(), frontmatterHandler = new FrontmatterHandler(), onWarn = (message) => console.error(message), env = process.env, } = options;
    const resolvedVaultPath = resolve(vaultPath);
    // `fileSystem` still serves get_vault_stats and wiki_link directly. Do not remove it.
    const fileSystem = new FileSystemService(resolvedVaultPath, pathFilter, frontmatterHandler);
    const searchService = new SearchService(resolvedVaultPath, pathFilter);
    /**
     * With `OBSIDIAN_API_KEY` unset, `resolveRestConfig()` returns `null` and no
     * client, agent, or request exists — byte-identical to the pre-REST
     * construction. That is what keeps behavior unchanged when REST is off.
     */
    const restConfig = resolveRestConfig(env);
    const restClient = restConfig ? new RestClient(restConfig) : null;
    const backend = options.backend ?? buildBackend();
    /**
     * Deliberately outside the backend seam and constructed even when
     * `restClient` is `null`: the five REST-only tools stay registered and each
     * raises `ObsidianUnavailableError`, which is more discoverable than a tool
     * that silently disappears from `ListTools`.
     */
    const live = new ObsidianLiveService(restClient, { pathFilter });
    function buildBackend() {
        if (!restClient)
            return new FileSystemBackend(fileSystem);
        return new RoutingBackend(new RestBackend(restClient, { vaultPath: resolvedVaultPath, pathFilter, frontmatterHandler }), new FileSystemBackend(fileSystem), new Health(restClient, resolvedVaultPath, { onWarn }));
    }
    const server = new Server({ name, version }, {
        capabilities: { tools: {} },
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: "read_note",
                    description: "Read a note from the Obsidian vault",
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "Path to the note relative to vault root" },
                            prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
                        },
                        required: ["path"]
                    }
                },
                {
                    name: "write_note",
                    description: "Write a note to the Obsidian vault",
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "Path to the note relative to vault root" },
                            content: { type: "string", description: "Content of the note" },
                            frontmatter: { type: "object", description: "Frontmatter object (optional)" },
                            mode: { type: "string", enum: ["overwrite", "append", "prepend"], description: "Write mode: 'overwrite' (default), 'append', or 'prepend'", default: "overwrite" }
                        },
                        required: ["path", "content"]
                    }
                },
                {
                    name: "patch_note",
                    description: "Efficiently update part of a note by replacing a specific string. This is more efficient than rewriting the entire note for small changes.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "Path to the note relative to vault root" },
                            oldString: { type: "string", description: "The exact string to replace. Must match exactly including whitespace and line breaks." },
                            newString: { type: "string", description: "The new string to insert in place of oldString" },
                            replaceAll: { type: "boolean", description: "If true, replace all occurrences. If false (default), the operation will fail if multiple matches are found to prevent unintended replacements.", default: false }
                        },
                        required: ["path", "oldString", "newString"]
                    }
                },
                {
                    name: "list_directory",
                    description: "List files and directories in the vault (includes non-note filenames, while read/write tools remain note-only)",
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "Path relative to vault root (default: '/')", default: "/" },
                            prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
                        }
                    }
                },
                {
                    name: "delete_note",
                    description: "Delete a note from the Obsidian vault (requires confirmation). Supports permanent delete, vault trash, or system trash.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "Path to the note relative to vault root" },
                            confirmPath: { type: "string", description: "Confirmation: must exactly match the path parameter to proceed with deletion" },
                            trashMode: { type: "string", enum: ["none", "local", "system"], description: "Deletion mode: 'none' = permanent delete (default), 'local' = move to .trash inside vault, 'system' = move to OS trash", default: "none" }
                        },
                        required: ["path", "confirmPath"]
                    }
                },
                {
                    name: "search_notes",
                    description: "Search for notes in the vault by content or frontmatter",
                    inputSchema: {
                        type: "object",
                        properties: {
                            query: { type: "string", description: "Search query text" },
                            limit: { type: "number", description: "Maximum number of results (default: 5, max: 20)", default: 5 },
                            searchContent: { type: "boolean", description: "Search in note content (default: true)", default: true },
                            searchFrontmatter: { type: "boolean", description: "Search in frontmatter (default: false)", default: false },
                            caseSensitive: { type: "boolean", description: "Case sensitive search (default: false)", default: false },
                            pathPrefix: { type: "string", description: "Restrict the search to a vault subtree, e.g. \"Projects/2026\" (directory prefix)" },
                            excludePaths: { type: "array", items: { type: "string" }, description: "Skip files under these subtrees, e.g. [\"Archive\", \"meta\"] (directory prefixes)" },
                            prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
                        },
                        required: ["query"]
                    }
                },
                {
                    name: "move_note",
                    description: "Move or rename a note in the vault",
                    inputSchema: {
                        type: "object",
                        properties: {
                            oldPath: { type: "string", description: "Current path of the note" },
                            newPath: { type: "string", description: "New path for the note" },
                            overwrite: { type: "boolean", description: "Allow overwriting existing file (default: false)", default: false }
                        },
                        required: ["oldPath", "newPath"]
                    }
                },
                {
                    name: "move_file",
                    description: "Move or rename any file in the vault (binary-safe, file-only, requires confirmation)",
                    inputSchema: {
                        type: "object",
                        properties: {
                            oldPath: { type: "string", description: "Current path of the file" },
                            newPath: { type: "string", description: "New path for the file" },
                            confirmOldPath: { type: "string", description: "Confirmation: must exactly match oldPath" },
                            confirmNewPath: { type: "string", description: "Confirmation: must exactly match newPath" },
                            overwrite: { type: "boolean", description: "Allow overwriting existing file (default: false)", default: false }
                        },
                        required: ["oldPath", "newPath", "confirmOldPath", "confirmNewPath"]
                    }
                },
                {
                    name: "read_multiple_notes",
                    description: "Read multiple notes in a batch (max 10 files)",
                    inputSchema: {
                        type: "object",
                        properties: {
                            paths: { type: "array", items: { type: "string" }, description: "Array of note paths to read", maxItems: 10 },
                            includeContent: { type: "boolean", description: "Include note content (default: true)", default: true },
                            includeFrontmatter: { type: "boolean", description: "Include frontmatter (default: true)", default: true },
                            prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
                        },
                        required: ["paths"]
                    }
                },
                {
                    name: "update_frontmatter",
                    description: "Update frontmatter of a note without changing content",
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "Path to the note" },
                            frontmatter: { type: "object", description: "Frontmatter object to update" },
                            merge: { type: "boolean", description: "Merge with existing frontmatter (default: true)", default: true }
                        },
                        required: ["path", "frontmatter"]
                    }
                },
                {
                    name: "get_notes_info",
                    description: "Get metadata for notes without reading full content",
                    inputSchema: {
                        type: "object",
                        properties: {
                            paths: { type: "array", items: { type: "string" }, description: "Array of note paths to get info for" },
                            prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
                        },
                        required: ["paths"]
                    }
                },
                {
                    name: "get_frontmatter",
                    description: "Extract frontmatter from a note without reading the content",
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "Path to the note relative to vault root" },
                            prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
                        },
                        required: ["path"]
                    }
                },
                {
                    name: "manage_tags",
                    description: "Add, remove, or list tags in a note",
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "Path to the note relative to vault root" },
                            operation: { type: "string", enum: ["add", "remove", "list"], description: "Operation to perform: 'add', 'remove', or 'list'" },
                            tags: { type: "array", items: { type: "string" }, description: "Array of tags (required for 'add' and 'remove' operations)" }
                        },
                        required: ["path", "operation"]
                    }
                },
                {
                    name: "get_vault_stats",
                    description: "Get vault statistics including total notes, folders, size, and recently modified files. Useful for understanding vault scope before batch operations.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            recentCount: { type: "number", description: "Number of recently modified files to return (default: 5, max: 20)", default: 5 },
                            prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
                        }
                    }
                },
                {
                    name: "list_all_tags",
                    description: "List all tags across the vault with occurrence counts. Returns both frontmatter tags and inline #hashtags, deduplicated and sorted by frequency. Useful for discovering existing tags before creating or organizing notes.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
                        }
                    }
                },
                {
                    name: "wiki_link",
                    description: "Read an Obsidian wiki link. Accepts the same syntax as Obsidian: [[Document Name]] or [[Document Name|Display Text]], including table-authored escapes like [[Document Name\\|Display]] and path-qualified links like [[folder/Document Name]]. A #fragment suffix in the input is ignored. Searches the vault for an exact basename match (or exact vault-relative path match when the name contains '/') and returns the file's content. When multiple files share the basename, picks the first (vault root first, then alphabetical by path) and lists the other paths in structuredContent.alternatives. Content is returned bare — ready for direct use in context.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            document: {
                                type: "string",
                                description: "The document name — what goes inside [[ ]]. e.g. 'My-Document'. Brackets and display text (|...) are stripped if present. The .md extension is always appended (never include it)."
                            },
                            prettyPrint: {
                                type: "boolean",
                                description: "Format JSON response with indentation (default: false)",
                                default: false
                            }
                        },
                        required: ["document"]
                    }
                },
                {
                    name: "get_periodic_note",
                    description: "Resolve a periodic note from Obsidian's own daily-notes settings and read it. Works with Obsidian closed. Only 'daily' resolves today; the other periods need the 'periodic-notes' community plugin and return an explanatory error. If the resolved note does not exist, the path is still returned with exists=false so it can be created.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            period: { type: "string", enum: [...PERIODS], description: "Which period to resolve (default: 'daily')", default: "daily" },
                            date: { type: "string", description: "Target date as YYYY-MM-DD. Defaults to today in the server's local timezone." },
                            prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
                        }
                    }
                },
                {
                    name: "create_periodic_note",
                    description: "Create today's daily note the way Obsidian would, and return it. Idempotent: an existing note is returned untouched, so a skill that runs twice a day never clobbers the earlier run. With Obsidian running, it triggers Obsidian's own 'daily-notes' command, so the vault's full template pipeline applies (including Templater) and the note opens in the UI. With Obsidian closed, it renders the configured template here, filling only the core {{date}}, {{time}} and {{title}} tokens and reporting anything it could not render in 'unrendered'. Only 'daily' is supported. A date other than today always uses the template path, because Obsidian's command only creates today's note.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            period: { type: "string", enum: [...PERIODS], description: "Which period to create (default: 'daily')", default: "daily" },
                            date: { type: "string", description: "Target date as YYYY-MM-DD. Defaults to today in the server's local timezone." },
                            prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
                        }
                    }
                },
                {
                    name: "get_document_map",
                    description: "Outline a note: heading hierarchy (paths joined with '::', matching the structural PATCH target format), block reference ids, and frontmatter keys. Headings inside fenced code blocks are ignored. Useful for locating a section before patching without reading the whole note.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "Path to the note relative to vault root" },
                            prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
                        },
                        required: ["path"]
                    }
                },
                {
                    name: "get_recent_changes",
                    description: "List vault files modified most recently, newest first. Filesystem-based, so it needs no Obsidian plugin and works with Obsidian closed.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            limit: { type: "number", description: "Maximum number of files to return (default: 10, max: 100)", default: 10 },
                            days: { type: "number", description: "Only include files modified within this many days (default: 90)", default: 90 },
                            prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
                        }
                    }
                },
                {
                    name: "get_recent_periodic_notes",
                    description: "Read the most recent periodic notes that exist, newest first. Dates with no note are skipped. Filesystem-based; works with Obsidian closed.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            period: { type: "string", enum: [...PERIODS], description: "Which period to walk back through (default: 'daily')", default: "daily" },
                            limit: { type: "number", description: "How many periods back to look (default: 5, max: 30)", default: 5 },
                            includeContent: { type: "boolean", description: "Include note content (default: true)", default: true },
                            prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
                        }
                    }
                },
                {
                    name: "list_commands",
                    description: "List every command registered in the running Obsidian, its own and every plugin's. Requires Obsidian to be running with the Local REST API plugin; fails with a clear error otherwise.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
                        }
                    }
                },
                {
                    name: "execute_command",
                    description: "Run a command in the running Obsidian by its id. CONSEQUENTIAL: the id space covers every installed plugin, so a command can modify the vault, change settings, or alter the UI, with no confirmation and no undo. Call list_commands first and only run a command whose effect you are sure of. Requires Obsidian to be running with the Local REST API plugin.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            commandId: { type: "string", description: "Command id from list_commands, e.g. 'app:open-vault'" }
                        },
                        required: ["commandId"]
                    }
                },
                {
                    name: "get_active_file",
                    description: "Get the vault path of the note currently focused in Obsidian. Requires Obsidian to be running with the Local REST API plugin.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
                        }
                    }
                },
                {
                    name: "open_file",
                    description: "Open a note in the Obsidian UI. Does not return content — use read_note for that. Requires Obsidian to be running with the Local REST API plugin.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "Path to the note relative to vault root" }
                        },
                        required: ["path"]
                    }
                },
                {
                    name: "search_vault_advanced",
                    description: "Query Obsidian's own index with a JsonLogic expression (see jsonlogic.com). Dataview DQL is NOT supported. Requires Obsidian to be running with the Local REST API plugin. For plain text search that works with Obsidian closed, use search_notes.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            query: { type: "object", description: "JsonLogic query object, e.g. {\"glob\": [\"*.md\", {\"var\": \"path\"}]}" },
                            prettyPrint: { type: "boolean", description: "Format JSON response with indentation (default: false)", default: false }
                        },
                        required: ["query"]
                    }
                }
            ]
        };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name: toolName, arguments: args } = request.params;
        const trimmedArgs = trimPaths(args);
        try {
            switch (toolName) {
                case "read_note": {
                    const note = await backend.readNote(trimmedArgs.path);
                    const indent = trimmedArgs.prettyPrint ? 2 : undefined;
                    return {
                        content: [{ type: "text", text: JSON.stringify({ fm: note.frontmatter, content: note.content }, null, indent) }]
                    };
                }
                case "write_note": {
                    const fm = parseFrontmatter(trimmedArgs.frontmatter);
                    await backend.writeNote({
                        path: trimmedArgs.path,
                        content: trimmedArgs.content,
                        ...(fm !== undefined && { frontmatter: fm }),
                        mode: trimmedArgs.mode || 'overwrite'
                    });
                    return {
                        content: [{ type: "text", text: `Successfully wrote note: ${trimmedArgs.path} (mode: ${trimmedArgs.mode || 'overwrite'})` }]
                    };
                }
                case "patch_note": {
                    const result = await backend.patchNote({
                        path: trimmedArgs.path,
                        oldString: trimmedArgs.oldString,
                        newString: trimmedArgs.newString,
                        replaceAll: trimmedArgs.replaceAll
                    });
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        isError: !result.success
                    };
                }
                case "list_directory": {
                    const listing = await backend.listDirectory(trimmedArgs.path || '');
                    const indent = trimmedArgs.prettyPrint ? 2 : undefined;
                    return {
                        content: [{ type: "text", text: JSON.stringify({ dirs: listing.directories, files: listing.files }, null, indent) }]
                    };
                }
                case "delete_note": {
                    const result = await backend.deleteNote({
                        path: trimmedArgs.path,
                        confirmPath: trimmedArgs.confirmPath,
                        trashMode: trimmedArgs.trashMode
                    });
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        isError: !result.success
                    };
                }
                case "search_notes": {
                    const results = await searchService.search({
                        query: trimmedArgs.query,
                        limit: trimmedArgs.limit,
                        searchContent: trimmedArgs.searchContent,
                        searchFrontmatter: trimmedArgs.searchFrontmatter,
                        caseSensitive: trimmedArgs.caseSensitive,
                        pathPrefix: trimmedArgs.pathPrefix,
                        excludePaths: trimmedArgs.excludePaths
                    });
                    const indent = trimmedArgs.prettyPrint ? 2 : undefined;
                    return {
                        content: [{ type: "text", text: JSON.stringify(results, null, indent) }]
                    };
                }
                case "move_note": {
                    const result = await backend.moveNote({
                        oldPath: trimmedArgs.oldPath,
                        newPath: trimmedArgs.newPath,
                        overwrite: trimmedArgs.overwrite
                    });
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        isError: !result.success
                    };
                }
                case "move_file": {
                    const result = await backend.moveFile({
                        oldPath: trimmedArgs.oldPath,
                        newPath: trimmedArgs.newPath,
                        confirmOldPath: trimmedArgs.confirmOldPath,
                        confirmNewPath: trimmedArgs.confirmNewPath,
                        overwrite: trimmedArgs.overwrite
                    });
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        isError: !result.success
                    };
                }
                case "read_multiple_notes": {
                    const result = await backend.readMultipleNotes({
                        paths: trimmedArgs.paths,
                        includeContent: trimmedArgs.includeContent,
                        includeFrontmatter: trimmedArgs.includeFrontmatter
                    });
                    const indent = trimmedArgs.prettyPrint ? 2 : undefined;
                    return {
                        content: [{ type: "text", text: JSON.stringify({ ok: result.successful, err: result.failed }, null, indent) }]
                    };
                }
                case "update_frontmatter": {
                    const fm = parseFrontmatter(trimmedArgs.frontmatter);
                    if (!fm) {
                        throw new Error('frontmatter is required');
                    }
                    await backend.updateFrontmatter({
                        path: trimmedArgs.path,
                        frontmatter: fm,
                        merge: trimmedArgs.merge
                    });
                    return {
                        content: [{ type: "text", text: `Successfully updated frontmatter for: ${trimmedArgs.path}` }]
                    };
                }
                case "get_notes_info": {
                    const result = await backend.getNotesInfo(trimmedArgs.paths);
                    const indent = trimmedArgs.prettyPrint ? 2 : undefined;
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, indent) }]
                    };
                }
                case "get_frontmatter": {
                    const fm = await backend.getFrontmatter(trimmedArgs.path);
                    const indent = trimmedArgs.prettyPrint ? 2 : undefined;
                    return {
                        content: [{ type: "text", text: JSON.stringify(fm, null, indent) }]
                    };
                }
                case "manage_tags": {
                    const result = await backend.manageTags({
                        path: trimmedArgs.path,
                        operation: trimmedArgs.operation,
                        tags: trimmedArgs.tags
                    });
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        isError: !result.success
                    };
                }
                case "get_vault_stats": {
                    const recentCount = Math.min(trimmedArgs.recentCount || 5, 20);
                    const stats = await fileSystem.getVaultStats(recentCount);
                    const indent = trimmedArgs.prettyPrint ? 2 : undefined;
                    return {
                        content: [{ type: "text", text: JSON.stringify({ notes: stats.totalNotes, folders: stats.totalFolders, size: stats.totalSize, recent: stats.recentlyModified }, null, indent) }]
                    };
                }
                case "list_all_tags": {
                    const tags = await backend.listAllTags();
                    const indent = trimmedArgs.prettyPrint ? 2 : undefined;
                    return {
                        content: [{ type: "text", text: JSON.stringify(tags, null, indent) }]
                    };
                }
                case "wiki_link":
                    return await handleWikiLinkTool(fileSystem, trimmedArgs);
                case "get_periodic_note": {
                    // The handler owns the clock, never the resolver: a test asserting a
                    // fixed path against an internal `new Date()` would pass once and fail
                    // every day after.
                    const result = await backend.getPeriodicNote({
                        period: parsePeriod(trimmedArgs.period),
                        date: parsePeriodDate(trimmedArgs.date)
                    });
                    const indent = trimmedArgs.prettyPrint ? 2 : undefined;
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, indent) }]
                    };
                }
                case "create_periodic_note": {
                    // Same clock rule as `get_periodic_note`: the handler owns it.
                    // `live.executeCommand` throws when Obsidian is not reachable, which
                    // is how the create falls back to rendering the template itself.
                    const result = await createPeriodicNote({
                        vaultPath: fileSystem.vaultRoot,
                        backend,
                        runCommand: (commandId) => live.executeCommand(commandId)
                    }, {
                        period: parsePeriod(trimmedArgs.period),
                        date: parsePeriodDate(trimmedArgs.date)
                    });
                    const indent = trimmedArgs.prettyPrint ? 2 : undefined;
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, indent) }]
                    };
                }
                case "get_document_map": {
                    const map = await backend.getDocumentMap(trimmedArgs.path);
                    const indent = trimmedArgs.prettyPrint ? 2 : undefined;
                    return {
                        content: [{ type: "text", text: JSON.stringify(map, null, indent) }]
                    };
                }
                case "get_recent_changes": {
                    const changes = await fileSystem.getRecentChanges({
                        limit: clamp(trimmedArgs.limit, RECENT_CHANGES_DEFAULT_LIMIT, 1, RECENT_CHANGES_MAX_LIMIT),
                        days: clamp(trimmedArgs.days, RECENT_CHANGES_DEFAULT_DAYS, 1, Number.MAX_SAFE_INTEGER)
                    });
                    const indent = trimmedArgs.prettyPrint ? 2 : undefined;
                    return {
                        content: [{ type: "text", text: JSON.stringify(changes, null, indent) }]
                    };
                }
                case "get_recent_periodic_notes": {
                    const limit = clamp(trimmedArgs.limit, 5, 1, 30);
                    const notes = await loadRecentPeriodicNotes(fileSystem, fileSystem.vaultRoot, parsePeriod(trimmedArgs.period), limit, new Date());
                    const includeContent = trimmedArgs.includeContent !== false;
                    const payload = includeContent
                        ? notes
                        : notes.map(({ content: _content, ...rest }) => rest);
                    const indent = trimmedArgs.prettyPrint ? 2 : undefined;
                    return {
                        content: [{ type: "text", text: JSON.stringify(payload, null, indent) }]
                    };
                }
                case "list_commands": {
                    const commands = await live.listCommands();
                    const indent = trimmedArgs.prettyPrint ? 2 : undefined;
                    return {
                        content: [{ type: "text", text: JSON.stringify(commands, null, indent) }]
                    };
                }
                case "execute_command": {
                    const result = await live.executeCommand(trimmedArgs.commandId);
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
                    };
                }
                case "get_active_file": {
                    const active = await live.getActiveFile();
                    const indent = trimmedArgs.prettyPrint ? 2 : undefined;
                    return {
                        content: [{ type: "text", text: JSON.stringify(active, null, indent) }]
                    };
                }
                case "open_file": {
                    const result = await live.openFile(trimmedArgs.path);
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
                    };
                }
                case "search_vault_advanced": {
                    const results = await live.searchVaultAdvanced(trimmedArgs.query);
                    const indent = trimmedArgs.prettyPrint ? 2 : undefined;
                    return {
                        content: [{ type: "text", text: JSON.stringify(results, null, indent) }]
                    };
                }
                default:
                    throw new Error(`Unknown tool: ${toolName}`);
            }
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
                isError: true
            };
        }
    });
    return server;
}
function parsePeriod(raw) {
    if (raw === undefined || raw === null || raw === '')
        return 'daily';
    if (typeof raw === 'string' && PERIODS.includes(raw)) {
        return raw;
    }
    throw new Error(`Invalid period: ${String(raw)}. Expected one of ${PERIODS.join(', ')}.`);
}
/**
 * `YYYY-MM-DD` in the server's local timezone, or today when omitted.
 *
 * Built with `new Date(y, m - 1, d)` rather than `new Date(string)`: the string
 * form parses as UTC midnight, which is the previous day west of Greenwich, and
 * a daily note belongs to the user's day.
 */
function parsePeriodDate(raw) {
    if (raw === undefined || raw === null || raw === '')
        return new Date();
    const match = typeof raw === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim()) : null;
    if (!match) {
        throw new Error(`Invalid date: ${String(raw)}. Use YYYY-MM-DD.`);
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    // Reject a well-formed but nonexistent date (2026-02-30) rather than letting
    // Date silently roll it forward into March.
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
        throw new Error(`Invalid date: ${String(raw)}. That calendar date does not exist.`);
    }
    return date;
}
function trimPaths(args) {
    const trimmed = { ...args };
    if (trimmed.path && typeof trimmed.path === 'string')
        trimmed.path = trimmed.path.trim();
    if (trimmed.oldPath && typeof trimmed.oldPath === 'string')
        trimmed.oldPath = trimmed.oldPath.trim();
    if (trimmed.newPath && typeof trimmed.newPath === 'string')
        trimmed.newPath = trimmed.newPath.trim();
    if (trimmed.confirmPath && typeof trimmed.confirmPath === 'string')
        trimmed.confirmPath = trimmed.confirmPath.trim();
    if (trimmed.confirmOldPath && typeof trimmed.confirmOldPath === 'string')
        trimmed.confirmOldPath = trimmed.confirmOldPath.trim();
    if (trimmed.confirmNewPath && typeof trimmed.confirmNewPath === 'string')
        trimmed.confirmNewPath = trimmed.confirmNewPath.trim();
    if (trimmed.paths && Array.isArray(trimmed.paths)) {
        trimmed.paths = trimmed.paths.map((p) => typeof p === 'string' ? p.trim() : p);
    }
    return trimmed;
}
