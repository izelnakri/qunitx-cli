/** Recursively lists files under `folderPath`, optionally filtered by a predicate. */
declare function recursiveLookup(
  folderPath: string,
  filter?: (name: string) => boolean,
): Promise<string[]>;

export default recursiveLookup;
