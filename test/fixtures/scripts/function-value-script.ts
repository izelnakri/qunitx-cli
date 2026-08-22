// A file that is both runnable and importable: the default export is an entry point, not data.
// Running it is an ordinary green run — there is simply no value to hand back.
export default function main(): string {
  return 'callable, and therefore not JSON';
}

console.log('ran as a script');
