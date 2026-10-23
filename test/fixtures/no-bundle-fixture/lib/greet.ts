// @ts-expect-error — mapped by this fixture's import-map.json, which `deno check` does not read.
import { shout } from 'shout';

export function greet(name: string): string {
  return shout(`hello ${name}`);
}
