/** Listing a folder that may not exist yet, without hiding any other reason it can't be read. */
import { readdir } from "node:fs/promises";

export type FolderListing =
  | { readonly kind: "listed"; readonly names: readonly string[] }
  | { readonly kind: "unreadable"; readonly problem: string };

/** A missing folder lists nothing; any other failure, such as no permission, is reported as a problem. */
export async function listFolder(folder: string): Promise<FolderListing> {
  try {
    return { kind: "listed", names: await readdir(folder) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "listed", names: [] };
    return {
      kind: "unreadable",
      problem: `${folder} can't be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
