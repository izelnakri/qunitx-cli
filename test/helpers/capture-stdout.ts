/**
 * Intercepts process.stdout.write for the duration of fn() and returns all written strings.
 * Use this in unit tests to assert on what a function prints without spawning a subprocess.
 */
export function captureStdout(fn: () => void): string {
  let captured = '';
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (str: string) => {
    captured += str;
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return captured;
}
